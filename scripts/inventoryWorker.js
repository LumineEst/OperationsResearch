/**
 * ==============================================================================
 * Highs Solver Worker - MILP Optimization for Steel Production (Memory-Hardened)
 * ==============================================================================
 * * Description:
 * This Web Worker handles the mathematical optimization of a production schedule.
 * It uses the HiGHS solver (via WebAssembly) to solve a Mixed-Integer Linear
 * Programming (MILP) problem.  Using CPLEX Formatting:
 * http://web.mit.edu/lpsolve/doc/CPLEX-format.htm
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
async function solveSteelProductionLP(params) {
    // Safety Check for Highs Module being loaded
    if (!highsModule) {
        if (!highsModulePromise) return { status: 'Error', error: "Solver loader not found." };
        await highsModulePromise;
    }

    // Opertional Parameters
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

            // For each day of the week, parse the anticipate Demand in tons
            const dem = parseFloat(p.demand[j]) || 0;

            /**
            * OBJECTIVE FUNCTION CONSTRUCTION
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

            /**
            * PRODUCTION BALANCE/FLOW CONSTRAINT
            * Ensures that: Produced + Slack + (Prev Inv) + (Current Backorder) = (Current Demand) + (Current Inv) + (Prev Backorder)
            * Which creates continuity between days, unifying daily constraints across the week.
            * Formula: p + s - i + bo + i(prev) - bo(prev) = demand
            */
            let bal = `p_${i}_${j} + s_${i}_${j} - i_${i}_${j} + bo_${i}_${j}`;
            if (j > 0) bal += ` + i_${i}_${j - 1} - bo_${i}_${j - 1}`;  // Handles First Day lack of priors
            constraints.push(` c_bal_${i}_${j}: ${bal} = ${fmt(dem)}`);

            /**
             * BINARY SETUP LINKING (Indicator Variable)
             * Links production volume (p) to the binary changeover variable (b).
             * p <= maxCapacity * b.  If b=0, production must be 0. If b=1, production is allowed up to max.
             */
            constraints.push(` c_link_${i}_${j}: p_${i}_${j} - ${fmt(maxCapacity)} b_${i}_${j} <= 0`);
            binaries.push(`b_${i}_${j}`);

            /**
             * END-OF-WEEK BACKORDER CONSTRAINT
             * Forces backorders to zero on the last day to ensure all demand
             * is eventually satisfied by the end of the simulation.
             */
            if (j === daysCount - 1) constraints.push(` c_end_bo_${i}: bo_${i}_${j} = 0`);
        }
    }

    /**
     * OPERATIONAL AVAILABILITY
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

        /**
         * MATERIAL CAPACITY CONSTRAINT
         * Total units of all products on day j cannot exceed maxCapacity.
         */
        if (dayProd.length > 0) constraints.push(` c_cap_${j}: ${dayProd.join(" + ")} <= ${fmt(maxCapacity)}`);
        
        /**
         * OPERATIONAL TIME CONSTRAINT
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

    /**
    * SOLVER EXECUTION & TWO-PHASE METHOD INTERPRETATION
    * If the slack variable 's' is in the return, it indicates that (demand exceeds capacity).
     */
    try {
        const result = highsModule.solve(lpString);
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
self.onmessage = async function (e) {
    const { type, data } = e.data;
    if (type === 'solve') {
        const output = await solveSteelProductionLP(data);
        self.postMessage({ type: 'result', ...output });
    }
};
