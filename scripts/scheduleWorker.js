/**==============================================================================
 * Highs Solver Worker - Strategic Workforce Optimizer (Contiguous Flow)
 * ==============================================================================
 * Description:
 * This Web Worker implements a Mixed-Integer Linear Program (MILP) for
 * multi-skill workforce scheduling of Employees across a single week.
 * It uses a Flow-Based contiguity logic rather than a standard set-covering.
 * Instead of selecting pre-defined shifts, it calculates the start and end time
 * of a shift dynamically using continuous variables bound by binary activation.
 * To ensure feasibility without memory overflow, it similarly ties continuous
 * skill assignments to binary shifts, minimizing branch-and-bound explosions.
 * Blocking is incentivized within the objective function, and not as a direct
 * constraint; which means that tighter schedules may result in a loosening of
 * the blocking behavior to meet constraints.  A smoothing Heuristic is used to
 * reallocate skill assignments to balance overstaffing of skill-groups.  This
 * is then repassed through the solver a second time with feasibility weights
 * helping to get a solution that is more optimal than the original pass.
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
    // Build Demand Map
    const demandMap = {};
    demands.forEach(d => {
        const t = d.day * 24 + d.hour;
        if (!demandMap[t]) demandMap[t] = {};
        skillNames.forEach(s => demandMap[t][s] = parseFloat(d[s]) || 0);
    });

    // Helper Function to get live supply count
    const getSupply = (t, skill) => roster.filter(e => e.schedule[t] === skill).length;

    // Helper Function to calculate a Utility Score (using Exponential Decay)
    const getUtility = (buffer) => {
        // If buffer is negative (shortage), utility is Massive.
        if (buffer < 0) return 1000000;
        // High score for low buffer (0, 1). Low score for high buffer (5+).
        return 2000 * Math.exp(-0.5 * buffer);
    };

    // Process Each Employee
    roster.forEach(emp => {
        const mySkills = (emp.skills || []).map(s => s.trim());
        if (mySkills.length <= 1) return;
        // Do a Forward and Backward Pass to Distribute Skills
        const directions = [
            { start: 0, end: 168, step: 1 },    // Pass 1: Forward (0 -> 167)
            { start: 167, end: -1, step: -1 }   // Pass 2: Backward (167 -> 0)
        ];

        directions.forEach(pass => {
            for (let t = pass.start; t !== pass.end; t += pass.step) {
                if (!emp.schedule[t]) continue; // Not working
                const currentRole = emp.schedule[t];
                const d = demandMap[t] || {};
                // Surrounding Roles
                const prevRole = (t > 0) ? emp.schedule[t - 1] : null;
                const nextRole = (t < 167) ? emp.schedule[t + 1] : null;
                // Check baseline supply
                const curSupply = getSupply(t, currentRole);
                const curReq = d[currentRole] || 0;
                // Calculate the Utility Score of changing roles
                const bufferAfterLeave = (curSupply - 1) - curReq;
                const penaltyToLeave = getUtility(bufferAfterLeave);
                let bestSkill = currentRole;
                let bestNetScore = 0; // Baseline: Staying put is 0 change

                // Evaluate Candidates
                mySkills.forEach(skill => {
                    if (skill === currentRole) return;
                    const req = d[skill] || 0;
                    const sup = getSupply(t, skill);
                    const buffer = sup - req;
                    // Net Utility: Benefit of Joining Role
                    const rewardToJoin = getUtility(buffer);
                    // Net Score: Cost of Leaving Role
                    let score = rewardToJoin - penaltyToLeave;

                    // Smoothing out role changes where possible    
                    // Only apply if the move is fundamentally valid (Score > -2000)
                    if (score > -5000) {
                        // Inertia (Prev Hour)
                        if (prevRole && skill === prevRole) score += 500;
                        else if (prevRole && skill !== prevRole) score -= 200; // Flicker Penalty
                        // Momentum (Next Hour)
                        if (nextRole && skill === nextRole) score += 500;
                        else if (nextRole && skill !== nextRole) score -= 200; // Flicker Penalty
                        // Stability Bias
                        if (skill === currentRole) score += 50;
                    }
                    if (score > bestNetScore) {
                        bestNetScore = score;
                        bestSkill = skill;
                    }
                });

                // Apply Change
                if (bestSkill !== currentRole) {
                    emp.schedule[t] = bestSkill;
                }
            }
        });
    });

    return roster;
}

// ============================================================================
// BUILD LP STRING & SOLVE
// ============================================================================
/* This function builds a CPLEX LP string and finds a near-optimal solution within
 * the specified time limit, or until an optimal solution is found.  It then takes 
 * the solution and re-allocates this allocation of employees by role and hour and 
 * smooths it out using a greedy heuristic.  It takes the output of the optimization
 * problem and re-allocates employees between roles in order to smooth out any over- 
 * or under-allocation of roles and skills. These allocations are then fed back into
 * the solver with weights to help find an improved solution.  This can be tweaked
 * using the final constants defined at the top of the script.  A final smoothing is
 * then done, and returned to be displayed in the schedule.js script. 
 * * Minimize Z = (Wages) + (Penalties) + (Contiguity Cost) - (Warm Start Bonus)
 * @param {Array} roster - The list of employees and their schedules.
 * @param {Array} demands - The list of roles and their demand at each time step.
 * @param {Array} skillNames - The list of skill names.
 * @returns {Array} The smoothed roster.
 */
async function solveSchedulingMILP(params) {
    if (!highsModule) await highsModulePromise;

    const { employees, demands, preferredEmployees } = params;
    const skillNames = ["Cashiers", "Stocking", "Customer Service", "BackRoom", "Floor Associate"];

    // Validate Headcount
    let preferredCount = parseInt(preferredEmployees) || employees.length;
    if (preferredCount > employees.length) preferredCount = employees.length;
    const isFullRoster = preferredCount === employees.length;

    // Time Limits
    const SINGLE_PASS_LIMIT = 240; // Time for Full Roster
    const DOUBLE_PASS_LIMIT = 180; // Time for Partial Roster (1 of 2 Passes)

    // Pass Initialization Message to Console
    console.log(`%c>> SOLVER START: Target ${preferredCount} (Total Pool: ${employees.length})`, "color: green; font-weight: bold;");

    // ========================================================================
    // GENERATE & SOLVE LP
    // ========================================================================
    const runSolverPass = (batchEmployees, targetHeadcount, timeLimit) => {
        // --- PARAMETERS PRE-PROCESSING ---
        const validHours = new Set(); // Float32Array is ideal for large sparse matrices
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
        // Returns sorted list of valid hours for an employee on a specific day
        const getEmpDayAvail = (emp, d) => {
            return (emp.availability[d] || [])
                .map(Number)
                .filter(h => validHours.has(d * 24 + h))
                .sort((a, b) => a - b);
        };

        // --- CONSTRAINT GENERATION ---
        let constraints = [];
        let binaries = new Set();
        let continuous = [];
        let objTerms = [];
        // Tracker to link Employee Variables to Demand Constraints
        const demandConstraintLHS = Array.from({ length: 168 }, () => skillNames.map(() => []));

        // Employee Constraints
        batchEmployees.forEach((emp, eIdx) => {
            const minH = parseFloat(emp.minHrs) || 0;
            const maxH = parseFloat(emp.maxHrs) || 40;
            const baseWage = parseFloat(emp.pay) || 20;
            let empAllY = [];           // Track all hours worked in week
            let empDailyActive = [];    // Track all active days in week
            let totalAvailableHours = 0;

            // --------------------------------------------------------------------
            // VARIABLE DEFINITIONS
            // --------------------------------------------------------------------
            /* uEmp: Global Active (1 if working this week, 0 otherwise)
             * reg/ot: Payroll buckets for Regular and Overtime hours
             * s_min: Penalty for missing minimum hours, incentivize initial fill-in
             */
            binaries.add(`uEmp_${eIdx}`);
            continuous.push(`reg_${eIdx}`, `ot_${eIdx}`, `s_min_${eIdx}`);

            // Objective Penalty Weights
            const CONTIGUITY_PENALTY = baseWage * 10.0;
            const MIN_HOUR_PENALTY = baseWage * 50.0;

            objTerms.push(`${fmt(baseWage)} reg_${eIdx}`);
            objTerms.push(`${fmt(baseWage * 1.5)} ot_${eIdx}`);
            objTerms.push(`${fmt(MIN_HOUR_PENALTY)} s_min_${eIdx}`);

            for (let d = 0; d < 7; d++) {
                const avail = getEmpDayAvail(emp, d);
                if (avail.length === 0) continue;

                totalAvailableHours += avail.length;
                const earliest = avail[0];
                const latest = avail[avail.length - 1];

                // ----------------------------------------------------------------
                // SHIFT VARIABLES (Continuous Implementation)
                // ----------------------------------------------------------------
                /* da_e_d:    Day Active (Binary-ish). 1 if working, 0 if off.
                 * start_e_d: The hour the shift starts (0.0 - 24.0)
                 * end_e_d:   The hour the shift ends (0.0 - 24.0)
                 */
                const da = `da_${eIdx}_${d}`;
                const startVal = `start_e${eIdx}_d${d}`;
                const endVal = `end_e${eIdx}_d${d}`;
                continuous.push(da, startVal, endVal);

                // Contiguity Penalty (Applied directly to variables)
                objTerms.push(`${fmt(CONTIGUITY_PENALTY)} end_e${eIdx}_d${d}`);
                objTerms.push(`-${fmt(CONTIGUITY_PENALTY)} start_e${eIdx}_d${d}`);
                objTerms.push(`${fmt(CONTIGUITY_PENALTY)} da_${eIdx}_${d}`);

                // ----------------------------------------------------------------
                // SHIFT BOUNDARIES (The "Big M" Logic)
                // ----------------------------------------------------------------
                /* If da=0 (Not working), force Start and End to 0.
                 * If da=1 (Working), Start must be >= Earliest, End <= Latest.
                 * Mathematical Form: Start - (Earliest * da) >= 0
                 */
                constraints.push(` s_e_${eIdx}_d${d}: ${startVal} - ${earliest} ${da} >= 0`);
                constraints.push(` b_min_${eIdx}_d${d}: ${startVal} - ${earliest} ${da} >= 0`);
                constraints.push(` b_max_${eIdx}_d${d}: ${endVal} - ${latest} ${da} <= 0`);
                // Hard Cap at 24 Hours
                constraints.push(` z_s_${eIdx}_d${d}: ${startVal} - 24 ${da} <= 0`);
                constraints.push(` z_e_${eIdx}_d${d}: ${endVal} - 24 ${da} <= 0`);

                let dayY = [];

                // --- Hourly Logic Constraints ---
                avail.forEach(h => {
                    const t = d * 24 + h;
                    const mySkills = (emp.skills || []).map(s => s.trim());

                    let canCoverDemand = false;
                    mySkills.forEach(s => {
                        const sIdx = skillNames.indexOf(s);
                        if (sIdx !== -1 && skillDemandAtT[t][sIdx] > 0) canCoverDemand = true;
                    });
                    if (!canCoverDemand) return;

                    // CORE WORKING BINARY: y_{e,t} (1 if e working at t, 0 if off)
                    const y = `y_${eIdx}_${t}`;
                    binaries.add(y);
                    dayY.push(y);
                    empAllY.push(y);

                    objTerms.push(`-${fmt(CONTIGUITY_PENALTY)} y_${eIdx}_${t}`);

                    // ------------------------------------------------------------
                    // CONTIGUITY "SQUEEZE" CONSTRAINTS
                    // ------------------------------------------------------------
                    /* If y=1 (Working), then the continuous Start/End variables
                     * must "bracket" this hour.
                     */
                    // Start Time Constraint: Start <= Hour (if y=1)
                    constraints.push(` s_set_${eIdx}_${t}: ${startVal} + 24 ${y} <= ${h + 24}`);
                    // End Time Constraint: End >= Hour (if y=1)    
                    constraints.push(` e_set_${eIdx}_${t}: ${endVal} - ${h} ${y} >= 0`);
                    // Activation Link: If y=1, Day Active (da) MUST be 1.
                    constraints.push(` da_lk_${eIdx}_${t}: ${y} - ${da} <= 0`);

                    // --- Skill Assignment (w_{e,t,s}) ---
                    let validWs = [];
                    mySkills.forEach(s => {
                        const sIdx = skillNames.indexOf(s);
                        if (sIdx !== -1 && skillDemandAtT[t][sIdx] > 0) {
                            const w = `w_${eIdx}_${t}_${sIdx}`;
                            continuous.push(w);
                            validWs.push(w);
                            // Register variable for the Demand Constraint
                            demandConstraintLHS[t][sIdx].push(w);
                            // Bound: You can't perform a skill if you aren't working (w <= y)
                            constraints.push(` w_bnd_${eIdx}_${t}_${sIdx}: ${w} - ${y} <= 0`);
                        }
                    });

                    if (validWs.length > 0) {
                        // Equality: Sum(Skills) == Working Status
                        constraints.push(` lnk_w_${eIdx}_${t}: ${validWs.join(" + ")} - ${y} = 0`);
                    } else {
                        // Force y=0 if no valid skills exist for the demand
                        constraints.push(` no_dem_${eIdx}_${t}: ${y} = 0`);
                    }
                });

                // ------------------------------------------------------------
                // DAY ACTIVATION LINKING
                // ------------------------------------------------------------
                /* Sum(Hours Worked) <= 24 * da
                 * Ensures da cannot be 0 if any y variables are 1.
                 */
                if (dayY.length > 0) {
                    constraints.push(` set_da_${eIdx}_d${d}: ${dayY.join(" + ")} - 24 ${da} <= 0`);
                    empDailyActive.push(da);
                }
            }

            // --- Payroll & Labor Law Constraints ---
            const workSum = empAllY.length > 0 ? empAllY.join(" + ") : "0";
            // Sum(y) = Regular + Overtime
            constraints.push(` bal_${eIdx}: ${workSum} - reg_${eIdx} - ot_${eIdx} = 0`);
            // Max Hours: Regular <= Contract Max (if Scheduled)
            constraints.push(` max_${eIdx}: reg_${eIdx} - ${fmt(maxH)} uEmp_${eIdx} <= 0`);
            // Min Hours: Regular + OT + Slack >= Contract Min (if Scheduled)
            const safeMinShift = Math.min(minH, totalAvailableHours);
            if (safeMinShift > 0) {
                constraints.push(` min_par_${eIdx}: reg_${eIdx} - ${fmt(safeMinShift)} uEmp_${eIdx} >= 0`);
            }
            // Minimum Hours (Slack-Based)
            constraints.push(` hard_min_${eIdx}: reg_${eIdx} + ot_${eIdx} + s_min_${eIdx} - ${fmt(minH)} uEmp_${eIdx} >= 0`);

            // OT Cap: Hard limit on overtime (e.g., max 20 hours OT)
            constraints.push(` ot_${eIdx}: ot_${eIdx} <= 20`);

            // Global Activity Link
            if (empDailyActive.length > 0) {
                const u = `uEmp_${eIdx}`;
                empDailyActive.forEach(da => constraints.push(` lnk_u_${eIdx}_${da}: ${da} - ${u} <= 0`));
            } else {
                constraints.push(` f_inact_${eIdx}: uEmp_${eIdx} = 0`);
            }
        });

        // Demand Constraints
        validHours.forEach(t => {
            skillNames.forEach((_, sIdx) => {
                const req = skillDemandAtT[t][sIdx];
                if (req > 0) {
                    const workers = demandConstraintLHS[t][sIdx];
                    const lhs = workers.length > 0 ? workers.join(" + ") : "0";
                    constraints.push(` dem_${sIdx}_${t}: ${lhs} >= ${fmt(req)}`);
                }
            });
        });

        // Headcount Constraint
        const allU = batchEmployees.map((_, i) => `uEmp_${i}`);
        constraints.push(` wf_cap: ${allU.join(" + ")} = ${fmt(targetHeadcount)}`);

        // --- Formatting Bounds ---
        const relaxedBounds = continuous
            .filter(c => c.startsWith('da_') || c.startsWith('w_'))
            .map(c => `${c} <= 1`)
            .join("\n");

        // --- Compile LP String ---
        const lpString = [
            "Minimize",
            " obj: " + objTerms.join(" + "),
            "Subject To", ...constraints,
            "Binaries", Array.from(binaries).join("\n"),
            "Bounds",
            continuous.map(c => `${c} >= 0`).join("\n"),
            relaxedBounds,
            "End"
        ].join("\n");

        const result = highsModule.solve(lpString, {
            time_limit: timeLimit,
            presolve: 'on',
            mip_rel_gap: 0.05
        });

        return result;
    };

    // ========================================================================
    // PARSE RESULT TO ROSTER
    // ========================================================================
    const parseResultToRoster = (batchEmployees, resultColumns) => {
        return batchEmployees.map((emp, eIdx) => {
            let schedule = Array(168).fill(null);

            // Check if employee was selected
            const isSelected = (resultColumns[`uEmp_${eIdx}`]?.Primal || 0) > 0.5;

            if (isSelected) {
                for (let t = 0; t < 168; t++) {
                    if ((resultColumns[`y_${eIdx}_${t}`]?.Primal || 0) > 0.5) {
                        let assignedRole = "Assigned";
                        let maxVal = 0;
                        skillNames.forEach((s, sIdx) => {
                            const val = resultColumns[`w_${eIdx}_${t}_${sIdx}`]?.Primal || 0;
                            if (val > 0.5) assignedRole = s;
                            else if (val > maxVal && val > 0.1) { maxVal = val; assignedRole = s; }
                        });
                        schedule[t] = assignedRole;
                    }
                }
            }
            return {
                id: emp.id, skills: emp.skills, pay: parseFloat(emp.pay) || 15,
                schedule,
                regHrs: resultColumns[`reg_${eIdx}`]?.Primal || 0,
                otHrs: resultColumns[`ot_${eIdx}`]?.Primal || 0,
                isSelected
            };
        });
    };


    // ========================================================================
    // MAIN EXECUTION FLOW
    // ========================================================================

    /**
     * For a Full Roster, we run the solver once for four minutes; while longer
     * passes can be performed, even waiting for over 10 minutes doesn't offer
     * meaningful improvements over the output at four minutes.  Therefore, this
     * decision is made for useability.
     */
    if (isFullRoster) {
        const result = runSolverPass(employees, preferredCount, SINGLE_PASS_LIMIT);

        if (!result.Columns) return { status: 'Error', error: "Infeasible or Timeout" };

        const roster = parseResultToRoster(employees, result.Columns);
        return finalizeAndReturn(roster, result.ObjectiveValue);
    }

    /**
     * For a Partial Roster, the selection of employees is performed in two passes.
     * The first pass is to select the best employees, and the second pass is to
     * optimize those selected employees.  This is to help give stability to the 
     * solution.  These two passes are each 3 minutes, which is how long they need
     * to reach stable blocked solutions when ran in parallel.  This is due to the
     * Optimize Staffing function, which runs 3 workers in parallel--which allows
     * for a much quicker solution.  However, this search across several different
     * configurations in parallel needs additional time for constistent, stable results.
     */
    else {
        // Select the best employees
        const result1 = runSolverPass(employees, preferredCount, DOUBLE_PASS_LIMIT);
        if (!result1.Columns) return { status: 'Error', error: "Pass 1 Infeasible" };
        const rosterPass1 = parseResultToRoster(employees, result1.Columns);
        // Identify the Selected Employees to Schedule
        const activeEmployees = employees.filter((_, i) => rosterPass1[i].isSelected);
        // We use the original employee objects to preserve IDs and Data
        const droppedEmployees = employees.filter((_, i) => !rosterPass1[i].isSelected);
        // Optimize these active employees
        const result2 = runSolverPass(activeEmployees, activeEmployees.length, DOUBLE_PASS_LIMIT);
        if (!result2.Columns) {
            console.warn(">> Pass 2 Failed. Reverting to Pass 1 result.");
            return finalizeAndReturn(rosterPass1, result1.ObjectiveValue);
        }
        const rosterPass2 = parseResultToRoster(activeEmployees, result2.Columns);

        // Construct full roster
        const activeMap = new Map(rosterPass2.map(r => [r.id, r]));
        const fullRoster = employees.map(emp => {
            if (activeMap.has(emp.id)) return activeMap.get(emp.id);
            // Return empty record for unscheduled employees
            return {
                id: emp.id, skills: emp.skills, pay: parseFloat(emp.pay) || 15,
                schedule: Array(168).fill(null),
                regHrs: 0, otHrs: 0
            };
        });

        return finalizeAndReturn(fullRoster, result2.ObjectiveValue);
    }

    // ========================================================================
    // FINALIZE & RETURN
    // ========================================================================
    function finalizeAndReturn(rawRoster, objValue) {
        // Apply Smoothing Heuristic
        const smoothedRoster = smoothSkillAllocation(rawRoster, demands, skillNames);
        let scheduledTotal = 0;
        let tWages = 0;
        let tOT = 0;
        smoothedRoster.forEach(e => {
            tWages += (e.regHrs * e.pay);
            tOT += (e.otHrs * e.pay * 1.5);
            if (e.regHrs > 0) scheduledTotal++;
        });

        // Return Solver Results to Console
        console.log("%c--- SOLVER COMPLETE ---", "color: green; font-weight: bold;");
        console.table({
            "Total Scheduled": scheduledTotal,
            "Objective Value": objValue.toFixed(2),
            "Actual Cost": `$${(tWages + tOT).toFixed(2)}`
        });

        // Return Solver Results to UI
        return {
            status: 'Optimal',
            result: {
                roster: smoothedRoster,
                objective: objValue,
                overTime: tOT,
                actualLaborCost: (tWages + tOT).toFixed(2)
            }
        };
    }
}

self.onmessage = async function (e) {
    const { type, data } = e.data;
    if (type === 'solve') {
        const output = await solveSchedulingMILP(data);
        self.postMessage({ type: 'result', ...output });
    }
}