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
/**The following code is an implementation of a Portfolio Optimization
 * problem using a linear programming (LP) solver and a heuristic simulation.
 * The LP formulation optimizes a set of decision variables, which represent
 * the number of shares of each stock to buy or sell at each point in time.
 * The heuristic simulation runs through the solution and prunes any trades
 * with a marginal cost below a given threshold, and re-runs the simulation,
 * to produce an actionable plan.  The problem is formulated as follows:
 * - Maximize the final wealth, accounting for all possible transactions and
 * their associated costs, including transaction fees and possible holding fees.
 * - Constraints:
 * - Each stock's holdings should be non-negative.
 * - The cash balance at the end of each day should be non-negative.
 * - The inventory balance at the end of each day should be zero.
 * - Each stock's inventory at the end of each day should be zero.
 * - Each stock's inventory balance follows a decaying pattern, based on an
 *   Exponential Moving Average, to simulate market impact over successive days.
 * - The LP formulation represents an approximation to the problem, and the heuristic
 * simulation provides an exact value from the linearization of the problem.
 */
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
     * Equation: Maximize Z = c_T + Σ (h_i,T * P_i,T)
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
         * This forces the solver to fill the lowest impact tiers first, effectively
         * approximating the integral of the marginal cost function linearly.
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
                // Price change must exceed overnight carry + lower tail of the confidence hurdle
                const unitProfit = pNext - (pr * gamma) - (omega/2);
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
             * A large trade today reduces the available liquidity for several days. 
             * Mathematically, this is a convolution constraint that limits the 
             * weighted moving average of trade volume to prevent market disruption.
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
         * This takes solution values above a threshold and outputs an exact solution.
         * The LP model uses a piecewise approximation of the marginal slippage of costs
         * to avoid a computationally intensive Quadratic model, this gives an approximation 
         * with around 0.5% error.  Additionally, adding firm limits on minimum transactions
         * would significantly increase computational complexity.  As such, parsing is
         * best done after solving, where minor error is introduced in exchange for
         * computational feasibility.  This evaluates the 'trivial trades' from least to
         * greatest value, and performs a safety check to ensure cumulative prunes do not
         * violate the future cash or portfolio inventory floors.  The error of this trim
         * linearization of the actual Arithmetic Progression Sum: Cost = λ * (V + 1) / 2
         * is often a fraction of a percent.
         * @param {boolean} prune - If true, trades with a marginal cost below the given
         *                          CASH_THRESHOLD are discarded.  (If safe to do so)
         */
        const runSimulation = (applyPruning = false) => {
            // Determine the threshold for "trivial" trades based on user input
            const CASH_THRESHOLD = parseFloat(minTrade) || 1000;

            // Fee logic mirrors the discrete arithmetic progression: λ * (V + 1) / 2
            const marginalSlip = (shares) => (lambda * (shares + 1)) / 2;

            /**
             * PASS-THROUGH SIMULATION ENGINE
             * Performs a deterministic simulation of the portfolio based on solver primals.
             * @param {Set} pruneSet - A set of "Stock_Day_Type" keys to exclude from simulation.
             */
            const executeSimulation = (pruneSet) => {
                let simCash = initialCash;
                let simHoldings = {};
                stocks.forEach(s => simHoldings[s] = parseFloat(initialHoldings ? initialHoldings[s] : 0) || 0);

                let logs = [];
                let path = { cash: new Float64Array(T), inventory: {} };
                stocks.forEach(s => path.inventory[s] = new Float64Array(T));

                for (let t = 0; t < T; t++) {
                    // Apply daily interest/carry to cash at start of day
                    if (t > 0) simCash *= gamma;

                    let log = { dayIdx: t, buys: {}, sells: {}, stockValues: {}, cashHeld: 0, totalValue: 0 };
                    let daySells = [];
                    let dayBuys = [];

                    stocks.forEach(stock => {
                        const sKey = stock.replace(/\s+/g, '_');
                        const pr = parseFloat(prices[t][stock]) || 0;
                        let bS = 0, sS = 0;

                        // Aggregate Primal values across tiers from the solver result
                        for (let n = 0; n < NUM_TIERS; n++) {
                            bS += (cols[`b_${sKey}_${t}_t${n}`]?.Primal || 0);
                            sS += (cols[`s_${sKey}_${t}_t${n}`]?.Primal || 0);
                        }

                        // Check if this specific trade should be pruned
                        if (pruneSet.has(`${stock}_${t}_BUY`)) bS = 0;
                        if (pruneSet.has(`${stock}_${t}_SELL`)) sS = 0;

                        // Threshold (1e-10) handles numeric noise
                        if (sS > 1e-10) daySells.push({ stock, shares: sS, pr });
                        if (bS > 1e-10) dayBuys.push({ stock, shares: bS, pr });
                    });

                    // Execute Sells first to recycle liquidity
                    daySells.forEach(tr => {
                        const fee = marginalSlip(tr.shares);
                        simHoldings[tr.stock] -= tr.shares;
                        simCash += (tr.shares * (tr.pr - fee));
                        log.sells[tr.stock] = tr.shares;
                    });
                    // Execute Buys second
                    dayBuys.forEach(tr => {
                        const fee = marginalSlip(tr.shares);
                        simHoldings[tr.stock] += tr.shares;
                        simCash -= (tr.shares * (tr.pr + fee));
                        log.buys[tr.stock] = tr.shares;
                    });

                    // Record Settlement State
                    let stockWealth = 0;
                    stocks.forEach(stock => {
                        const pr = parseFloat(prices[t][stock]) || 0;
                        log.stockValues[stock] = simHoldings[stock] * pr;
                        stockWealth += log.stockValues[stock];
                        path.inventory[stock][t] = simHoldings[stock];
                    });

                    log.cashHeld = simCash;
                    log.totalValue = log.cashHeld + stockWealth;
                    path.cash[t] = simCash;
                    logs.push(log);
                }
                return { nav: logs[T - 1].totalValue, logs, path };
            };

            // PASS 1: Generate the Baseline (Unfiltered restimulation)
            const baseline = executeSimulation(new Set());
            if (!applyPruning) return { nav: baseline.nav, logs: baseline.logs };

            // PASS 2: Sequential Pruning Evaluation
            let candidates = [];
            for (let t = 0; t < T; t++) {
                stocks.forEach(stock => {
                    const sKey = stock.replace(/\s+/g, '_');
                    const pr = parseFloat(prices[t][stock]) || 0;
                    let bS = 0, sS = 0;
                    for (let n = 0; n < NUM_TIERS; n++) {
                        bS += (cols[`b_${sKey}_${t}_t${n}`]?.Primal || 0);
                        sS += (cols[`s_${sKey}_${t}_t${n}`]?.Primal || 0);
                    }
                    if (bS > 1e-15 && (bS * pr) < CASH_THRESHOLD) {
                        candidates.push({ t, stock, shares: bS, type: 'BUY', value: bS * pr });
                    }
                    if (sS > 1e-15 && (sS * pr) < CASH_THRESHOLD) {
                        candidates.push({ t, stock, shares: sS, type: 'SELL', value: sS * pr });
                    }
                });
            }

            // Sort candidates by dollar value to maximize 'trivial' prunes
            candidates.sort((a, b) => a.value - b.value);

            let accepted = new Set();
            let deltaCash = new Float64Array(T);
            let deltaInv = {};
            stocks.forEach(s => deltaInv[s] = new Float64Array(T));

            candidates.forEach(can => {
                const pr = parseFloat(prices[can.t][can.stock]) || 0;
                const fee = marginalSlip(can.shares);
                let isSafe = true;

                if (can.type === 'BUY') {
                    // Check: Does removing this BUY cause inventory to go negative later?
                    for (let ft = can.t; ft < T; ft++) {
                        if (baseline.path.inventory[can.stock][ft] + deltaInv[can.stock][ft] - can.shares < -1e-10) {
                            isSafe = false; break;
                        }
                    }
                } else {
                    // Check: Does removing this SELL cause cash to go negative later?
                    const netProceeds = can.shares * (pr - fee);
                    for (let ft = can.t; ft < T; ft++) {
                        if (baseline.path.cash[ft] + deltaCash[ft] - netProceeds < -1e-5) {
                            isSafe = false; break;
                        }
                    }
                }

                if (isSafe) {
                    accepted.add(`${can.stock}_${can.t}_${can.type}`);
                    // Apply cumulative delta for future checks
                    for (let ft = can.t; ft < T; ft++) {
                        if (can.type === 'BUY') deltaInv[can.stock][ft] -= can.shares;
                        else deltaInv[can.stock][ft] += can.shares;
                    }
                    // Compound the cash delta with daily interest
                    let currentDelta = (can.type === 'BUY') ? (can.shares * (pr + fee)) : -(can.shares * (pr - fee));
                    for (let ft = can.t; ft < T; ft++) {
                        deltaCash[ft] += currentDelta;
                        currentDelta *= gamma;
                    }
                }
            });

            // PASS 3: Generate the Final Actionable Plan
            const pruned = executeSimulation(accepted);
            return { nav: pruned.nav, logs: pruned.logs };
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
// This function is the entry point for the web worker. It's invoked when the
// main thread sends a message to the worker. 
// ------------------------------------------------------------------------
self.onmessage = async function (e) {
    // Extract the type and data from the message that the main thread sent.
    const { type, data } = e.data;
    // If 'solve', send the LP problem data to the solver and process the results.
    if (type === 'solve') {
        // Call the solver with the LP problem data and wait for the result.
        const output = await solvePortfolio(data);
        // Post a message back to the main thread with the result data;
        // The spread operator (...) merges the result object with the type field
        self.postMessage({ type: 'result', ...output }); 
    }
};