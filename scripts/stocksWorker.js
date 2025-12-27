/**==============================================================================
 * Highs Solver Worker - Deterministic Portfolio Optimizer
 * ==============================================================================
 * Description:
 * This Web Worker implements a multi-period financial control model.
 * It treats capital and equity as flow variables within a conservation network.
 * It penalizes large swings of stock purchases and sales to maximize portfolio
 * value based on deterministic (0.5% Confidence) projections.  However, these
 * projections fail to account for this model's own disruptions on stock values.
 * An Alpha Decay (Ripple) variable is used to simulate how dispersed or abrupt
 * purchases impact projections over time.   A Heuristic Validator is used after
 * the LP simulation to remove small transactions and to finalize the solution.
 * CPLEX Formatting: http://web.mit.edu/lpsolve/doc/CPLEX-format.htm
 * @author Joel Wood
 */

// Worker State Variables
let highsModulePromise = null;
let highsModule = null;

/** Initialize Highs Module:
 *  Attempts to load the WebAssembly solver from libs/highs.js
 *  512MB is allocated as a safe compatibility buffer to avoid memory overflow.
 */
try {
    importScripts('../libs/highs.js');
    if (typeof Module === 'function') {
        highsModulePromise = Module({
            locateFile: (file) => '../libs/' + file,
            initialMemory: 512 * 1024 * 1024,
        }).then(instance => {
            highsModule = instance;
            return instance;
        });
    }
} catch (error) {
    console.error("WASM Load Error:", error);
}

/** Numeric Formatter:
 *  Converts numbers to a string format compatible with the CPLEX/LP file format.
 *  Trims excess precision to prevent the LP string from becoming unnecessarily massive.
 *  This trim of excess characters is necessary to mitigate excessive string memory usage.
 *  It also helps mitigate "Ill-Conditioned" matrices which appear when coefficients have
 *  vastly different scales.
 */
function fmt(num) {
    const n = parseFloat(num);
    if (!Number.isFinite(n) || Math.abs(n) < 1e-11) return "0";
    return n.toFixed(10).replace(/\.?0+$/, "");
}

// ============================================================================
// BUILD LP STRING (CPLEX FORMAT)
// ============================================================================
async function solvePortfolio(params) {
    const {
        prices, initialCash, initialHoldings, buyFactor, sellFactor,
        dailyInterest, marginalChangeParam, decayFactor
    } = params;

    const T = prices.length;
    const stocks = Object.keys(prices[0]).filter(k => k !== 'Month' && k !== 'Day');

    // ============================================================================
    // PARAMETERS & COEFFICIENTS
    // ============================================================================

    // λ : Marginal dollar impact per share (Arithmetic Step Coefficient)
    const lambda = parseFloat(marginalChangeParam) || 0.0001;
    // φ : Exponential Moving Average (EMA) Alpha Decay coefficient
    const phi = parseFloat(decayFactor) || 0;
    // γ : Daily interest rate multiplier (Overnight Carry)
    const gamma = 1 + (parseFloat(dailyInterest) / 100);
    // Ω : Predictive Accuracy Metric (The Confidence Hurdle).
    const omega = 0.005;

    let lpLines = ["Maximize"];
    let constraints = [];

    /**============================================================================
     * OBJECTIVE FUNCTION (Z)
     * ============================================================================
     * Equation: Maximize Z = c_T + Σ (h_i,T * P_i,T * sellFactor)
     * Goal: Maximize the final "Settled Liquid Wealth" on the terminal day.
     * The solver treats terminal holdings as cash minus the sellFactor friction. 
     * This prevents holding "worthless" stock just to satisfy inventory constraints.
     */
    const lastDay = T - 1;
    let objTerms = [`c_${lastDay}`];
    stocks.forEach(stock => {
        const sKey = stock.replace(/\s+/g, '_');
        const liqVal = (parseFloat(prices[lastDay][stock]) || 0) * sellFactor;
        objTerms.push(`${fmt(liqVal)} h_${sKey}_${lastDay}`);
    });

    lpLines.push(" obj: " + objTerms.join(" + "));
    lpLines.push("Subject To");

    /**============================================================================
     * DECISION VARIABLES (Per Period t)
     * ============================================================================
     * c_t: Cash balance at the end of day t (non-negative).
     * b_i,t: Shares of stock i purchased on day t. (evening)
     * s_i,t: Shares of stock i sold on day t. (morning)
     * h_i,t: Inventory of shares of stock i held overnight from day t to t+1.
     */

    for (let t = 0; t < T; t++) {
        const p = prices[t];

        /**============================================================================
         * CASH BALANCE CONSTRAINT
         * ============================================================================
         * Equation: c_t - (c_t-1 * γ) + Σ(b_i,t * effBuy) - Σ(s_i,t * effSell) = 0
         * where effBuy = (Price * buyFactor) + λ & effSell = (Price * sellFactor) - λ 
         * PURPOSE: Adding a stepwise adjustment λ, linearizes marginal cost. The solver
         * sees a constant "Step" cost for every share. This creates a Liquidity limiter
         * that stops the solver from buying infinite shares when a signal is strong.
         */
        let cashExpr = `c_${t}`;
        if (t > 0) cashExpr += ` - ${fmt(gamma)} c_${t - 1}`;

        stocks.forEach(stock => {
            const sKey = stock.replace(/\s+/g, '_');
            const pr = parseFloat(p[stock]) || 0;
            const h0 = (t === 0 && initialHoldings) ? (parseFloat(initialHoldings[stock]) || 0) : 0;
            const effBuy = (pr * buyFactor) + lambda;
            const effSell = (pr * sellFactor) - lambda;

            cashExpr += ` + ${fmt(effBuy)} b_${sKey}_${t} - ${fmt(effSell)} s_${sKey}_${t}`;

            /**============================================================================
             * INVENTORY BALANCE CONSTRAINT
             * ============================================================================
             * Equation: h_t - h_t-1 - b_t + s_t = 0
             * PURPOSE: Contiguous state of portfolio. Shares cannot be created or destroyed.
             * Every share sold (s_t) must either have been bought today (b_t) 
             * or carried over from yesterday (h_t-1).
             */
            let invExpr = `h_${sKey}_${t} + s_${sKey}_${t} - b_${sKey}_${t}`;
            if (t > 0) invExpr += ` - h_${sKey}_${t - 1}`;
            constraints.push(`inv_bal_${sKey}_${t}: ${invExpr} = ${fmt(h0)}`);

            /**============================================================================
             * ALPHA DECAY & CAPACITY (Ripple Constraint)
             * ============================================================================
             * Equation: Σ (Volume_t-k * φ^k) <= ShareCap
             * PURPOSE: Simulates Market Impact over successive days on Trading.
             * The shareCap is calculated as (UnitProfit / λ). This is the exact equilibrium
             * point where the marginal profit from one more share is zero because it is 
             * cancelled out by the stepwise penalty.  This helps simulate how actions taken
             * within a market do not exist in a vacuum, with an EMA impact over the period. 
             */
            const DECAY_PERIOD = 7;
            let rippleExpr = `b_${sKey}_${t} + s_${sKey}_${t}`;
            if (phi > 0) {
                for (let i = 1; i <= DECAY_PERIOD; i++) {
                    if (t - i >= 0) {
                        const weight = Math.pow(phi, i);
                        if (weight >= 0.001) rippleExpr += ` + ${fmt(weight)} b_${sKey}_${t - i} + ${fmt(weight)} s_${sKey}_${t - i}`;
                    }
                }
            }

            let shareCap = 100000;
            if (t < T - 1) {
                const pNext = parseFloat(prices[t + 1][stock]) || 0;
                // Equilibrium Capacity Formula - Based on Signal Strength
                const unitProfit = (pNext * sellFactor) - (pr * buyFactor * gamma) - omega;
                shareCap = unitProfit > 0 ? (unitProfit / lambda) : 0;
            }
            constraints.push(`ripple_${sKey}_${t}: ${rippleExpr} <= ${fmt(shareCap + 0.5)}`);

            /**============================================================================
             * SEQUENCING CONSTRAINT (Swing Trading Rule)
             * ============================================================================
             * PURPOSE: Prevents "Naked Shorting" and ensures same-day liquidity logic.
             * You cannot sell more than you held overnight.
             */
            if (t === 0) {
                constraints.push(`seq_${sKey}_${t}: s_${sKey}_${t} <= ${fmt(h0 + 0.001)}`);
            } else {
                constraints.push(`seq_${sKey}_${t}: s_${sKey}_${t} - h_${sKey}_${t - 1} <= 0.001`);
            }
        });

        constraints.push(`cash_bal_${t}: ${cashExpr} = ${(t === 0) ? fmt(initialCash) : 0}`);
    }

    // --- LP FINALIZATION ---
    const lpString = [...lpLines, ...constraints, "Bounds", "End"].join("\n");

    try {
        if (!highsModule) await highsModulePromise;
        // Transmit the CPLEX string to the WASM HiGHS engine.
        const result = highsModule.solve(lpString);

        // Check Dual Simplex Result Status
        if (result.Status !== 'Optimal') return { status: 'Infeasible', error: result.Status };
        const cols = result.Columns;

        /**============================================================================
         * DISCRETE HEURISTIC PRUNING:
         * ============================================================================
         * This takes solution values above a threshold and output an exact solution.
         * The LP model uses a linear step λ, which does not exactly reflect the discrete
         * marginal penalty.   Additionally, adding firm limits on minimum transactions 
         * would significantly increases computational complexity.  As such, parsing is
         * best done after solving, where minor error is introduced in exchange for 
         * computational feasibility.  This error is often less than that accrued from
         * linearization of the actual Arithmetic Progression Sum: Cost = λ * (V + 1) / 2
         */
        const runSimulation = (prune = false) => {
            let simCash = initialCash;
            let simHoldings = {};
            let simLeaks = {};

            stocks.forEach(s => {
                simHoldings[s] = parseFloat(initialHoldings ? initialHoldings[s] : 0) || 0;
                simLeaks[s] = [0, 0, 0, 0, 0];
            });

            let logs = [];
            const CASH_THRESHOLD = 500;

            for (let t = 0; t < T; t++) {
                if (t > 0) simCash *= gamma; // Time Value of Money

                let stockWealth = 0;
                let log = { dayIdx: t, buys: {}, sells: {}, stockValues: {}, cashHeld: 0, totalValue: 0 };

                // Identify and Filter out Trivial Trades
                let dailyTrades = [];
                stocks.forEach(stock => {
                    const sKey = stock.replace(/\s+/g, '_');
                    const pr = parseFloat(prices[t][stock]) || 0;
                    let bS = cols[`b_${sKey}_${t}`]?.Primal || 0;
                    let sS = cols[`s_${sKey}_${t}`]?.Primal || 0;

                    const dollarVolume = (bS + sS) * pr;
                    if (prune && dollarVolume < CASH_THRESHOLD) {
                        bS = 0; sS = 0;
                    }

                    if (bS > 0.01 || sS > 0.01) {
                        dailyTrades.push({ stock, sKey, bS, sS, pr });
                        if (bS > 0.01) log.buys[stock] = bS;
                        if (sS > 0.01) log.sells[stock] = sS;
                    }
                });

                // LIQUIDITY RECYCLING - Sells are processed before Buys.
                dailyTrades.forEach(tr => {
                    if (tr.sS > 0) {
                        const fee = (lambda * (tr.sS + 1)) / 2;
                        simHoldings[tr.stock] -= tr.sS;
                        simCash += (tr.sS * (tr.pr * sellFactor - fee));
                    }
                });

                dailyTrades.forEach(tr => {
                    if (tr.bS > 0) {
                        const fee = (lambda * (tr.bS + 1)) / 2;
                        simHoldings[tr.stock] += tr.bS;
                        simCash -= (tr.bS * (tr.pr * buyFactor + fee));
                    }
                });

                // Update alpha decay and daily valuation
                stocks.forEach(stock => {
                    const pr = parseFloat(prices[t][stock]) || 0;
                    const tr = dailyTrades.find(d => d.stock === stock);
                    simLeaks[stock].shift();
                    simLeaks[stock].push(tr ? (tr.bS + tr.sS) : 0);

                    log.stockValues[stock] = simHoldings[stock] * pr;
                    stockWealth += log.stockValues[stock];
                });

                log.cashHeld = simCash;
                log.totalValue = log.cashHeld + stockWealth;
                logs.push(log);
            }
            return { nav: logs[T - 1].totalValue, logs };
        };

        // LP Solver Output - Prone to Roundoff Error
        const rawLPValue = result.ObjectiveValue;

        // Heuristic No-Pruning (Baseline for error calculation)
        const baseline = runSimulation(false);

        // Heuristic Pruned ($500 Floor Trade Value)
        const pruned = runSimulation(true);

        /**============================================================================
         * CONSOLE DIAGNOSTICS
         * ============================================================================
         */
        const lpError = ((rawLPValue - baseline.nav) / baseline.nav) * 100;
        const pruneError = ((pruned.nav - baseline.nav) / baseline.nav) * 100;

        console.log("%c--- PORTFOLIO VALIDATION ---", "color: #0b8f0bff; font-weight: bold; font-size: 12px;");
        console.table({
            "[1] Linear Program Raw Solution": { Value: `$${rawLPValue.toLocaleString()}`, Error: `${lpError.toFixed(5)}%` },
            "[2] Discrete Simulation (No Pruning)": { Value: `$${baseline.nav.toLocaleString()}`, },
            "[3] Actionable Plan (Pruned)": { Value: `$${pruned.nav.toLocaleString()}`, Error: `${pruneError.toFixed(5)}%` }
        });

        if (pruneError < 0.5) {
            console.log("%cSTATUS: Pruning acceptable (within 0.5% tolerance).", "color: #06add6ff;");
        } else {
            console.warn("STATUS: Pruning significantly impacts NAV. Strategy may be 'noise' dependent.", "color: #c70303ff;");
        }

        // Return pruned.logs to the UI so charts only reflect ACTIONABLE trades.
        return { status: 'Optimal', result: { finalPortfolioValue: pruned.nav, dailyLogs: pruned.logs } };

    } catch (e) {
        return { status: 'Error', error: e.message };
    }
}

// ------------------------------------------------------------------------
// MESSAGE HANDLER
// ------------------------------------------------------------------------
self.onmessage = async function (e) {
    const { type, data } = e.data;
    if (type === 'solve') {
        if (!highsModule) await highsModulePromise;
        const output = await solvePortfolio(data);
        self.postMessage({ type: 'result', ...output });
    }
};
