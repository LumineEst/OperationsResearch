/**
 * --------------------------------------------------------------------
 * Highs Solver Worker - Steel Production Optimization
 * --------------------------------------------------------------------
 */

// Worker State Variables
let highsScriptLoaded = false;
let highsScriptError = null;
let highsLoaderFunction = null;
let highsInstancePromise = null;

// Attempt to load the HiGHS solver script from libs/highs.js
try {
    importScripts('libs/highs.js');
    highsLoaderFunction = Module;
    highsScriptLoaded = true;
} catch (error) {
    highsScriptError = `Failed to import script 'libs/highs.js': ${error.message}`;
    console.error("WORKER: CRITICAL -", highsScriptError, error);
}

// --- ASYNC SOLVER LOADER ---

async function getSolverInstance() {
    if (!highsScriptLoaded || !highsLoaderFunction) {
        throw new Error(highsScriptError || "HiGHS script did not load or define loader.");
    }
    if (!highsInstancePromise) {
        // Setting WebAssembly Memory and Location Allocations
        const wasmPath = 'libs/';
        const memoryMB = 512;
        const initialMemory = memoryMB * 1024 * 1024;
        highsInstancePromise = highsLoaderFunction({
            locateFile: (filename) => wasmPath + filename,
            initialMemory: initialMemory
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

// --- STEEL ALLOCATION LP LOGIC ---

async function solveSteelProductionLP(params) {
    
    // Initialize Solver and Parameters
    let solverInstance;
    try {
        solverInstance = await getSolverInstance();
    } catch (error) {
        return { status: 'Error', error: "Could not load solver: " + error.message };
    }

    const { products, rawSteelCost, invCost, maxCapacity, backorderPenalty } = params;
    const daysCount = 7;
    const productCount = products.length;

    // --- LP STRING GENERATION (CPLEX) ---
    
    /** 
    * Variables:
    * p_i_j : Produced product i on day j
    * s_i_j : Sold product i on day j
    * inv_i_j : Inventory of i at end of day j
    * bo_i_j : Backorder of i at end of day j
    */

    let lp = "Maximize\n obj: ";
    let objTerms = [];

    // Objective Function - Maximize Profitability
    for (let i = 0; i < productCount; i++) {
        for (let j = 0; j < daysCount; j++) {
            const p = products[i];

            // + Revenue
            objTerms.push(`${p.sell} s_${i}_${j}`);

            // - Inventory Cost
            objTerms.push(`-${invCost} inv_${i}_${j}`);

            // - Backorder Cost
            objTerms.push(`-${((backorderPenalty/100) * p.sell).toFixed(2)} bo_${i}_${j}`);

            // - Production Cost
            objTerms.push(`-${rawSteelCost + p.cost} p_${i}_${j}`);
        }
    }

    // Join terms and format for CPLEX
    lp += objTerms.join(" + ").replace(/\+ -/g, "- ") + "\n";
    lp += "Subject To\n";

    // Constraint 1. Demand Cap: Sold <= Demand (Cannot Sell more than Demand)
    for (let i = 0; i < productCount; i++) {
        for (let j = 0; j < daysCount; j++) {
            lp += ` c_dem_${i}_${j}: s_${i}_${j} <= ${products[i].demand[j]}\n`;
        }
    }

    /** Constraint 2. Inventory Balance Equation (Inventory Balance must be maintained)
    * PreviousInv + Production + CurrentBackorder = Sold + CurrentInv + PreviousBackorder
    * Rearranged: p_i_j - s_i_j - inv_i_j + bo_i_j + inv_i_{j-1} - bo_i_{j-1} = 0
    */

    for (let i = 0; i < productCount; i++) {
        for (let j = 0; j < daysCount; j++) {
            
            // Base variables for current day
            let terms = [`p_${i}_${j}`, `- s_${i}_${j}`, `- inv_${i}_${j}`, `bo_${i}_${j}`];

            // Add previous day variables if not Day 0
            if (j > 0) {
                terms.push(`inv_${i}_${j - 1}`); // Prior Supply
                terms.push(`- bo_${i}_${j - 1}`); // Prior Demand (Backlog)
            }

            lp += ` c_bal_${i}_${j}: ${terms.join(" + ").replace(/\+ -/g, "- ")} = 0\n`;
        }
    }

    // Constraint 3. Daily Production Capacity (Production cannot Exceed Material Capacity)
    for (let j = 0; j < daysCount; j++) {
        let dailyProds = [];
        for (let i = 0; i < productCount; i++) {
            dailyProds.push(`p_${i}_${j}`);
        }
        // Sum(p_i_j) <= maxCapacity
        lp += ` c_cap_${j}: ${dailyProds.join(" + ")} <= ${maxCapacity}\n`;
    }

    // Constraint 4. End of Week Backorder Constraint (No End of Week Backlog)
    for (let i = 0; i < productCount; i++) {
        lp += ` c_end_bo_${i}: bo_${i}_6 = 0\n`;
    }

    lp += "Bounds\n";
    lp += "End\n";

    // --- SOLVE LP PROBLEM ---
    try {
        const result = await solverInstance.solve(lp);
        const status = result?.Status || "Unknown";

        if (status !== "Optimal") {
            return { status: status, error: "Solver did not find an optimal solution." };
        }

        // --- PARSE SOLUTION RESULTS ---
        const cols = result.Columns || {};
        const parsedDetails = products.map((p, idx) => {
            return {
                product: p.name,
                produced: [],
                sold: [],
                inventory: [],
                backorder: []
            };
        });

        // Extract values from columns
        for (let j = 0; j < daysCount; j++) {
            for (let i = 0; i < productCount; i++) {
                // Lambda to safely get value or 0
                const getVal = (key) => Math.round(cols[key]?.Primal || 0);
                parsedDetails[i].produced.push(getVal(`p_${i}_${j}`));
                parsedDetails[i].sold.push(getVal(`s_${i}_${j}`));
                parsedDetails[i].inventory.push(getVal(`inv_${i}_${j}`));
                parsedDetails[i].backorder.push(getVal(`bo_${i}_${j}`));
            }
        }

        return {
            status: 'Optimal',
            result: {
                objectiveValue: result.ObjectiveValue,
                details: parsedDetails
            }
        };

    } catch (e) {
        console.error("Solver Execution Error", e);
        return { status: 'Error', error: e.message };
    }
}

// --- MESSAGE HANDLER ---
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
