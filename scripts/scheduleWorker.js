/**==============================================================================
 * Highs Solver Worker - Strategic Workforce Optimizer (Contiguous Flow)
 * ==============================================================================
 * Description:
 * This Web Worker implements a Mixed-Integer Linear Program (MILP) for
 * multi-skill workforce scheduling of Employees across a single week.
 * It uses a "Flow-Based" contiguity logic rather than a standard set-covering.
 * Instead of selecting pre-defined shifts, it calculates the start and end time
 * of a shift dynamically using continuous variables bound by binary activation.
 * To ensure feasibility without memory overflow, it similarly ties continuous
 * skill assignments to binary shifts, minimizing branch-and-bound explosions.
 * CPLEX Formatting: http://web.mit.edu/lpsolve/doc/CPLEX-format.htm
 * HiGHs Controls: https://dev.ampl.com/solvers/highs/options.html
 * * @author Joel Wood
 */

// Worker State Variables
let highsModulePromise = null;
let highsModule = null;

/** Initialize Highs Module:
 * Attempts to load the WebAssembly solver from libs/highs.js
 * 512MB is allocated as a safe compatibility buffer.
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
 * Converts numbers to CPLEX-compatible strings, trimming small floats
 * to avoid numerical instability in the sparse matrix.
 */
function fmt(num) {
    const n = parseFloat(num);
    return (!Number.isFinite(n) || Math.abs(n) < 1e-8) ? "0" : n.toFixed(4);
}

// ============================================================================
// HEURISTIC SMOOTHER (Post-Solver)
// ============================================================================
/**
 * The MILP guarantees that the right number of the right people are working.
 * This function optimizes which specific skill they are tagged with to smooth
 * scheduling--ensuring surplus labor is spread as even as possible.
 * This is computationally light and exactness is not critical for smoothness
 * So it is best handled post-solve, rather than increasing the complexity of
 * the financially motivated LP Solver.
 */
function smoothSkillAllocation(roster, demands, skillNames) {
    const demandMap = {};
    demands.forEach(d => {
        const t = d.day * 24 + d.hour;
        demandMap[t] = {};
        skillNames.forEach(s => demandMap[t][s] = parseFloat(d[s]) || 0);
    });

    return roster.map(emp => {
        const newSchedule = [...emp.schedule];
        const mySkills = (emp.skills || []).map(s => s.trim());

        for (let t = 0; t < 168; t++) {
            if (!newSchedule[t]) continue; // Not working

            const currentRole = newSchedule[t];
            const d = demandMap[t] || {};

            // If current role has 0 demand, switch to High Demand skills.
            if ((d[currentRole] || 0) < 1) {
                let bestSkill = currentRole;
                let maxD = 0;
                mySkills.forEach(s => {
                    if ((d[s] || 0) > maxD) {
                        maxD = d[s];
                        bestSkill = s;
                    }
                });
                newSchedule[t] = bestSkill;
            }
        }
        return { ...emp, schedule: newSchedule };
    });
}

// ============================================================================
// BUILD LP STRING & SOLVE
// ============================================================================
async function solveSchedulingMILP(params) {
    if (!highsModule) await highsModulePromise;

    const { employees, demands, preferedEmployees } = params;
    const skillNames = ["Cashiers", "Stocking", "Customer Service", "BackRoom", "Floor Associate"];

    // Workforce Cap: Hard limit on total unique employees scheduled
    const preferredCount = parseInt(preferedEmployees) || employees.length;

    console.log(`--- SYSTEM: OPTIMIZING (Integrated Continuous Assignment) ---`);

    // ============================================================================
    // DATA PRE-PROCESSING
    // ============================================================================
    
    // Float32Array is ideal for large sparse matrices
    const validHours = new Set();
    const skillDemandAtT = Array.from({ length: 168 }, () => new Float32Array(skillNames.length));
    // Identify hours where there is demand, Variables outside these hours are pruned.
    demands.forEach(d => {
        const t = d.day * 24 + d.hour;
        let globalD = 0;
        skillNames.forEach((s, i) => {
            const val = parseFloat(d[s]) || 0;
            if (val > 0) {
                skillDemandAtT[t][i] = val;
                globalD += val;
            }
        });
        if (globalD > 0) validHours.add(t);
    });

    // Constants & Penalties
    const DEMAND_PENALTY = 500; // per hour of missing customer demand
    const MIN_HR_PENALTY = 500; // if employee misses min-hours guarantee

    let objTerms = [];
    let constraints = [];
    let binaries = new Set();
    let continuous = [];

    // Tracker for Demand Constraints (LHS of equation)
    const demandConstraintLHS = Array.from({ length: 168 }, () => skillNames.map(() => []));

    // ============================================================================
    // EMPLOYEE MODELING
    // ============================================================================
    employees.forEach((emp, eIdx) => {
        const base = parseFloat(emp.pay) || 20;
        const maxH = parseFloat(emp.maxHrs) || 40;
        const minH = parseFloat(emp.minHrs) || 0;
        const maxOT = 20;

        // Skill Mapping: Convert string skills to indices
        const mySkills = (emp.skills || []).map(s => s.trim());
        const mySkillIndices = mySkills.map(s => skillNames.indexOf(s)).filter(i => i !== -1);

        /**============================================================================
         * PAYROLL VARIABLES
         * ============================================================================
         * reg: Regular hours worked (up to the employee's max, or 40)
         * ot:  Overtime hours (up to 20 hours above the regular max)
         * s_min: Slack variable for minimum hours
         */
        continuous.push(`reg_${eIdx}`, `ot_${eIdx}`, `s_min_${eIdx}`);
        objTerms.push(
            `${fmt(base)} reg_${eIdx}`,
            `${fmt(base * 1.5)} ot_${eIdx}`,
            `${fmt(MIN_HR_PENALTY)} s_min_${eIdx}`
        );

        let empAllY = [];
        let empDailyActive = [];

        // Loop Days (0-6)
        for (let d = 0; d < 7; d++) {
            // Prune Availability: Intersect Employee Availability with Store Hours
            const avail = (emp.availability[d] || [])
                .map(Number)
                .filter(h => validHours.has(d * 24 + h))
                .sort((a, b) => a - b);

            if (avail.length === 0) continue;

            // Bounds for Continuous Vars based on availability
            const earliest = avail[0];
            const latest = avail[avail.length - 1];

            /**============================================================================
             * DAILY BLOCK VARIABLES
             * ============================================================================
             * da: Day Active (Binary) - 1 if employee works at all this day.
             * start: Continuous (0-24) - The start hour of the shift.
             * end: Continuous (0-24) - The end hour of the shift.
             */
            const da = `da_${eIdx}_${d}`;
            const startVal = `start_e${eIdx}_d${d}`;
            const endVal = `end_e${eIdx}_d${d}`;

            binaries.add(da);
            continuous.push(startVal, endVal);

            /**============================================================================
             * CONTIGUITY OBJECTIVE FUNCTION (The Gap Penalty)
             * ============================================================================
             * Goal: Penalize gaps in schedule; Penalty = Cost * (Span - Hours_Worked).
             * Logic: A perfect shift has Span == Hours Worked, where Span = (End - Start)
             * If Span > Sum(y), the Objective Value is penalized more than paying for work
             * This forces the solver to group 'y' variables tightly between Start/End, 
             * without needing to add excessive binaries or constraints.  The objective
             * function will innately prioritize clusters.
             */
            const GAP_PENALTY = base * 2.0; // Double the wage cost for each gap hour

            objTerms.push(
                `${fmt(GAP_PENALTY)} ${endVal}`,
                `-${fmt(GAP_PENALTY)} ${startVal}`,
                `${fmt(GAP_PENALTY)} ${da}` // Base cost for turning on a day
            );

            // Bounds Logic: If da=0, Start/End must be 0.
            constraints.push(` b_min_${eIdx}_d${d}: ${startVal} - ${earliest} ${da} >= 0`);
            constraints.push(` b_max_${eIdx}_d${d}: ${endVal} - ${latest} ${da} <= 0`);
            constraints.push(` z_s_${eIdx}_d${d}: ${startVal} - 24 ${da} <= 0`);
            constraints.push(` z_e_${eIdx}_d${d}: ${endVal} - 24 ${da} <= 0`);
            
            // Loop Hours in Day
            const dayY = [];
            avail.forEach(h => {
                const t = d * 24 + h;
                const y = `y_${eIdx}_${t}`;
                binaries.add(y);
                dayY.push(y);
                empAllY.push(y);
                // Credit the penalty for every hour worked (Part of Contiguity Logic)
                objTerms.push(`-${fmt(GAP_PENALTY)} ${y}`);

                /**============================================================================
                 * SHIFT SPAN CONSTRAINTS
                 * ============================================================================
                 * 1. Start Constraint: Start <= h (if working) - Eq: Start + 24*y <= h + 24
                 * If y=1: Start <= h; If y=0: Start <= h + 24
                 * * 2. End Constraint: End >= h (if working) - Eq: End - h*y >= 0
                 * If y=1: End >= h; If y=0: End >= 0 
                 */
                constraints.push(` s_set_${eIdx}_${t}: ${startVal} + 24 ${y} <= ${h + 24}`);
                constraints.push(` e_set_${eIdx}_${t}: ${endVal} - ${h} ${y} >= 0`);

                /**============================================================================
                 * ASSIGNMENT VARIABLES (Continuous Relaxation)
                 * ============================================================================
                 * CONSTRAINT: Sum(w) - y = 0, where w: Assignment Variables (0.0 - 1.0).
                 * These are assigned as continuous to minimize binaries in our model, which
                 * will help reduce the complexity of branch and bound. Since 'y' is binary, 
                 * 'w' is forced to sum to 0 or 1. This effectively makes 'w' behave like a 
                 * binary decision variable without the computational cost of branching on it.
                 */
                const validWs = [];

                mySkillIndices.forEach(sIdx => {
                    // Only generate assignment variable if Demand > 0
                    if (skillDemandAtT[t][sIdx] > 0) {
                        const w = `w_${eIdx}_${t}_${sIdx}`;
                        continuous.push(w);
                        demandConstraintLHS[t][sIdx].push(w);
                        validWs.push(w);

                        // Upper Bound Help: w <= y
                        constraints.push(` w_bnd_${eIdx}_${t}_${sIdx}: ${w} - ${y} <= 0`);
                    }
                });

                if (validWs.length > 0) {
                    // Strict Link: You must be assigned to a skill if you are working (y=1)
                    constraints.push(` lnk_w_${eIdx}_${t}: ${validWs.join(" + ")} - ${y} = 0`);
                } else {
                    // If no demand exists for your skills, you cannot work.
                    constraints.push(` no_dem_${eIdx}_${t}: ${y} = 0`);
                }
            });

            // Link Day Active (da) to Hourly Active (y)
            if (dayY.length > 0) {
                constraints.push(` set_da_${eIdx}_d${d}: ${dayY.join(" + ")} - 24 ${da} <= 0`);
                empDailyActive.push(da);
            }
        }

        // WEEKLY BALANCING CONSTRAINTS
        const workSum = empAllY.length > 0 ? empAllY.join(" + ") : "0";
        constraints.push(` bal_${eIdx}: ${workSum} - reg_${eIdx} - ot_${eIdx} = 0`);
        constraints.push(` max_${eIdx}: reg_${eIdx} <= ${fmt(maxH)}`);
        constraints.push(` min_${eIdx}: reg_${eIdx} + ot_${eIdx} + s_min_${eIdx} >= ${fmt(minH)}`);
        constraints.push(` ot_${eIdx}: ot_${eIdx} <= ${fmt(maxOT)}`);

        // Global Active Link (for Workforce Cap)
        const u = `uEmp_${eIdx}`;
        binaries.add(u);
        empDailyActive.forEach(da => constraints.push(` lnk_u_${eIdx}_${da}: ${da} - ${u} <= 0`));
    });

    /**============================================================================
     * DEMAND SATISFACTION
     * ============================================================================
     * Equation: Sum(w_assigned_to_skill) + Slack >= Demand
     * The sum of assigned skills must be greater than or equal to the demand; it is
     * acceptable to exceed demand level--although suboptimal from a cost perspective.
     */
    validHours.forEach(t => {
        skillNames.forEach((_, sIdx) => {
            const req = skillDemandAtT[t][sIdx];
            if (req > 0) {
                const slack = `s_dem_${sIdx}_${t}`;
                continuous.push(slack);
                // Penalty for missing demand
                objTerms.push(`${fmt(DEMAND_PENALTY)} ${slack}`);

                const workers = demandConstraintLHS[t][sIdx];
                const lhs = workers.length > 0 ? workers.join(" + ") : "0";
                constraints.push(` dem_${sIdx}_${t}: ${lhs} + ${slack} >= ${fmt(req)}`);
            }
        });
    });

    // Workforce Cap Constraint
    const allU = employees.map((_, i) => `uEmp_${i}`);
    constraints.push(` wf_cap: ${allU.join(" + ")} <= ${fmt(pre)}`);

    // ============================================================================
    // SOLVE EXECUTION
    // ============================================================================
    const lpString = [
        "Minimize", " obj: " + objTerms.join(" + "),
        "Subject To", ...constraints,
        "Binaries", Array.from(binaries).join("\n"),
        "Bounds", continuous.map(c => `${c} >= 0`).join("\n"),
        "End"
    ].join("\n");

    console.log(`--- MODEL STATS: ${binaries.size} Binaries, ${constraints.length} Constraints ---`);

    console.time("SolverDuration");
    try {
        const result = highsModule.solve(lpString, {
            time_limit: 300, // 5 minute time limit for the solver
            presolve: 'on', // Critical for removing redundant constraints
            mip_rel_gap: 0.05 // 5% tolerance for optimiality gap
        });
        console.timeEnd("SolverDuration");

        if (!result.Columns) {
            console.error("Solver Failed", result.Status);
            return { status: result.Status };
        }

        // ============================================================================
        // POST-PROCESSING & REPORTING
        // ============================================================================

        // Reconstruct Roster from Solver Output
        let rawRoster = employees.map((emp, eIdx) => {
            let schedule = Array(168).fill(null);
            for (let t = 0; t < 168; t++) {
                if (result.Columns[`y_${eIdx}_${t}`]?.Primal > 0.5) {
                    // Identify assigned skill from continuous 'w' variables
                    let assignedRole = "Assigned";
                    let maxVal = 0;
                    skillNames.forEach((s, sIdx) => {
                        const val = result.Columns[`w_${eIdx}_${t}_${sIdx}`]?.Primal || 0;
                        if (val > 0.5) {
                            assignedRole = s;
                        } else if (val > maxVal) {
                            maxVal = val;
                            if (val > 0.1) assignedRole = s;
                        }
                    });
                    schedule[t] = assignedRole;
                }
            }
            return {
                id: emp.id,
                skills: emp.skills,
                pay: parseFloat(emp.pay) || 15,
                schedule,
                regHrs: result.Columns[`reg_${eIdx}`]?.Primal || 0,
                otHrs: result.Columns[`ot_${eIdx}`]?.Primal || 0
            };
        });

        // Run Heuristic Smoother (Cleanup)
        const finalRoster = smoothSkillAllocation(rawRoster, demands, skillNames);

        // Calculate Financials (Objective Function is skewed by penalties)
        let totalWages = 0;
        let totalOT = 0;
        finalRoster.forEach(emp => {
            totalWages += (emp.regHrs * emp.pay);
            totalOT += (emp.otHrs * emp.pay * 1.5);
        });

        // Generate Console Output
        console.log("%c--- FINANCIAL SUMMARY ---", "color: #0b8f0bff; font-weight: bold;");
        console.table({
            "Solver Objective (Abstract)": { Value: result.ObjectiveValue.toFixed(2) },
            "Real Regular Wages": { Value: `$${totalWages.toLocaleString()}` },
            "Real Overtime Wages": { Value: `$${totalOT.toLocaleString()}` },
            "TOTAL ESTIMATED COST": { Value: `$${(totalWages + totalOT).toLocaleString()}` }
        });

        return {
            status: 'Optimal',
            result: {
                roster: finalRoster,
                objective: result.ObjectiveValue, // Abstract Score
                actualLaborCost: (totalWages + totalOT).toFixed(2) // Real Labor Costs
            }
        };

    } catch (e) {
        console.error("Solver Error:", e);
        return { status: 'Error', error: e.message };
    }
}

// ------------------------------------------------------------------------
// MESSAGE HANDLER
// ------------------------------------------------------------------------
self.onmessage = async (e) => {
    if (e.data.type === 'solve') {
        const output = await solveSchedulingMILP(e.data.data);
        self.postMessage({ type: 'result', ...output });
    }
};