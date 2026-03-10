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
 * reallocate skill assignments to balance overstaffing of skill-groups.
 * CPLEX Formatting: http://web.mit.edu/lpsolve/doc/CPLEX-format.htm
 * HiGHs Controls: https://dev.ampl.com/solvers/highs/options.html
 * * @author Joel Wood
 */

// Worker State Variables
let highsModulePromise = null;
let highsModule = null;

/** Initialize Highs Module:
 * Attempts to load the WebAssembly solver from libs/highs.js
 * 1GB is allocated as a safe compatibility buffer.
 */
try {
    importScripts('../libs/highs.js');
    if (typeof Module === 'function') {
        highsModulePromise = Module({
            locateFile: (file) => '../libs/' + file,
            initialMemory: 1024 * 1024 * 1024,
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

/**
 * ============================================================================
 * TWO-PASS SKILL SMOOTHING HEURISTIC
 * ============================================================================
 * Converts the solver's unbalanced skill allocations into a clean, 
 * contiguous integer schedule using an Inertia-Weighted Forward Pass and a 
 * Swap-Correcting Backward Pass.
 */
function smoothSkillAllocation(rawRoster, demands, skillNames) {
    // Map active workers per hour
    const sched = Array.from({ length: 168 }, () => ({})); // hour -> empIdx -> skillIdx
    const activeAtHour = Array.from({ length: 168 }, () => []);
    rawRoster.forEach((emp, eIdx) => {
        for (let t = 0; t < 168; t++) {
            if (emp.schedule[t] !== null) {
                activeAtHour[t].push(eIdx);
            }
        }
    });

    const INERTIA_MULTIPLIER = 100.0; // Massive weight to prioritize staying in the same role
    const DECAY_FACTOR = 0.5; // Exponential decay to spread surplus
    let skillScores = new Array(skillNames.length).fill(1.0);

    // ========================================================================
    // FORWARD PASS (Chronological Inertia & Demand Fulfillment)
    // ========================================================================
    for (let t = 0; t < 168; t++) {
        if (activeAtHour[t].length === 0) continue;
        let unassigned = [...activeAtHour[t]];
        let hourDemand = new Array(skillNames.length).fill(0);
        // Map Hard Demand for Hour 't'
        const day = Math.floor(t / 24);
        const hour = t % 24;
        const demandRow = demands.find(d => parseInt(d.day) === day && parseInt(d.hour) === hour);

        if (demandRow) {
            skillNames.forEach((s, sIdx) => {
                hourDemand[sIdx] = parseFloat(demandRow[s]) || 0;
            });
        }
        // --- Hard Demand Fulfillment ---
        for (let sIdx = 0; sIdx < skillNames.length; sIdx++) {
            let needed = hourDemand[sIdx];
            while (needed > 0 && unassigned.length > 0) {
                // Sort unassigned pool by INERTIA (Did they do this skill last hour?)
                unassigned.sort((a, b) => {
                    const aInertia = (t > 0 && sched[t - 1][a] === sIdx) ? 1 : 0;
                    const bInertia = (t > 0 && sched[t - 1][b] === sIdx) ? 1 : 0;
                    return bInertia - aInertia; // Descending priority
                });
                const empIdx = unassigned.find(idx => rawRoster[idx].skills.includes(skillNames[sIdx]));
                if (empIdx !== undefined) {
                    sched[t][empIdx] = sIdx;
                    unassigned = unassigned.filter(id => id !== empIdx); // Remove from pool
                    needed--;
                } else {
                    break;
                }
            }
        }
        // --- Surplus Allocation (Decay + Inertia) ---
        unassigned.forEach(empIdx => {
            const empSkills = (rawRoster[empIdx].skills || [])
                .map(s => skillNames.indexOf(s))
                .filter(idx => idx !== -1);
            if (empSkills.length === 0) return;
            let bestSkill = empSkills[0];
            let bestScore = -1;
            empSkills.forEach(sIdx => {
                let score = skillScores[sIdx];
                // Apply Inertia Multiplier if they performed this skill last hour
                if (t > 0 && sched[t - 1][empIdx] === sIdx) {
                    score *= INERTIA_MULTIPLIER;
                }
                if (score > bestScore) {
                    bestScore = score;
                    bestSkill = sIdx;
                }
            });
            // Lock assignment and decay the global score for that skill
            sched[t][empIdx] = bestSkill;
            skillScores[bestSkill] *= DECAY_FACTOR;
        });
        skillScores = skillScores.map(s => s + 0.1);
    }

    // ========================================================================
    // BACKWARD PASS (Orphan Eradication / Smoothing Swaps)
    // ========================================================================
    // Scan backwards from the end of the week down to hour 1
    for (let t = 166; t >= 1; t--) {
        const empsAtT = Object.keys(sched[t]).map(Number);
        // Compare every pair of employees working at hour 't'
        for (let i = 0; i < empsAtT.length; i++) {
            for (let j = i + 1; j < empsAtT.length; j++) {
                const empA = empsAtT[i];
                const empB = empsAtT[j];
                const skillA = sched[t][empA];
                const skillB = sched[t][empB];
                if (skillA === skillB) continue; // no swap needed
                // Ensure both employees are physically capable of performing the other's skill
                const canADoB = rawRoster[empA].skills.includes(skillNames[skillB]);
                const canBDoA = rawRoster[empB].skills.includes(skillNames[skillA]);
                if (!canADoB || !canBDoA) continue;
                // Helper: Count how many times an employee breaks their skill continuity
                const cntTran = (emp, testSkill) => {
                    let trans = 0;
                    if (sched[t - 1][emp] !== undefined && sched[t - 1][emp] !== testSkill) trans++;
                    if (sched[t + 1][emp] !== undefined && sched[t + 1][emp] !== testSkill) trans++;
                    return trans;
                };
                // Evaluate the total system friction before and after a hypothetical swap
                const currentFriction = cntTran(empA, skillA) + cntTran(empB, skillB);
                const swappedFriction = cntTran(empA, skillB) + cntTran(empB, skillA);
                // If a swap reduces the number of broken skill blocks, execute the swap
                if (swappedFriction < currentFriction) {
                    sched[t][empA] = skillB;
                    sched[t][empB] = skillA;
                }
            }
        }
    }

    // ========================================================================
    // CONSTRUCT FINAL ROSTER
    // ========================================================================
    const finalRoster = JSON.parse(JSON.stringify(rawRoster));
    finalRoster.forEach((emp, eIdx) => {
        for (let t = 0; t < 168; t++) {
            // Apply the smoothed skill directly to the schedule array where they are active
            if (emp.schedule[t] !== null) {
                const assignedSkillIdx = sched[t][eIdx];
                if (assignedSkillIdx !== undefined && assignedSkillIdx !== -1) {
                    emp.schedule[t] = skillNames[assignedSkillIdx];
                }
            }
        }
    });

    return finalRoster;
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

    // Time Limit
    const TIME_LIMIT = 600; // Time for Full Roster

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
            /* u: Global Active (1 if working this week, 0 otherwise)
             * reg/ot: Payroll buckets for Regular and Overtime hours
             * s_min: Penalty for missing minimum hours, incentivize initial fill-in
             */
            binaries.add(`u_${eIdx}`);
            continuous.push(`reg_${eIdx}`, `ot_${eIdx}`);

            // Objective Penalty Weights
            const BLOCK_PENALTY = 300;
            const CONTIGUITY_PENALTY = 25;
            const symmetryBreak = (eIdx / employees.length) * 0.001;
            const effectiveWage = baseWage - symmetryBreak;

            objTerms.push(`${fmt(effectiveWage)} reg_${eIdx}`);
            objTerms.push(`${fmt(effectiveWage * 1.5)} ot_${eIdx}`);

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

                // Contiguity Penalty
                objTerms.push(`${fmt(CONTIGUITY_PENALTY)} end_e${eIdx}_d${d}`);
                objTerms.push(`-${fmt(CONTIGUITY_PENALTY)} start_e${eIdx}_d${d}`);
                objTerms.push(`${fmt(CONTIGUITY_PENALTY)} da_${eIdx}_${d}`);

                // ----------------------------------------------------------------
                // SHIFT BOUNDARIES
                // ----------------------------------------------------------------
                /* If da=0 (Not working), force Start and End to 0.
                 * If da=1 (Working), Start must be >= Earliest, End <= Latest.
                 * Mathematical Form: Start - (Earliest * da) >= 0
                 */
                constraints.push(` b_min_${eIdx}_d${d}: ${startVal} - ${earliest} ${da} >= 0`);
                constraints.push(` b_max_${eIdx}_d${d}: ${endVal} - ${latest} ${da} <= 0`);
                // Hard Cap at 24 Hours
                constraints.push(` z_s_${eIdx}_d${d}: ${startVal} - 24 ${da} <= 0`);

                let dayY = [];
                let lastHour = -1;
                // --- Hourly Logic Constraints ---
                avail.forEach((h, index) => {
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
                    const block = `blok_${eIdx}_${t}`;
                    binaries.add(y);
                    dayY.push(y);
                    empAllY.push(y);
                    continuous.push(block);
                    objTerms.push(`${fmt(BLOCK_PENALTY)} ${block}`);
                    objTerms.push(`-${fmt(CONTIGUITY_PENALTY)} y_${eIdx}_${t}`);

                    const midDist = Math.abs(h - 15) * 0.01;
                    objTerms.push(`${fmt(midDist)} y_${eIdx}_${t}`);

                    if (t % 24 === 0 || lastHour !== t - 1) {
                        constraints.push(`tr_${eIdx}_${t}: ${block} - ${y} >= 0`);
                    } else {
                        const prevY = `y_${eIdx}_${lastHour}`;
                        constraints.push(`tr_${eIdx}_${t}: ${block} - ${y} + ${prevY} >= 0`);
                    }
                    lastHour = t;

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

                    const sumY = dayY.join(" - ");
                    constraints.push(` span_${eIdx}_d${d}: ${endVal} - ${startVal} + ${da} - ${sumY} >=0`);
                    constraints.push(` span_${eIdx}_d${d}: ${endVal} - ${startVal} + ${da} - ${sumY} <=0.01`);
                }
            }

            // --- Payroll & Labor Law Constraints ---
            const workSum = empAllY.length > 0 ? empAllY.join(" + ") : "0";
            // Sum(y) = Regular + Overtime
            constraints.push(` bal_${eIdx}: ${workSum} - reg_${eIdx} - ot_${eIdx} = 0`);
            // Max Hours: Regular <= Contract Max (if Scheduled)
            constraints.push(` max_${eIdx}: reg_${eIdx} - ${fmt(maxH)} u_${eIdx} <= 0`);
            // Min Hours: Regular + OT + Slack >= Contract Min (if Scheduled)
            const safeMinShift = Math.min(minH, totalAvailableHours);
            if (safeMinShift > 0) {
                constraints.push(` minh_${eIdx}: reg_${eIdx} - ${fmt(safeMinShift)} u_${eIdx} >= 0`);
            }

            // OT Cap: Hard limit on overtime (e.g., max 20 hours OT)
            constraints.push(` ot_${eIdx}: ot_${eIdx} <= 20`);

            // Global Activity Link
            if (empDailyActive.length > 0) {
                const u = `u_${eIdx}`;
                empDailyActive.forEach(da => constraints.push(` lnk_u_${eIdx}_${da}: ${da} - ${u} <= 0`));
            } else {
                constraints.push(` f_inact_${eIdx}: u_${eIdx} = 0`);
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
        const allU = batchEmployees.map((_, i) => `u_${i}`);
        constraints.push(` wf_cap: ${allU.join(" + ")} >= ${fmt(targetHeadcount)}`);

        // --- Formatting Bounds ---
        const relaxedBounds = continuous
            .filter(c => c.startsWith('da_'))
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
            const isSelected = (resultColumns[`u_${eIdx}`]?.Primal || 0) > 0.5;

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
    const result = runSolverPass(employees, preferredCount, TIME_LIMIT);
    if (!result.Columns) return { status: 'Error', error: "Infeasible or Timeout" };
    const roster = parseResultToRoster(employees, result.Columns);
    return finalizeAndReturn(roster, result.ObjectiveValue);

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
        try {
            const output = await solveSchedulingMILP(data);
            self.postMessage({ type: 'result', ...output });
        } catch (error) {
            // Catch fatal WASM aborts and notify the main thread
            console.error("Worker Caught Fatal Error:", error);
            self.postMessage({ type: 'crash', error: error.toString() });
        }
    }
}