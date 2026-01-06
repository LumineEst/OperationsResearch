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
 * purchases impact projections over time.  A Heuristic Validator is used after
 * the LP simulation to remove small transactions and to finalize the solution.
 * CPLEX Formatting: http://web.mit.edu/lpsolve/doc/CPLEX-format.htm
 * HiGHs Controls: https://dev.ampl.com/solvers/highs/options.html
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
        prices, initialCash, initialHoldings,
        dailyInterest, marginalChangeParam, decayFactor, minTrade
    } = params;

    const T = prices.length;
    const stocks = Object.keys(prices[0]).filter(k => k !== 'Month' && k !== 'Day');

    // ============================================================================
    // PARAMETERS & COEFFICIENTS
    // ============================================================================

    // λ : Marginal dollar impact per share (Arithmetic Step Coefficient)
    const lambda = parseFloat(marginalChangeParam / 100) || 0.0002;
    // φ : Exponential Moving Average (EMA) Alpha Decay coefficient
    const phi = parseFloat(decayFactor) || 0;
    // γ : Daily interest rate multiplier (Overnight Carry)
    const gamma = 1 + (parseFloat(dailyInterest) / 100) || 1.00008;
    // Ω : Predictive Accuracy Metric (The Confidence Hurdle).
    const omega = 0.005;
    // Approximation Resolution: Number of discrete tiers to linearize marginal cost.
    const NUM_TIERS = 10;

    let lpLines = ["Maximize"];
    let constraints = [];
    let bounds = [];

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
        const price = parseFloat(prices[lastDay][stock]) || 0;
        // Objective accounts for terminal liquidity with no further slippage applied at Z.
        objTerms.push(`${fmt(price)} h_${sKey}_${lastDay}`);
    });

    lpLines.push(" obj: " + objTerms.join(" + "));
    lpLines.push("Subject To");

    /**============================================================================
     * DECISION VARIABLES (Per Period t)
     * ============================================================================
     * c_t: Cash balance at the end of day t (non-negative).
     * b_i,t_n: Shares of stock i purchased on day t in tier n.
     * s_i,t_n: Shares of stock i sold on day t in tier n.
     * h_i,t: Inventory of shares of stock i held overnight from day t to t+1.
     */

    for (let t = 0; t < T; t++) {
        const p = prices[t];

        /**============================================================================
         * CASH BALANCE CONSTRAINT
         * ============================================================================
         * Equation: c_t - (c_t-1 * γ) + Σ(Σ b_i,t,n * effBuy_n) - Σ(Σ s_i,t,n * effSell_n) = 0
         * PURPOSE: Uses Piecewise Linearization to handle the arithmetic progression.
         * Each tier has an increasing cost for buys and decreasing revenue for sells.
         * This forces the solver to fill the lowest impact tiers first.
         * This also functions as a constraint to prevent "wash-trading", or same-day trades.
         */
        let cashExpr = `c_${t}`;
        if (t > 0) cashExpr += ` - ${fmt(gamma)} c_${t - 1}`;

        stocks.forEach(stock => {
            const sKey = stock.replace(/\s+/g, '_');
            const pr = parseFloat(p[stock]) || 0;
            const iH = (t === 0 && initialHoldings) ? (parseFloat(initialHoldings[stock]) || 0) : 0;

            // Dynamic capacity calculation to determine the width of approximation tiers.
            let maxVol = 10000;
            if (t < T - 1) {
                const pNext = parseFloat(prices[t + 1][stock]) || 0;
                // Price change must exceed overnight carry + confidence hurdle
                const unitProfit = pNext - (pr * gamma) - omega;
                maxVol = unitProfit > 0 ? (unitProfit / lambda) : 500;
            }
            const tierSize = Math.max(1, Math.ceil(maxVol / NUM_TIERS));

            let buyTierSum = [];
            let sellTierSum = [];
            let buyVars = [];
            let sellVars = [];

            for (let n = 0; n < NUM_TIERS; n++) {
                const bVar = `b_${sKey}_${t}_t${n}`;
                const sVar = `s_${sKey}_${t}_t${n}`;

                // Marginal cost at the midpoint of the tier approximates the integral of the cost.
                const vMid = (n * tierSize) + (tierSize / 2);
                const effBuy = pr + (lambda * vMid);
                const effSell = pr - (lambda * vMid);

                buyTierSum.push(`${fmt(effBuy)} ${bVar}`);
                sellTierSum.push(`${fmt(effSell)} ${sVar}`);
                buyVars.push(bVar);
                sellVars.push(sVar);

                bounds.push(`0 <= ${bVar} <= ${fmt(tierSize)}`);
                bounds.push(`0 <= ${sVar} <= ${fmt(tierSize)}`);
            }

            cashExpr += ` + ${buyTierSum.join(" + ")} - ${sellTierSum.join(" - ")}`;

            /**============================================================================
             * INVENTORY BALANCE CONSTRAINT
             * ============================================================================
             * Equation: h_t - h_t-1 - Σ(b_t,n) + Σ(s_t,n) = 0
             * PURPOSE: Contiguous state of portfolio. Shares cannot be created or destroyed.
             */
            let invExpr = `h_${sKey}_${t} + ${sellVars.join(" + ")} - ${buyVars.join(" - ")}`;
            if (t > 0) invExpr += ` - h_${sKey}_${t - 1}`;
            constraints.push(`inv_bal_${sKey}_${t}: ${invExpr} = ${fmt(iH)}`);

            /**============================================================================
             * ALPHA DECAY & CAPACITY (Ripple Constraint)
             * ============================================================================
             * Equation: Σ (Volume_t-k * φ^k) <= ShareCap
             * PURPOSE: Simulates Market Impact over successive days on Trading, based on an EMA
             * (Exponential Moving Average) in which weakening ripples move through successive days.
             */
            const DECAY_PERIOD = 21; // 3 weeks
            let rippleExpr = `${buyVars.join(" + ")} + ${sellVars.join(" + ")}`;
            if (phi > 0) {
                for (let i = 1; i <= DECAY_PERIOD; i++) {
                    if (t - i >= 0) {
                        const weight = Math.pow(phi, i);
                        if (weight >= 0.001) {
                            for (let n = 0; n < NUM_TIERS; n++) {
                                rippleExpr += ` + ${fmt(weight)} b_${sKey}_${t - i}_t${n} + ${fmt(weight)} s_${sKey}_${t - i}_t${n}`;
                            }
                        }
                    }
                }
            }
            constraints.push(`ripple_${sKey}_${t}: ${rippleExpr} <= ${fmt(maxVol + 0.5)}`);
        });

        constraints.push(`cash_bal_${t}: ${cashExpr} = ${(t === 0) ? fmt(initialCash) : 0}`);
    }

    // --- FINALIZING LP CPLEX STRING ---
    const lpString = [
        lpLines.join("\n"),
        constraints.join("\n"),
        "Bounds",
        bounds.join("\n"),
        "End"
    ].join("\n");

    try {
        if (!highsModule) await highsModulePromise;
        // Pass the CPLEX String to the WASM HiGHs engine
        const result = highsModule.solve(lpString);

        // Check Dual Simplex Result Status
        if (result.Status !== 'Optimal') return { status: 'Infeasible', error: result.Status };
        const cols = result.Columns;

        /**============================================================================
         * DISCRETE HEURISTIC PRUNING:
         * ============================================================================
         * This takes solution values above a threshold and output an exact solution.
         * The LP model uses a piecewise approximation of the marginal slippage of costs
         * to avoid a computationally intensive Quadratic model, this gives an approximation 
         * with around 0.1% error.  Additionally, adding firm limits on minimum transactions
         * would significantly increases computational complexity.  As such, parsing is
         * best done after solving, where minor error is introduced in exchange for
         * computational feasibility.  This error is often less than that accrued from
         * linearization of the actual Arithmetic Progression Sum: Cost = λ * (V + 1) / 2
         */
        const runSimulation = (prune = false) => {
            const CASH_THRESHOLD = parseFloat(minTrade) || 1000;
            let simCash = initialCash;
            let simHoldings = {};
            stocks.forEach(s => {
                simHoldings[s] = parseFloat(initialHoldings ? initialHoldings[s] : 0) || 0;
            });

            let logs = [];
            for (let t = 0; t < T; t++) {
                // --- APPLY INTEREST ON STARTING CASH ---
                if (t > 0) simCash *= gamma;
                let log = { dayIdx: t, buys: {}, sells: {}, stockValues: {}, cashHeld: 0, totalValue: 0 };
                let dailyTrades = [];

                stocks.forEach(stock => {
                    const sKey = stock.replace(/\s+/g, '_');
                    const pr = parseFloat(prices[t][stock]) || 0;

                    let bS = 0; let sS = 0;
                    for (let n = 0; n < NUM_TIERS; n++) {
                        bS += cols[`b_${sKey}_${t}_t${n}`]?.Primal || 0;
                        sS += cols[`s_${sKey}_${t}_t${n}`]?.Primal || 0;
                    }

                    // --- REMOVE TRIVIAL TRADES ---
                    if (prune && (bS + sS) * pr < CASH_THRESHOLD) { bS = 0; sS = 0; }

                    if (bS > 0.01 || sS > 0.01) {
                        dailyTrades.push({ stock, bS, sS, pr });
                        if (bS > 0.01) log.buys[stock] = bS;
                        if (sS > 0.01) log.sells[stock] = sS;
                    }
                });

                // --- LIQUIDITY RECYCLING: SELLS FIRST ---
                dailyTrades.forEach(tr => {
                    if (tr.sS > 0) {
                        const fee = (lambda * (tr.sS + 1)) / 2;
                        simHoldings[tr.stock] -= tr.sS;
                        simCash += (tr.sS * (tr.pr - fee));
                    }
                });

                // --- LIQUIDITY RECYCLING: BUYS SECOND ---
                dailyTrades.forEach(tr => {
                    if (tr.bS > 0) {
                        const fee = (lambda * (tr.bS + 1)) / 2;
                        simHoldings[tr.stock] += tr.bS;
                        simCash -= (tr.bS * (tr.pr + fee));
                    }
                });

                // --- FINAL EOD SETTLEMENT ---
                let stockWealth = 0;
                stocks.forEach(stock => {
                    const pr = parseFloat(prices[t][stock]) || 0;
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
        // Heuristic Pruned (Floor Trade Value)
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