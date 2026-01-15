/**==============================================================================
 * Orders Solver Worker - Markov Chain Inventory Optimizer
 * ==============================================================================
 * Description:
 * This Web Worker optimizes a Periodic Review Inventory System using
 * Discrete Time Markov Chains (DTMC).
 * * MATHEMATICAL MODEL:
 * 1. States: The number of trucks in inventory (0 to 15).
 * 2. Transitions: Defined by the policy (R, Q) and the Demand Distribution.
 * 3. Objective: Find the Steady State Probabilities (π) where πP = π.
 * 4. Cost Function: Calculate Expected Weekly Cost using π.
 * @author Joel Wood
 */

// ------------------------------------------------------------------------
// GLOBAL CONFIGURATION (Populated via Message Handler)
// ------------------------------------------------------------------------
let CONFIG = {
    DEMAND_DIST: [],
    PRICE_PER_TRUCK: 30000,
    COST_PER_TRUCK: 20000,
    FIXED_ORDER_COST: 2000,
    HOLDING_COST: 200,
    SHORTAGE_COST_TOTAL: 4000,
    MAX_CAPACITY: 15
};

/**Solves the system of linear equations to find Steady State Probabilities (π).
 * By finding vector π such that: πP = π  subject to the constraint: Σπ_i = 1
 * MATHEMATICAL DERIVATION:
 * 1. Start with Equilibrium Equation: πP = π
 * 2. Rearrange to homogenous form: πP - πI = 0  =>  π(P - I) = 0
 * 3. Transpose to solve as Ax = b (where x is column vector π^T): (P^T - I^T)π^T = 0
 * 4. Build matrix A = (P^T - I), then replace the last row of A with [1, ..., 1]
 *    and set the last element of b to 1 to enforce the constraint Σπ = 1.
 * @param {Array<Array<number>>} P - The Transition Matrix (n x n)
 * @returns {Array<number>} The steady state vector π where π[i] is prob of state i
 */
function solveSteadyState(P) {
    const n = P.length;
    // Initialize System Matrix A and Target Vector b
    let A = Array.from({ length: n }, () => Array(n).fill(0));
    let b = Array(n).fill(0);

    // Build A = P^T - I
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            if (i < n - 1) {
                // Transpose: A[i][j] takes value from P[j][i]
                // Subtract 1 from diagonal elements to subtract Identity Matrix
                A[i][j] = P[j][i] - (i === j ? 1 : 0);
            } else {
                // CONSTRAINT ROW: Replace the last equation with Σπ = 1
                A[i][j] = 1;
            }
        }
    }
    b[n - 1] = 1; // Target for constraint row

    // --- GAUSSIAN ELIMINATION WITH PARTIAL PIVOTING ---
    for (let i = 0; i < n; i++) {
        // 1. Pivot Selection: Find row k (where k >= i) with max absolute value in column i
        let maxRow = i;
        for (let k = i + 1; k < n; k++) {
            if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) {
                maxRow = k;
            }
        }

        // 2. Row Swapping: Move the best pivot to the current diagonal
        [A[i], A[maxRow]] = [A[maxRow], A[i]];
        [b[i], b[maxRow]] = [b[maxRow], b[i]];

        // 3. Normalization: Make the diagonal element 1
        const pivot = A[i][i];
        if (Math.abs(pivot) < 1e-12) continue;

        for (let j = i; j < n; j++) {
            A[i][j] /= pivot;
        }
        b[i] /= pivot;

        // 4. Elimination: Zero out this column in all other rows
        for (let k = 0; k < n; k++) {
            if (k !== i) {
                const factor = A[k][i];
                for (let j = i; j < n; j++) {
                    A[k][j] -= factor * A[i][j];
                }
                b[k] -= factor * b[i];
            }
        }
    }

    return b; // Vector π
}

/**Evaluates a specific inventory policy (R, Q), where R (Reorder Point) & Q (Target Level)
 * 1. Review Period: End of Sunday (State i).
 * 2. Ordering: If i < R, order placed Monday.
 * 3. Arrival: Wednesday Morning.
 * 4. Sales: Begin Wednesday.
 * Because the shop is closed Mon/Tue, the inventory level before any demand occurs in the
 * week is effectively the level *after* the order arrives.
 * @param {number} R - Reorder Point (Trigger order if Inv < R)
 * @param {number} TargetLevel_Q - The level we replenish up to (NOT the order quantity)
 */
function evaluatePolicy(R, TargetLevel_Q) {
    const nStates = CONFIG.MAX_CAPACITY + 1; // States 0..15
    let P = Array.from({ length: nStates }, () => Array(nStates).fill(0));

    // --- CONSTRUCT TRANSITION MATRIX ---
    for (let i = 0; i < nStates; i++) {
        // 'i' is the inventory at the end of the previous week (Sunday night).

        /**Determine 'startInv': The inventory available when doors open Wednesday.
         * If we are below R, we order enough to reach TargetLevel_Q.
         * If we are R or above, we do nothing, so we start with i.
         */
        const startInv = (i < R) ? TargetLevel_Q : i;

        // Apply Probabilistic Demand
        CONFIG.DEMAND_DIST.forEach(d => {
            /**End Inventory cannot be negative.
             * If Demand > StartInv, we stock out (0 inventory) and pay penalties,
             * but the physical state transitions to 0.
             */
            const endInv = Math.max(0, startInv - d.qty);

            // Add probability to the transition P[from_state][to_state]
            if (endInv < nStates) {
                P[i][endInv] += d.prob;
            }
        });
    }

    // --- SOLVE STEADY STATE PROBABILITIES ---
    // pi[i] is the long-run probability that the week ends with 'i' trucks.
    const pi = solveSteadyState(P);

    // --- CALCULATE EV (EXPECTED VALUE) ---
    // E[X] = Σ (Value(state) * Probability(state))
    let totalRevenue = 0, totalOrder = 0, totalHolding = 0, totalShortage = 0;

    for (let i = 0; i < nStates; i++) {
        const probState = pi[i];
        if (probState < 1e-9) continue; // Skip negligible probabilities

        // Ordering Cost Logic - Occurs if we triggered a reorder (State i < R)
        if (i < R) {
            const orderQty = TargetLevel_Q - i;
            const cost = CONFIG.FIXED_ORDER_COST + (orderQty * CONFIG.COST_PER_TRUCK);
            totalOrder += cost * probState;
        }

        // Determine Start Inventory for Sales Calculation
        const startInv = (i < R) ? TargetLevel_Q : i;

        // Find Exp Revenue/Holding/Shortage
        CONFIG.DEMAND_DIST.forEach(d => {
            const demand = d.qty;
            const probDemand = d.prob;

            // The joint probability of being in State i AND having Demand d
            const combinedProb = probState * probDemand;

            // Sales vs Shortage Calculation
            let sold = 0;
            let shortage = 0;

            if (demand <= startInv) {
                // Fully met demand
                sold = demand;
            } else {
                // Stockout scenario: Sell everything, record shortage
                sold = startInv;
                shortage = demand - startInv;
            }

            // End of Week Inventory (Basis for Holding Cost)
            const endInv = Math.max(0, startInv - demand);

            // Accumulate Weighted Costs
            totalRevenue += (sold * CONFIG.PRICE_PER_TRUCK) * combinedProb;
            totalShortage += (shortage * CONFIG.SHORTAGE_COST_TOTAL) * combinedProb;
            totalHolding += (endInv * CONFIG.HOLDING_COST) * combinedProb;
        });
    }

    return {
        R,
        Q: TargetLevel_Q,
        totalProfit: totalRevenue - totalOrder - totalHolding - totalShortage,
        steadyState: pi, // Required for Steady State Chart
        details: {
            expectedRevenue: totalRevenue,
            expectedOrderCost: totalOrder,
            expectedHoldingCost: totalHolding,
            expectedShortageCost: totalShortage
        }
    };
}

// ------------------------------------------------------------------------
// ITERATIVE OPTIMAL POLICY SOLVER
// ------------------------------------------------------------------------
// This function executes the main optimization loop.
// Evaluates all possible combinations of Target Level (Q) and Reorder Point (R)
// using brute force iterationto find the optimal policy.
// ------------------------------------------------------------------------
function solveInventoryProblem() {
    // Initialize variables
    let bestPolicy = null; // The policy with the highest profit
    let maxProfit = -Infinity; // The highest profit found so far
    let allPolicies = []; // The list of all evaluated policies

    /* Iterates over all possible values of Q (Target Level) from 2 to MAX_CAPACITY.
     * For each Q, iterate over all possible values of R (Reorder Point) from 1 to Q-1.
     */
    for (let Q = 2; Q <= CONFIG.MAX_CAPACITY; Q++) {
        for (let R = 1; R < Q; R++) {
            // Evaluate the profit of the current policy
            const result = evaluatePolicy(R, Q);

            // Store the result for Heatmap/Scatter plots
            allPolicies.push(result);

            // Update the best policy if the current policy is better
            if (result.totalProfit > maxProfit) {
                maxProfit = result.totalProfit;
                bestPolicy = result;
            }
        }
    }

    // Return the result
    return {
        optimalPolicy: bestPolicy, // The policy with the highest profit
        allPolicies: allPolicies // The list of all evaluated policies
    };
}

// ------------------------------------------------------------------------
// MESSAGE HANDLER
// ------------------------------------------------------------------------
// This function is the entry point for the web worker. It's invoked when the
// main thread sends a message to the worker. 
// ------------------------------------------------------------------------
self.onmessage = function (e) {
    try {
        // Extract the data from the message that the main thread sent.
        const data = e.data;

        /**Map the data to update the global CONFIG object with the following properties:
         * DEMAND_DIST: The demand distribution array (default: [])
         * PRICE_PER_TRUCK: The price per truck (default: 0)
         * COST_PER_TRUCK: The cost per truck (default: 0)
         * FIXED_ORDER_COST: The fixed order cost (default: 0)
         * HOLDING_COST: The holding cost per unit (default: 0)
         * SHORTAGE_COST_TOTAL: The total cost of a stockout (default: 0)
         * MAX_CAPACITY: The maximum capacity of the inventory (default: 15)
         */
        CONFIG = {
            DEMAND_DIST: data.demandDist || [],
            PRICE_PER_TRUCK: data.pricePerItem || 0,
            COST_PER_TRUCK: data.costPerItem || 0,
            FIXED_ORDER_COST: data.fixedOrderCost || 0,
            HOLDING_COST: data.holdingCost || 0,
            SHORTAGE_COST_TOTAL: (data.specialOrderCost || 0) + (data.penaltyCost || 0),
            MAX_CAPACITY: data.maxCapacity || 15
        };

        // Run the optimization to find the best policy and all policies.
        const results = solveInventoryProblem();

        // Post a policies message back to the main thread with the result data.
        self.postMessage({
            status: 'Optimal',
            result: results
        });
    } catch (err) {
        // If an error occurs, post a message back to the main thread with the error message.
        self.postMessage({
            status: 'Error',
            error: err.message
        });
    }
};
