/**
 * ==============================================================================
 * Highs Solver Worker - Deterministic Portfolio Optimizer
 * ==============================================================================
 * * Description:
 * This Web Worker implements a multi-period financial control model.
 * It treats capital and equity as flow variables within a conservation network.
 * It penalizes large swings of stock purchases and sales to maximize portfolio
 * value based on deterministic (0.5% Confidence) projections.  However, these
 * projections fail to account for this model's own disruptions on stock values.
 * An Alpha Decay (Ripple) variable is used to simulate how dispersed or abrupt
 * purchases impact projections over time.   A Heuristic Validator is used after
 * the LP simulation to remove small transactions and to finalize the solution.
 * * CPLEX Formatting: http://web.mit.edu/lpsolve/doc/CPLEX-format.htm
 * @author Joel Wood
 */

// Worker State Variables
let highsModulePromise = null;
let highsModule = null;

/** Initialize Highs Module:
 *  Attempts to load the WebAssembly solver from libs/highs.js
 *  512MB is allocated as a safe compatability buffer, and to avoid memory overflow.
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

/**
 * Numeric Formatter:
 * Converts numbers to a string format compatible with the CPLEX/LP file format.
 * Trims excess precision to prevent the LP string from becoming unnecessarily massive.
 * This trim of excess characters is necessary to mitigate excessive string memory usage.
 * It also helps mitigate "Ill-Conditioned" matrices which appear when coefficients have
 * vastly different scales.
 */
function fmt(num) {
    const n = parseFloat(num);
    if (!Number.isFinite(n) || Math.abs(n) < 1e-11) return "0";
    return n.toFixed(10).replace(/\.?0+$/, "");
}

// ------------------------------------------------------------------------
// BUILD LP STRING (CPLEX FORMAT)
// ------------------------------------------------------------------------
async function solvePortfolio(params) {
    const {
        prices, initialCash, initialHoldings, buyFactor, sellFactor,
        dailyInterest, marginalChangeParam, decayFactor
    } = params;

    const T = prices.length;
    const stocks = Object.keys(prices[0]).filter(k => k !== 'Month' && k !== 'Day');

    // λ (Lambda): Marginal impact coefficient (Market Depth)
    const lambda = parseFloat(marginalChangeParam) || 0.002;

    // φ (Phi): Exponential Moving Average (EMA) Alpha Decay coefficient
    const phi = parseFloat(decayFactor) || 0;

    // γ (Gamma): Daily interest rate multiplier (Overnight carry)
    const gamma = 1 + (parseFloat(dailyInterest) / 100);

    // AI Accuracy Metric: 0.5% (The Confidence Hurdle).
    const accuracyHurdle = 0.005;

    let lpLines = ["Maximize"];
    let constraints = [];

    /**
     * ============================================================================
     * OBJECTIVE FUNCTION (Z)
     * ============================================================================
     * Equation: Maximize Z = c_T + Σ (h_i,T * P_i,T * sellFactor)
     * DUAL INTERPRETATION:
     * The Shadow Price of the final day's cash (π_cash_T) is normalized to 1.0.
     * All other shadow prices are relative to this terminal dollar value.
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

    for (let t = 0; t < T; t++) {
        const p = prices[t];

        /** 
         * Sort Stocks by Expected Alpha to Assign Cost Tiers
         * This is to better capture volume driven marginal cost fluctuations.
         */
        const dayRankings = stocks.map(stock => {
            const pr = parseFloat(p[stock]);
            const pNext = t < T - 1 ? parseFloat(prices[t + 1][stock]) : pr;
            return { name: stock, alpha: pNext / pr };
        }).sort((a, b) => b.alpha - a.alpha);

        /**
         * ============================================================================
         * CASH BALANCE CONSTRAINT
         * ============================================================================
         * Equation: c_t - (c_t-1 * γ) + Σ(buys) - Σ(sells) = 0
         * SHADOW PRICE (π_cash_t):
         * This reveals the "Opportunity Cost of Capital." If π_cash_t > γ,
         * it means the fund is capital-constrained; an extra dollar would yield
         * more profit through trading than it would through passive interest.
         */
        let cashExpr = `c_${t}`;
        if (t > 0) cashExpr += ` - ${fmt(gamma)} c_${t - 1}`;

        dayRankings.forEach((ranked, index) => {
            const stock = ranked.name;
            const sKey = stock.replace(/\s+/g, '_');
            const pr = parseFloat(p[stock]) || 0;
            const h0 = (t === 0 && initialHoldings) ? (parseFloat(initialHoldings[stock]) || 0) : 0;

            // DYNAMIC PENALTY: Cost increases as you add more stocks to the day's trade
            const tierPenalty = (index + 1) * lambda;
            const effBuy = pr * (buyFactor + tierPenalty);
            const effSell = pr * (sellFactor - tierPenalty);

            cashExpr += ` + ${fmt(effBuy)} b_${sKey}_${t} - ${fmt(effSell)} s_${sKey}_${t}`;

            /**
             * ============================================================================
             * INVENTORY BALANCE CONSTRAINT
             * ============================================================================
             * Equation: h_t - h_t-1 - b_t + s_t = 0
             * SHADOW PRICE (π_inv_t):
             * This is the "Intrinsic Asset Alpha." It represents the marginal value of
             * holding one more share of stock i on day t. If π_inv_t is very high,
             * the stock is fundamentally undervalued by the market on that day.
             */
            let invExpr = `h_${sKey}_${t} + s_${sKey}_${t} - b_${sKey}_${t}`;
            if (t > 0) invExpr += ` - h_${sKey}_${t - 1}`;
            constraints.push(`inv_bal_${sKey}_${t}: ${invExpr} = ${fmt(h0)}`);

            /**
             * ============================================================================
             * ALPHA DECAY & CAPACITY (Ripple Constraint)
             * ============================================================================
             * SHADOW PRICE (π_ripple_t):
             * This represents the "Cost of Market Impact." It shows how much profit
             * is being left on the table because the Alpha Decay logic is limiting
             * your trade size. A non-zero shadow price here means the solver
             * wants to trade more but is being blocked by Alpha Decay.
             */
            let rippleExpr = `b_${sKey}_${t} + s_${sKey}_${t}`;
            if (phi > 0) {
                for (let i = 1; i <= 5; i++) {
                    if (t - i >= 0) {
                        const weight = Math.pow(phi, i); // Power gradient decay
                        if (weight >= 0.001) rippleExpr += ` + ${fmt(weight)} b_${sKey}_${t - i} + ${fmt(weight)} s_${sKey}_${t - i}`;
                    }
                }
            }

            // CAPACITY BASED ON SIGNAL STRENGTH
            let shareCap = 1000000;
            if (t < T - 1) {
                const pNext = parseFloat(prices[t + 1][stock]) || 0;
                const alpha = (pNext / pr) - ((buyFactor * gamma) / sellFactor) - accuracyHurdle;
                shareCap = alpha > 0 ? (initialCash * (alpha / lambda)) / pr : 0;
            }
            constraints.push(`ripple_${sKey}_${t}: ${rippleExpr} <= ${fmt(shareCap + 0.5)}`);

            /**
             * ============================================================================
             * SEQUENCING CONSTRAINT (Swing Trading Rule)
             * ============================================================================
             * SHADOW PRICE (π_seq_t):
             * This reveals the "Liquidity Premium." If π_seq_t > 0, the model
             * would have benefited from selling more shares than were held overnight.
             * It quantifies the cost of "No Same-Day Trading".
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

        /**
         * ============================================================================
         * DISCRETE HEURISTIC PRUNING:
         * ============================================================================
         * This helper function will take solution values above a threshold and output an exact solution.
         * The LP model uses averages in the marginal values, which may not always produce an exact value,
         * The output of the base solver has a low margin of error, but the simplifications the model makes
         * to reduce computations do have around 0.2% MOE.   Additionally, there is not a way to add a firm
         * restriction on a minimum transaction amount without introducing binary variables which significantly
         * increases computational complexity.  As such, parsing these out after solving is best done with a
         * heuristic, where a minor amount of error is introduced in exchange for computational feasibility.
         * The final result from trimming these small purchases is often a slightly higher profit.
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
            const PERCENT_THRESHOLD = 0.00001;

            for (let t = 0; t < T; t++) {
                if (t > 0) simCash *= gamma;

                // Calculate the Standardized Day Rate
                let intendedTickers = 0;
                stocks.forEach(stock => {
                    const sKey = stock.replace(/\s+/g, '_');
                    if ((cols[`b_${sKey}_${t}`]?.Primal || 0) > 0.01 ||
                        (cols[`s_${sKey}_${t}`]?.Primal || 0) > 0.01) {
                        intendedTickers++;
                    }
                });

                const standardizedAggRate = intendedTickers > 0 ? lambda * (intendedTickers + 1) / 2 : 0;

                let stockWealth = 0;
                let log = { dayIdx: t, buys: {}, sells: {}, stockValues: {}, cashHeld: 0 };

                stocks.forEach(stock => {
                    const sKey = stock.replace(/\s+/g, '_');
                    const pr = parseFloat(prices[t][stock]) || 0;
                    let bS = cols[`b_${sKey}_${t}`]?.Primal || 0;
                    let sS = cols[`s_${sKey}_${t}`]?.Primal || 0;

                    // Prune values below Threshold
                    const tradeValue = (bS + sS) * pr;
                    const currentNAV = simCash + stockWealth; 
                    if (prune && tradeValue < Math.max(CASH_THRESHOLD, (currentNAV * PERCENT_THRESHOLD))) {
                        bS = 0; sS = 0;
                    }

                    // Process Sells and then Buys
                    if (sS > 0.01) {
                        simHoldings[stock] -= sS;
                        simCash += (sS * pr * (sellFactor - standardizedAggRate));
                        log.sells[stock] = sS * pr * sellFactor;
                    }
                    if (bS > 0.01) {
                        simHoldings[stock] += bS;
                        simCash -= (bS * pr * (buyFactor + standardizedAggRate));
                        log.buys[stock] = bS * pr * buyFactor;
                    }

                    // Update Alpha Decay Ripple
                    simLeaks[stock].shift();
                    simLeaks[stock].push(bS + sS);

                    let rippleSum = 0;
                    simLeaks[stock].forEach((vol, i) => rippleSum += vol * Math.pow(phi, (4 - i)));

                    log.stockValues[stock] = simHoldings[stock] * pr;
                    log[`ripple_check_${sKey}`] = rippleSum;
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

        // Heuristic Pruned ($500 / 0.001% Floor Trade Value)
        const pruned = runSimulation(true);

        /**
         * ============================================================================
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

        return {
            status: 'Optimal',
            result: {
                finalPortfolioValue: pruned.nav,
                dailyLogs: pruned.logs,
                pruneImpact: pruneError
            }
        };

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
