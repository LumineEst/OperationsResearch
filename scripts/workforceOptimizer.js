/**============================================================================
 * WORKFORCE OPTIMIZER - PARALLEL GSS ORCHESTRATOR
 * ============================================================================
 * Description:
 * This class orchestrates a parallelized "Golden Section Search" (GSS) to find
 * the optimal headcount for a workforce schedule, using two solver workers.
 * It treats the headcount selection as a convex optimization problem on a 1D
 * line (Number of Employees). It uses a hybrid of Golden Section and Bisection
 * * 1. MANDATORY PIVOTS (Binary): It calculates the two standard Golden Ratio
 * points (C and D) required to guarantee the search bracket shrinks safely.
 * * 2. SPECULATIVE PRUNE (Trinary): If a worker thread is free (because one of
 * the mandatory points was already cached), it speculatively calculates the
 * Midpoint (M).
 * * 3. BRACKET REDUCTION: If the Speculative Midpoint (M) is calculated and
 * turns out to be the best value, the algorithm performs a "Double Shrink,"
 * reducing the search bracket by ~50% in one step, rather than the standard
 * ~38% of a binary GSS.
 * * @author Joel Wood
 */

// Attach to window to ensure global visibility across modules
window.WorkforceOptimizer = class WorkforceOptimizer {
    /**
     * @param {string} workerScriptPath - Path to the worker file (e.g. 'scripts/scheduleWorker.js')
     * @param {number} numWorkers - Number of parallel threads (Default: 2)
     */
    constructor(workerScriptPath, numWorkers = 2) {
        this.workerPath = workerScriptPath;
        this.poolSize = numWorkers;
        this.workers = []; // Array of Worker objects
        this.cache = new Map(); // Stores results { headcount -> { cost, result } }
    }

    /**Initialize the worker pool.
     * Terminates any existing workers to ensure a fresh state.
     */
    async init() {
        this.terminate();
        for (let i = 0; i < this.poolSize; i++) {
            this.workers.push(new Worker(this.workerPath));
        }
    }

    /**Terminate all active workers and clear internal cache.
     * Must be called after optimization completes to free system resources.
     */
    terminate() {
        this.workers.forEach(w => w.terminate());
        this.workers = [];
        this.cache.clear();
    }

    /**Helper: Dispatch a solve task to a specific worker index.
     * Wraps the Worker 'onmessage' event in a Promise for async/await usage.
     * This ensures that both workers return their pivot results before a new
     * bracket is calculated.
     * @param {number} workerIdx - Index of the worker in this.workers[]
     * @param {object} params - The full scheduling parameters (Demands, Employees)
     * @param {number} n - The specific headcount to solve for
     * @param {function} onProgress - Callback for UI updates
     * @returns {Promise<object>} - Resolves with the cost and full result object
     */
    runWorker(workerIdx, params, n, onProgress) {
        return new Promise((resolve) => {
            const w = this.workers[workerIdx];
            const handleMsg = (e) => {
                const { type, result, status } = e.data;

                // Only listen for the final result
                if (type === 'result') {
                    w.removeEventListener('message', handleMsg);
                    const data = {
                        headcount: n,
                        // If solver failed/timed out, treat as Infinite cost to discourage selection
                        cost: (status === 'Error' ? Infinity : parseFloat(result.actualLaborCost)),
                        result: (status === 'Error' ? null : result)
                    };
                    // Cache the result immediately
                    this.cache.set(n, data);
                    // Fire UI callback if provided
                    if (onProgress) onProgress(data);
                    resolve(data);
                }
            };

            w.addEventListener('message', handleMsg);
            // Send the task to the worker
            w.postMessage({
                type: 'solve',
                data: { ...params, preferredEmployees: n },
            });
        });
    }

    /**MAIN OPTIMIZATION ROUTINE: "Hedged Golden Section Search"
     * @param {object} params - Scheduling constraints and data
     * @param {function} onProgress - Optional callback to render live table results
     * @returns {object} The optimal schedule solution object
     */
    async findOptimalHeadcount(params, onProgress) {
        await this.init();

        // --------------------------------------------------------------------
        // SETUP & BOUNDS
        // --------------------------------------------------------------------
        // The Golden Ratio (Phi)
        const PHI = (1 + Math.sqrt(5)) / 2;

        // Calculate heuristic bounds based on demand to narrow the search space
        let totalDemand = 0;
        const skills = ["Cashiers", "Stocking", "Customer Service", "BackRoom", "Floor Associate"];
        params.demands.forEach(d => skills.forEach(s => totalDemand += parseFloat(d[s] || 0)));

        // Calculate Average Employee Capacity Hours
        let sumMaxHrs = 0;
        const validEmps = params.employees.length > 0 ? params.employees.length : 1;
        params.employees.forEach(e => {
            sumMaxHrs += (parseFloat(e.maxHours) || 40);
        });

        const avgMaxHrs = sumMaxHrs / validEmps;

        // Conservative Bounds: 
        // Lower: ~Avg Max Hours w/o  (High utilization)
        // Upper: ~25 hrs/emp (Low utilization)
        let a = Math.floor(3 * totalDemand / (2 * avgMaxHrs + 40));                        // Lower Bound
        let b = Math.ceil(totalDemand / 25);                                // Upper Bound

        console.log(`%c--- STARTING HEDGED GSS [${a}, ${b}] ---`, "color: #e74c3c; font-weight: bold;");

        // --------------------------------------------------------------------
        // SEARCH LOOP
        // --------------------------------------------------------------------
        // Continue shrinking until the bracket is small enough (<= 2 integers wide)
        while ((b - a) > 2) {

            // --- CALCULATE MANDATORY PIVOTS (Global Section Search) ---
            // These points maintain the strict geometric ratio needed for GSS convergence.
            let c = Math.round(b - (b - a) / PHI);
            let d = Math.round(a + (b - a) / PHI);
            // Integer Safety: Ensure C and D are distinct and inside bounds
            if (c === d) c = Math.max(a, c - 1);
            if (d === c) d = Math.min(b, d + 1);
            // Determine Workload
            const tasks = [];
            if (!this.cache.has(c)) tasks.push(c);
            if (!this.cache.has(d) && d !== c) tasks.push(d);

            // The Midpoint of [c, d]
            let m = Math.round((c + d) / 2);
            // the Golden Section of [a, d]
            let specL = Math.round(a + (d - a) * (2 - PHI));
            // the Golden Section of [c, b]
            let specR = Math.round(c + (b - c) * (PHI - 1));

            // --- SPECULATIVE "HEDGE" (Bisection) ---
            // If we have a free worker (i.e., one pivot was already cached from previous step),
            // we use the spare capacity to check the Midpoint or speculative golden sections.
            if (tasks.length < this.poolSize) {
                // Try Midpoint 
                if (m > c && m < d && !this.cache.has(m)) {
                    console.log(`   >> Free Worker. Hedging with Gap Fill: ${m}`);
                    tasks.push(m);
                }
                else {
                    // Add whichever residual Golden Section is valid and unknown
                    if (specL > a && specL < d && !this.cache.has(specL) && !tasks.includes(specL)) {
                        console.log(`   >> Free Worker. Speculating Left (Next-Gen): ${specL}`);
                        tasks.push(specL);
                    }
                    else if (specR > c && specR < b && !this.cache.has(specR) && !tasks.includes(specR)) {
                        console.log(`   >> Free Worker. Speculating Right (Next-Gen): ${specR}`);
                        tasks.push(specR);
                    }
                }
            }

            // --- PARALLEL EXECUTION ---
            if (tasks.length > 0) {
                // Ensure we don't exceed pool size
                const activeTasks = tasks.slice(0, this.poolSize);
                console.log(` Bracket: [${a}, ${b}] | Solving: ${activeTasks.join(", ")}`);

                // Map tasks to workers using modular arithmetic
                const promises = activeTasks.map((n, idx) =>
                    this.runWorker(idx % this.poolSize, params, n, onProgress)
                );

                // Wait for all active tasks to finish, before continuing
                await Promise.all(promises);
            }

            // --- BRACKET UPDATE ---
            // Retrieve results (guaranteed to exist now)
            const rC = this.cache.get(c);
            const rD = this.cache.get(d);
            const rM = (m !== null) ? this.cache.get(m) : null;
            // Use Infinity for failed/missing values to naturally disqualify them
            const cCost = rC ? rC.cost : Infinity;
            const dCost = rD ? rD.cost : Infinity;
            const mCost = rM ? rM.cost : Infinity;
            console.log(` Results: C:${c}($${cCost}) ${m ? `M:${m}($${mCost}) ` : ''}D:${d}($${dCost})`);

            if (rM) {
                // --- TRINARY LOGIC (We have 3 points: C, M, D) ---
                if (cCost < mCost && cCost < dCost) {
                    // Peak is Left of M. 
                    // Standard GSS would shrink to [A, D]. We can aggressively shrink to [A, M].
                    console.log(" >> Left Winner. Shrink to [A, M]");
                    b = m;
                } else if (dCost < mCost && dCost < cCost) {
                    // Peak is Right of M.
                    // Standard GSS would shrink to [C, B]. We can aggressively shrink to [M, B].
                    console.log(" >> Right Winner. Shrink to [M, B]");
                    a = m;
                } else {
                    // M is the best (The Valley). The optimal point is between C and D.
                    // We squeeze both sides simultaneously.
                    console.log(" >> Midpoint Winner, Shrink to [C, D]");
                    a = c;
                    b = d;
                }
            } else {
                // --- BINARY LOGIC (Standard GSS fallback) ---
                if (cCost < dCost) {
                    b = d; // Pivot Left
                } else {
                    a = c; // Pivot Right
                }
            }
        }

        // --------------------------------------------------------------------
        // FINAL SCAN
        // --------------------------------------------------------------------
        // The GSS narrows to a small integer range. 
        // We now check every integer in this range to ensure we didn't miss the exact peak due to rounding.
        console.log(`%c--- FINAL SCAN [${a}, ${b}] ---`, "color: #2980b9; font-weight: bold;");
        const candidates = [];
        for (let i = a; i <= b; i++) candidates.push(i);
        // Solve any stragglers in the final bracket
        const unknowns = candidates.filter(n => !this.cache.has(n));
        if (unknowns.length > 0) {
            await Promise.all(unknowns.map((n, idx) =>
                this.runWorker(idx % this.poolSize, params, n, onProgress)
            ));
        }

        // --------------------------------------------------------------------
        // SELECT WINNER
        // --------------------------------------------------------------------
        let bestN = a;
        let minCost = Infinity;
        let bestObj = null;

        // Iterate over candidates to find absolute minimum
        candidates.forEach(n => {
            const r = this.cache.get(n);
            if (r && r.cost < minCost) {
                minCost = r.cost;
                bestN = n;
                bestObj = r;
            }
        });

        console.log(`%c--- WINNER: ${bestN} ($${minCost}) ---`, "color: green; font-weight: bold;");
        // Tiny delay to allow final console logs from workers to flush to DevTools
        await new Promise(r => setTimeout(r, 100));
        this.terminate();
        // Return the full result object, augmented with the optimal headcount
        return { ...bestObj.result, optimalHeadcount: bestN };
    }
}