/**==============================================================================
 * Highs Solver Worker - MILP Optimization for Steel Production (Memory-Hardened)
 * ==============================================================================
 * * Description:
 * This Web Worker handles the mathematical optimization of a production schedule.
 * It uses the HiGHS solver (via WebAssembly) to solve a Mixed-Integer Linear
 * Programming (MILP) problem.  Using CPLEX Formatting:
 * CPLEX Formatting: http://web.mit.edu/lpsolve/doc/CPLEX-format.htm
 * HiGHs Controls: https://dev.ampl.com/solvers/highs/options.html
 * @author Joel Wood
 */

// Worker State Variables
let highsModulePromise = null;
let highsModule = null;

/** Initialize Highs Module:
 *  Attempts to load the WebAssembly solver from libs/highs.js
 *  512MB is allocated as a safe compatability buffer, and to avoid memory overflow.
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
    console.error("WORKER: WASM Load Error:", error);
}

/**
 * Numeric Formatter:
 * Converts numbers to a string format compatible with the CPLEX/LP file format.
 * Trims excess precision to prevent the LP string from becoming unnecessarily massive.
 * This trim of excess characters is necessary to mitigate excessive string memory usage.
 * It also helps mitigate "Ill-Conditioned" matricies which appear when coefficients have
 * vastly different scales.
 */
function fmt(num) {
    const n = parseFloat(num);
    if (!Number.isFinite(n) || Math.abs(n) < 1e-7) return "0";
    return n.toFixed(6).replace(/\.?0+$/, "");
}

// ------------------------------------------------------------------------
// BUILD LP STRING
// ------------------------------------------------------------------------
/** The main function of the Inventory Worker is to take a set of product data,
 * and their corresponding demand, and generate an optimal production plan.  The problem being
 * solved is to decide how much of each product to manufacture, given a fixed set of resources, 
 * and a set of known demands. The problem is formulated as a linear programming (LP) problem, 
 * using a Big-M, or Penalty approach to handling the constraints.  Using the Highs.js library, 
 * a high-performance solver for linear programming problems, the solver executes in two-phases 
 * First constructing the LP CPLEX string, executing the solver, then parsing detailed results.
 * @param {Object} params - The input parameters for the solver.
 * @param {Array<Object>} params.products - The list of products to be produced.
 * @param {number} params.rawSteelCost - The cost per ton of raw steel.
 * @param {number} params.invCost - The cost per ton of inventory.
 * @param {number} params.maxCapacity - The maximum capacity of the factory per day.
 * @param {number} params.backorderPenalty - The penalty rate for backordered items as a percentage.
 * @param {Array<number>} params.operationalTime - The daily operational time available for production.
 * @param {Array<number>} params.demand - The demand per product for each day of the week.
 * @returns {Promise<Object>}
 * @property {string} result.status - The status of the solution: 'Optimal' or 'Infeasible'
 * @property {number} result.objectiveValue - The objective function value of the solution.
 * @property {Array<Object>} result.details - The detailed results of the solution.
 * @property {string} result.details[i].product - The name of the product.
 * @property {Array<number>} result.details[i].produced - The units of the product produced each day.
 * @property {Array<number>} result.details[i].sold - The units of the product sold each day.
 * @property {Array<number>} result.details[i].inventory - The units of the product left in inventory each day.
 * @property {Array<number>} result.details[i].backorder - The units of the product backordered each day.
 */
async function solveSteelProductionLP(params) {
    // Safety Check for Highs Module being loaded
    if (!highsModule) {
        if (!highsModulePromise) return { status: 'Error', error: "Solver loader not found." };
        await highsModulePromise;
    }

    // Operational Parameters
    const { products, rawSteelCost, invCost, maxCapacity, backorderPenalty, operationalTime } = params;
    const daysCount = 7;
    const productCount = products.length;

    /**
    *  A "Big M" style penalty to help ensure the solver remains feasible.  If demand cannot be met, then the solver
    *  will penalize these slack variables to signal infeasibility in results.  Due to memory constraints, this value
    *  needs to adjust off maxCapacity to avoid excess computations, based to be higher than possible capacity (7-days).
    */
    const SLACK_PENALTY = 8 * maxCapacity;

    // Initialize arrays for LP String components
    let lpLines = ["Maximize"];
    let objTerms = [];
    let constraints = [];
    let binaries = [];

    // --- LP STRING GENERATION (CPLEX) ---
    for (let i = 0; i < productCount; i++) {
        // For each product, parse the financial values of Sell Price, Mfg Cost, and Back Order Cost per ton
        const p = products[i];
        const sellPrice = parseFloat(p.sell) || 0;
        const unitCost = (parseFloat(rawSteelCost) || 0) + (parseFloat(p.cost) || 0);
        const boCost = (parseFloat(backorderPenalty) / 100) * sellPrice;

        for (let j = 0; j < daysCount; j++) {

            // For each day of the week, parse the anticipated Demand in tons
            const dem = parseFloat(p.demand[j]) || 0;

            /**OBJECTIVE FUNCTION CONSTRUCTION
            * Mathematical Construct: Z = Σ (Revenue) - Σ (Costs)
            * i_{i}_{j} : Inventory of product i held at end of day j
            * bo_{i}_{j} : Backorder (unmet demand) of product i on day j
            * p_{i}_{j} : Production of Product i on day j
            * b_{i}_{j} : Production Binary (1 if product i is produced on day j, else 0)
            * s_{i}_{j} : Slack variable for demand satisfaction (Penalty variable)
            */
            if (invCost > 0) objTerms.push(`-${fmt(invCost)} i_${i}_${j}`); // Inventory Cost: Penalizes holding stock
            if (boCost > 0) objTerms.push(`-${fmt(boCost)} bo_${i}_${j}`); // Backorder Cost: Penalizes late fulfillment
            if (unitCost > 0) objTerms.push(`-${fmt(unitCost)} p_${i}_${j}`); // Production Cost: Cost per ton of steel + processing
            if (p.changeOverCost > 0) objTerms.push(`-${fmt(p.changeOverCost)} b_${i}_${j}`); // Changeover Cost: Binary fixed cost
            objTerms.push(`-${fmt(SLACK_PENALTY)} s_${i}_${j}`); // Slack Penalty: Penalty to mitigate mathematical infeasibility

            /** PRODUCTION BALANCE/FLOW CONSTRAINT
             * Ensures continuity over time. 
             * Mathematical Logic: (Current Stocks) = (Prior Stocks) + (New Production) - (Demand Met)
             *
             * Formulated as: p + s - i + bo + i(prev) - bo(prev) = demand
             * - p_{i}_{j}: Units produced.
             * - s_{i}_{j}: Slack variable (Penalty) used if demand is physically impossible to meet.
             * - i_{i}_{j}: Inventory carried forward to the next day.
             * - bo_{i}_{j}: Backorder volume to be fulfilled on a future day.
             */
            let bal = `p_${i}_${j} + s_${i}_${j} - i_${i}_${j} + bo_${i}_${j}`;
            if (j > 0) bal += ` + i_${i}_${j - 1} - bo_${i}_${j - 1}`;  // Handles First Day lack of priors
            constraints.push(` c_bal_${i}_${j}: ${bal} = ${fmt(dem)}`);

            /**BINARY SETUP LINKING (Indicator Variable)
             * Links production volume (p) to the binary changeover variable (b).
             * p <= maxCapacity * b.  If b=0, production must be 0. If b=1, production is allowed up to max.
             */
            constraints.push(` c_link_${i}_${j}: p_${i}_${j} - ${fmt(maxCapacity)} b_${i}_${j} <= 0`);
            binaries.push(`b_${i}_${j}`);

            /**END-OF-WEEK BACKORDER CONSTRAINT
             * Forces backorders to zero on the last day to ensure all demand
             * is eventually satisfied by the end of the simulation.
             */
            if (j === daysCount - 1) constraints.push(` c_end_bo_${i}: bo_${i}_${j} = 0`);
        }
    }

    /**OPERATIONAL AVAILABILITY
     * Calculates the available production time based on Change-Over and Cycle Times for each Product and Day
     */
    for (let j = 0; j < daysCount; j++) {
        // Total Physical Output Limit
        let dayProd = [], dayTime = [];
        const availSec = (parseFloat(operationalTime[j]) || 0) * 3600;
        for (let i = 0; i < productCount; i++) {
            const p = products[i];
            dayProd.push(`p_${i}_${j}`);
            if (p.cycleTime > 0) dayTime.push(`${fmt(p.cycleTime)} p_${i}_${j}`);
            if (p.changeOverTime > 0) dayTime.push(`${fmt(p.changeOverTime * 60)} b_${i}_${j}`);
        }

        /**MATERIAL CAPACITY CONSTRAINT
         * Total units of all products on day j cannot exceed maxCapacity.
         */
        if (dayProd.length > 0) constraints.push(` c_cap_${j}: ${dayProd.join(" + ")} <= ${fmt(maxCapacity)}`);
        
        /**OPERATIONAL TIME CONSTRAINT
         * Sum of (Production Time + Changeover Time) <= available Operational Time (seconds).
         */
        if (dayTime.length > 0) constraints.push(` c_time_${j}: ${dayTime.join(" + ")} <= ${fmt(availSec)}`);
    }

    // LP String Construction for HiGHS Solver
    const lpString = [
        "Maximize",
        " obj: " + objTerms.join(" ").replace(/ \+/g, " +").replace(/ -/g, " -"),
        "Subject To",
        ...constraints,
        "Binaries",
        " " + binaries.join("\n "),
        "End"
    ].join("\n");

    // Garbage Collection
    objTerms = null; constraints = null; binaries = null;

    /**SOLVER EXECUTION & TWO-PHASE METHOD INTERPRETATION
     * If the slack variable 's' is in the return, it indicates that (demand exceeds capacity).
     */
    try {
        const result = highsModule.solve(lpString, { time_limit: 1000, presolve: 'on' });
        const status = result?.Status || "Unknown";
        const cols = result.Columns || {};

        // Check for Slack usage: If s > 0, the problem is physically infeasible.
        let slackUsed = 0;
        Object.keys(cols).forEach(k => { if (k.startsWith('s_')) slackUsed += cols[k].Primal; });

        if (status !== "Optimal" || slackUsed > 0.01) {
            return { status: 'Infeasible', error: "Demand exceeds capacity/time limits." };
        }

        // --- PARSE RESULTS ---
        const parsedDetails = products.map((p, idx) => {
            const d = { product: p.name, produced: [], sold: [], inventory: [], backorder: [] };
            for (let j = 0; j < daysCount; j++) {
                const getV = (k) => {
                    const v = cols[k]?.Primal || 0;
                    return Math.abs(v) < 1e-5 ? 0 : Math.round(v);
                };
                const boC = getV(`bo_${idx}_${j}`);
                const boP = j > 0 ? getV(`bo_${idx}_${j - 1}`) : 0;
                d.produced.push(getV(`p_${idx}_${j}`));
                d.sold.push((parseFloat(p.demand[j]) || 0) - (boC - boP));
                d.inventory.push(getV(`i_${idx}_${j}`));
                d.backorder.push(boC);
            }
            return d;
        });

        // Calculate Revenue (Demand * Price)
        let rev = 0;
        products.forEach(p => {
            const sumDem = (p.demand || []).reduce((a, b) => a + (parseFloat(b) || 0), 0);
            rev += sumDem * (parseFloat(p.sell) || 0);
        });

        return { status: 'Optimal', result: { objectiveValue: rev + result.ObjectiveValue, details: parsedDetails } };

    } catch (e) {
        return { status: 'Error', error: "WASM Signature Error: Attempting auto-restart." };
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
        const output = await solveSteelProductionLP(data);
        // Post a message back to the main thread with the result data;
        // The spread operator (...) merges the result object with the type field
        self.postMessage({ type: 'result', ...output }); 
    }
};