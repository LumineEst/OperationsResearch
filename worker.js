/**
 * ============================================================================
 * Highs Solver Worker - MILP Engine
 * ============================================================================
 * * Description:
 * This Web Worker handles the mathematical optimization of a production schedule.
 * It uses the HiGHS solver (via WebAssembly) to solve a Mixed-Integer Linear
 * Programming (MILP) problem.
 * @author Joel Wood
 */
let highsLoaderFunction = null;
let highsScriptLoaded = false;
let highsScriptError = null;
let highsInstancePromise = null;

// Initialize Highs Script
try {
    importScripts('libs/highs.js');
    if (typeof Module === 'function') {
        highsLoaderFunction = Module;
        highsScriptLoaded = true;
    }
} catch (error) {
    highsScriptError = `Failed to import script 'libs/highsInstancePromise.js': ${error.message}`;
    console.error("WORKER: -", highsScriptError, error);
}

// --- Async Solver Loader (Singleton Pattern) ---
async function getSolverInstance() {
    if (!highsScriptLoaded || !highsLoaderFunction) {
        throw new Error(highsScriptError || "HiGHS script did not load or define loader.");
    }

    // Create the instance only once
    if (!highsInstancePromise) {
        const wasmPath = 'libs/';

        // Allocates 512MB Fixed Memory
        const memoryMB = 512;
        const initialMemory = memoryMB * 1024 * 1024;

        highsInstancePromise = highsLoaderFunction({
            locateFile: (filename) => wasmPath + filename,
            initialMemory: initialMemory
            // Note: 'allowMemoryGrowth' is intentionally OMITTED to match reference stability
        })
            .then(instance => {
                if (!instance?.solve) {
                    throw new Error("HiGHS instance invalid or missing 'solve' method.");
                }
                return instance;
            })
            .catch(err => {
                console.error("WORKER: Failed to initialize HiGHS WASM instance:", err);
                highsInstancePromise = null;
                throw err;
            });
    }
    return highsInstancePromise;
}

/**
 * Helper: Formats numbers to prevent invalid formatting, for the LP string.
 * @param {number} num
 * @returns {string}
 */
function fmt(num) {
    if (!Number.isFinite(num)) return "0";
    const s = num.toFixed(6);
    return s === "-0.000000" ? "0" : s;
}

/**
 * Main Solver Logic.
 * 1. Cleans inputs.
 * 2. Checks mathematical feasibility.
 * 3. Builds the Linear Program.
 * 4. Runs the Solver.
 * 5. Parses results.
 * * @param {Object} params - The system state object.
 */
async function solveSteelProductionLP(params) {

    // Helper for cleaning numeric values (type safety)
    const clean = (val) => {
        const n = parseFloat(val);
        return Number.isFinite(n) ? n : 0;
    };

    // Deconstruct Operational Parameters
    const products = params.products || [];
    const rawSteelCost = clean(params.rawSteelCost);
    const invCost = clean(params.invCost);
    const maxCapacity = clean(params.maxCapacity);
    const backorderPenalty = clean(params.backorderPenalty);
    const operationalTime = (params.operationalTime || []).map(clean);
    const daysCount = 7;
    const productCount = products.length;

    // ------------------------------------------------------------------------
    // FEASIBILITY CHECK
    // ------------------------------------------------------------------------
    // Before instantiating the solver, check if the problem is physically possible

    let totalWeeklyHours = operationalTime.reduce((a, b) => a + b, 0);
    let totalSetupHours = 0;
    let totalCycleHours = 0;
    let activeProducts = [];
    let totalDemandTons = 0;
    const safeCapacity = maxCapacity > 0 ? maxCapacity : 1; // Prevent Division by 0

    for (let p of products) {
        const totalDemand = (p.demand || []).reduce((a, b) => a + clean(b), 0);
        if (totalDemand > 0) {
            totalDemandTons += p.demand;
            // Setup Time: Minutes -> Hours
            const singleSetupHrs = clean(p.changeOverTime) / 60;
            // Minimum setups based on weekly supply demand, by daily supply constraint
            const minSetups = Math.ceil(totalDemand / safeCapacity);
            // Total Minimum Setup Time is Minimum number of setups x setup time
            totalSetupHours += (singleSetupHrs * minSetups);

            // Cycle Time: Seconds -> Hours
            const cycleHrs = (clean(p.cycleTime) / 3600) * totalDemand;
            totalCycleHours += cycleHrs;

            activeProducts.push({ name: p.name, requiredCycleHrs: cycleHrs });
        }
    }

    // Check for required production hours to available production hours
    let netAvailableHours = totalWeeklyHours - totalSetupHours;
    if (totalCycleHours > (netAvailableHours + 0.01)) {
        return {
            status: 'Infeasible',
            error: `Impossible: Total production needs ${totalCycleHours.toFixed(2)}h, but only ${netAvailableHours.toFixed(2)}h available (net).`
        };
    }

    // Check for Material Capacity
    if (totalDemandTons > (maxCapacity * 7)) {
        return {
            status: 'Infeasible',
            error: 'Capacity Exceeded: Demand is ${totalDemandHours} tons, but max weekly capacity is ${totalWeeklyCapacity} tons.'
        };
    }

    // ------------------------------------------------------------------------
    // INITIALIZE SOLVER
    // ------------------------------------------------------------------------
    let solverInstance;
    try {
        solverInstance = await getSolverInstance();
    } catch (error) {
        return { status: 'Error', error: "Solver Load Failed: " + error.message };
    }

    // ------------------------------------------------------------------------
    // BUILD LP STRING (CPLEX FORMAT)
    // ------------------------------------------------------------------------
    let lp = "Maximize\n obj: ";
    let objTerms = [];
    let binaryVars = [];
    let constraints = [];

    // --- OBJECTIVE FUNCTION (Profitability) ---
    for (let i = 0; i < productCount; i++) {
        const p = products[i];
        const sellPrice = clean(p.sell);
        const mfgCost = clean(p.cost);
        const coCost = clean(p.changeOverCost);
        const boCost = (backorderPenalty / 100) * sellPrice;

        for (let j = 0; j < daysCount; j++) {
            // Revenue ( + )
            if (sellPrice > 0) objTerms.push(`${fmt(sellPrice)} s_${i}_${j}`);

            // Operational Costs ( - )
            if (invCost > 0) objTerms.push(`-${fmt(invCost)} inv_${i}_${j}`);
            if (boCost > 0) objTerms.push(`-${fmt(boCost)} bo_${i}_${j}`);

            // Manufacturing Costs ( - )
            const totalMfgCost = rawSteelCost + mfgCost;
            if (totalMfgCost > 0) objTerms.push(`-${fmt(totalMfgCost)} p_${i}_${j}`);

            // Change-over Cost ( - )
            if (coCost > 0) objTerms.push(`-${fmt(coCost)} b_${i}_${j}`);

            binaryVars.push(`b_${i}_${j}`);
        }
    }
    if (objTerms.length === 0) objTerms.push("0");
    lp += objTerms.join(" + ").replace(/\+ -/g, "- ") + "\n";
    lp += "Subject To\n";

    // --- CONSTRAINTS ---
    for (let j = 0; j < daysCount; j++) {
        let dayCapTerms = [];
        let dayTimeTerms = [];
        const availTime = clean(operationalTime[j]);

        for (let i = 0; i < productCount; i++) {
            const p = products[i];
            const dem = clean(p.demand[j]);
            const cycleSec = clean(p.cycleTime);
            const coTimeMin = clean(p.changeOverTime);

            // 1. Demand: Sold <= Demand (Cannot Exceed Demands)
            constraints.push(`c_dem_${i}_${j}: s_${i}_${j} <= ${fmt(dem)}`);

            // 2. Inventory Balance (Inventory Consistency between Days)
            // Produced - Sold - Inventory + Backorder + PrevInv - PrevBackorder = 0
            let balTerms = [`p_${i}_${j}`, `- s_${i}_${j}`, `- inv_${i}_${j}`, `bo_${i}_${j}`];
            if (j > 0) {
                balTerms.push(`inv_${i}_${j - 1}`);
                balTerms.push(`- bo_${i}_${j - 1}`);
            }
            constraints.push(`c_bal_${i}_${j}: ${balTerms.join(" + ").replace(/\+ -/g, "- ")} = 0`);

            // 3. Linking (Big M) Production <= Capacity * Binary
            // If Capacity > 0, constrain Binary. If Capacity is 0, force P=0
            if (maxCapacity > 0) {
                constraints.push(`c_link_${i}_${j}: p_${i}_${j} - ${fmt(maxCapacity)} b_${i}_${j} <= 0`);
            } else {
                constraints.push(`c_link_${i}_${j}: p_${i}_${j} = 0`);
            }

            // Gather Terms for Daily Aggregates
            dayCapTerms.push(`p_${i}_${j}`);

            // Cycle (Sec -> Hrs)
            if (cycleSec > 0) {
                const coef = cycleSec / 3600;
                if (coef > 0.000001) dayTimeTerms.push(`${fmt(coef)} p_${i}_${j}`);
            }
            // Setup (Min -> Hrs)
            if (coTimeMin > 0) {
                const coef = coTimeMin / 60;
                if (coef > 0.000001) dayTimeTerms.push(`${fmt(coef)} b_${i}_${j}`);
            }
        }

        // 4. Daily Capacity (Cannot exceed daily material supply/capacity)
        if (dayCapTerms.length > 0) {
            constraints.push(`c_cap_${j}: ${dayCapTerms.join(" + ")} <= ${fmt(maxCapacity)}`);
        }

        // 5. Operational Time (Cannot exceed available production time capacity)
        if (dayTimeTerms.length > 0) {
            constraints.push(`c_time_${j}: ${dayTimeTerms.join(" + ")} <= ${fmt(availTime)}`);
        }
    }

    // 6. End of Week Backorder (Must Fulfill all Orders by End of Week)
    for (let i = 0; i < productCount; i++) {
        constraints.push(`c_end_bo_${i}: bo_${i}_6 = 0`);
    }

    lp += constraints.join("\n") + "\n";
    if (binaryVars.length > 0) lp += "Binaries\n" + binaryVars.join("\n") + "\n";
    lp += "End\n";

    // ------------------------------------------------------------------------
    // PARSING SOLUTION RESULTS
    // ------------------------------------------------------------------------
    try {
        // Executing Solver on LP String
        const result = await solverInstance.solve(lp);
        const status = result?.Status || "Unknown";

        // Return Non-Optimal Schedule Error if Infeasible
        if (status !== "Optimal") {
            return { status: status, error: "Solver could not find an optimal schedule." };
        }

        // Initialize Results Structure
        const cols = result.Columns || {};
        const parsedDetails = products.map((p, idx) => {
            return {
                product: p.name,
                produced: [], sold: [], inventory: [], backorder: []
            };
        });

        // Extract Time-Series Data
        for (let j = 0; j < daysCount; j++) {
            for (let i = 0; i < productCount; i++) {
                const getVal = (key) => Math.round(cols[key]?.Primal || 0);
                parsedDetails[i].produced.push(getVal(`p_${i}_${j}`));
                parsedDetails[i].sold.push(getVal(`s_${i}_${j}`));
                parsedDetails[i].inventory.push(getVal(`inv_${i}_${j}`));
                parsedDetails[i].backorder.push(getVal(`bo_${i}_${j}`));
            }
        }

        // Return Optimal Solution Objective Value and Inventory Details
        return {
            status: 'Optimal',
            result: {
                objectiveValue: result.ObjectiveValue,
                details: parsedDetails
            }
        };

    } catch (e) {
        return { status: 'Error', error: e.message };
    }
}

// --- WORKER MESSAGE HANDLER ---
self.onmessage = async function (e) {
    const { type, data } = e.data;
    if (type === 'solve') {
        try {
            const output = await solveSteelProductionLP(data);
            if (output.status === 'Optimal') {
                self.postMessage({ type: 'result', status: 'Optimal', result: output.result });
            } else {
                self.postMessage({ type: 'error', error: output.error || output.status });
            }
        } catch (err) {
            self.postMessage({ type: 'error', error: err.message });
        }
    }
};
