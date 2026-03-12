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
 * the blocking behavior to meet constraints. A smoothing Heuristic is used to
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
 * Memory is allocated dynamically to ensure safe browser limits.
 */
async function initHighs(memoryBytes) {
    if (highsModulePromise) return highsModulePromise;
    try {
        importScripts('../libs/highs.js');
        if (typeof Module === 'function') {
            highsModulePromise = Module({
                locateFile: (file) => '../libs/' + file,
                initialMemory: memoryBytes,
            }).then(instance => {
                highsModule = instance;
                return instance;
            });
            return highsModulePromise;
        }
    } catch (error) {
        console.error("WASM Load Error:", error);
        throw error;
    }
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
 * HIERARCHICAL DEMAND-BLOCK SMOOTHER (Tree Decomposition)
 * ============================================================================
 * Decomposes daily demand into a stack of contiguous requirement blocks.
 * Employs Dynamic Stress Updating, Volumetric Sorting (Stress * Duration),
 * and Block Slicing (Maximal Sub-Interval Matching) to geometrically pack
 * shifts using the least flexible employees first.
 */
function smoothSkillAllocation(rawRoster, demands, skillNames) {
    const finalRoster = JSON.parse(JSON.stringify(rawRoster));

    const getFlexibility = (emp) => (emp.skills || []).filter(s => skillNames.includes(s)).length;

    // Process each day completely independently to isolate block interactions
    for (let d = 0; d < 7; d++) {
        const startT = d * 24;

        // 1. ISOLATE DAILY ACTIVE WORKFORCE
        const activeEmps = [];
        finalRoster.forEach((emp, eIdx) => {
            let working = Array(24).fill(false);
            let assigned = Array(24).fill(null);
            let isWorkingToday = false;

            for (let h = 0; h < 24; h++) {
                if (emp.schedule[startT + h] !== null) {
                    isWorkingToday = true;
                    working[h] = true;
                    emp.schedule[startT + h] = null; // Clear the raw MILP skill assignments
                }
            }
            if (isWorkingToday) {
                activeEmps.push({ idx: eIdx, skills: emp.skills, flex: getFlexibility(emp), working, assigned });
            }
        });

        // 2. ISOLATE DAILY DEMAND (Mutable and Immutable copies)
        const dailyDemand = Array.from({ length: 24 }, () => ({}));
        const originalDailyDemand = Array.from({ length: 24 }, () => ({}));
        demands.filter(dem => dem.day === d).forEach(dem => {
            skillNames.forEach(s => {
                const req = parseFloat(dem[s]) || 0;
                dailyDemand[dem.hour][s] = req;
                originalDailyDemand[dem.hour][s] = req;
            });
        });

        // 3. INITIAL DEMAND DECOMPOSITION (The Tree / Stack)
        let demandBlocks = [];
        skillNames.forEach(skill => {
            let currentProfile = dailyDemand.map(h => h[skill] || 0);

            while (Math.max(...currentProfile) > 0) {
                let startHour = currentProfile.findIndex(val => val > 0);
                let endHour = startHour;

                while (endHour < 24 && currentProfile[endHour] > 0) endHour++;
                endHour--; // Step back to the last valid contiguous hour

                let minDemand = Math.min(...currentProfile.slice(startHour, endHour + 1));

                // Create identical blocks for the width of the demand floor
                for (let i = 0; i < minDemand; i++) {
                    demandBlocks.push({ skill, start: startHour, end: endHour });
                }

                // Shave off the root, leaving the peaks (children) for the next iteration
                for (let h = startHour; h <= endHour; h++) {
                    currentProfile[h] -= minDemand;
                }
            }
        });

        // 4. DYNAMIC GREEDY ASSIGNMENT LOOP
        while (demandBlocks.length > 0) {
            // A. Dynamic Stress Calculation (Updates every loop as employees are consumed)
            const capableSupply = Array.from({ length: 24 }, () => ({}));
            for (let h = 0; h < 24; h++) {
                skillNames.forEach(s => {
                    capableSupply[h][s] = activeEmps.filter(e => e.working[h] && e.assigned[h] === null && e.skills.includes(s)).length;
                });
            }

            // B. Volumetric Sorting (Total Stress = Avg Stress * Duration)
            demandBlocks.forEach(b => {
                let totalStress = 0;
                for (let h = b.start; h <= b.end; h++) {
                    const req = dailyDemand[h][b.skill] || 0;
                    if (req === 0) continue;
                    const supply = capableSupply[h][b.skill] || 0;
                    totalStress += supply > 0 ? (req / supply) : 9999; // Massive penalty if impossible
                }
                b.volume = totalStress;
            });

            // Sort so the hardest, longest blocks are always popped first
            demandBlocks.sort((a, b) => b.volume - a.volume);
            const block = demandBlocks.shift();

            if (block.volume === 0) continue; // Demand was already zeroed out

            // C. Block Slicing / Sub-Interval Matching
            let bestEmp = null;
            let bestMatchStart = -1;
            let bestMatchEnd = -1;
            let maxOverlap = 0;
            let bestFlex = 999; // Lower is better (protect generalists)

            activeEmps.forEach(emp => {
                if (!emp.skills.includes(block.skill)) return;

                let currentStart = -1;
                let currentOverlap = 0;
                let localBestOverlap = 0;
                let localBestStart = -1;
                let localBestEnd = -1;

                for (let h = block.start; h <= block.end; h++) {
                    if (emp.working[h] && emp.assigned[h] === null) {
                        if (currentStart === -1) currentStart = h;
                        currentOverlap++;
                    } else {
                        if (currentOverlap > localBestOverlap) {
                            localBestOverlap = currentOverlap;
                            localBestStart = currentStart;
                            localBestEnd = h - 1;
                        }
                        currentStart = -1;
                        currentOverlap = 0;
                    }
                }
                if (currentOverlap > localBestOverlap) {
                    localBestOverlap = currentOverlap;
                    localBestStart = currentStart;
                    localBestEnd = block.end;
                }

                if (localBestOverlap > 0) {
                    if (localBestOverlap > maxOverlap || (localBestOverlap === maxOverlap && emp.flex < bestFlex)) {
                        maxOverlap = localBestOverlap;
                        bestMatchStart = localBestStart;
                        bestMatchEnd = localBestEnd;
                        bestEmp = emp;
                        bestFlex = emp.flex;
                    }
                }
            });

            // D. Execution & Geometric Slicing
            if (bestEmp) {
                // Lock the employee in
                for (let h = bestMatchStart; h <= bestMatchEnd; h++) {
                    bestEmp.assigned[h] = block.skill;
                    dailyDemand[h][block.skill] = Math.max(0, dailyDemand[h][block.skill] - 1);
                }

                // If they couldn't cover the whole block, slice leftovers and re-queue them
                if (bestMatchStart > block.start) {
                    demandBlocks.push({ skill: block.skill, start: block.start, end: bestMatchStart - 1 });
                }
                if (bestMatchEnd < block.end) {
                    demandBlocks.push({ skill: block.skill, start: bestMatchEnd + 1, end: block.end });
                }
            }
        }

        // 5. WRITE TO ROSTER & FILL SURPLUS LABOR
        activeEmps.forEach(e => {
            for (let h = 0; h < 24; h++) {
                if (e.working[h]) {
                    if (e.assigned[h] !== null) {
                        finalRoster[e.idx].schedule[startT + h] = e.assigned[h];
                    } else {
                        // Surplus labor gets filled with their most common/valid skill
                        const validSkills = e.skills.filter(s => skillNames.includes(s));
                        finalRoster[e.idx].schedule[startT + h] = validSkills[0] || skillNames[0];
                    }
                }
            }
        });

        // 6. DEMAND SWAP PASS (Fix shortages by stealing from surplus skills)
        for (let h = 0; h < 24; h++) {
            const t = startT + h;
            skillNames.forEach(skill => {
                let req = originalDailyDemand[h][skill] || 0;
                let actual = activeEmps.filter(e => finalRoster[e.idx].schedule[t] === skill).length;

                while (actual < req) {
                    let potentialSwaps = activeEmps.filter(e =>
                        finalRoster[e.idx].schedule[t] !== null &&
                        finalRoster[e.idx].schedule[t] !== skill &&
                        e.skills.includes(skill)
                    );

                    if (potentialSwaps.length === 0) break; // Mathematically impossible to fix

                    // Sort to steal from the role with the highest over-staffing surplus
                    potentialSwaps.sort((a, b) => {
                        let skillA = finalRoster[a.idx].schedule[t];
                        let skillB = finalRoster[b.idx].schedule[t];
                        let surplusA = activeEmps.filter(e => finalRoster[e.idx].schedule[t] === skillA).length - (originalDailyDemand[h][skillA] || 0);
                        let surplusB = activeEmps.filter(e => finalRoster[e.idx].schedule[t] === skillB).length - (originalDailyDemand[h][skillB] || 0);
                        return surplusB - surplusA;
                    });

                    finalRoster[potentialSwaps[0].idx].schedule[t] = skill;
                    actual++;
                }
            });
        }

        // 7. EMPLOYEE CONTIGUITY SWAP PASS (Iron out the boundaries)
        for (let h = 1; h < 23; h++) {
            const t = startT + h;
            const empsAtT = activeEmps.filter(e => finalRoster[e.idx].schedule[t] !== null);

            for (let i = 0; i < empsAtT.length; i++) {
                for (let j = i + 1; j < empsAtT.length; j++) {
                    const empA = empsAtT[i].idx;
                    const empB = empsAtT[j].idx;
                    const skillA = finalRoster[empA].schedule[t];
                    const skillB = finalRoster[empB].schedule[t];

                    if (skillA === skillB) continue;
                    if (!rawRoster[empA].skills.includes(skillB) || !rawRoster[empB].skills.includes(skillA)) continue;

                    const cntTran = (e, testSkill) => {
                        let trans = 0;
                        if (finalRoster[e].schedule[t - 1] !== null && finalRoster[e].schedule[t - 1] !== testSkill) trans++;
                        if (finalRoster[e].schedule[t + 1] !== null && finalRoster[e].schedule[t + 1] !== testSkill) trans++;
                        return trans;
                    };

                    const currentFriction = cntTran(empA, skillA) + cntTran(empB, skillB);
                    const swappedFriction = cntTran(empA, skillB) + cntTran(empB, skillA);

                    if (swappedFriction < currentFriction) {
                        finalRoster[empA].schedule[t] = skillB;
                        finalRoster[empB].schedule[t] = skillA;
                    }
                }
            }
        }
    }

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
 * then done and returned, to be displayed in the schedule.js script. 
 * @param {Array} roster - The list of employees and their schedules.
 * @param {Array} demands - The list of roles and their demand at each time step.
 * @param {Array} skillNames - The list of skill names.
 * @param {Array} preferredEmployees - The number of employees to target.
 * @param {Array} timeLimit - The time limit in minutes.
 * @returns {Array} The smoothed roster.
 */
async function solveSchedulingMILP(params) {
    const { employees, demands, preferredEmployees, timeLimit = 20 } = params;
    const skillNames = ["Cashiers", "Stocking", "Customer Service", "BackRoom", "Floor Associate"];
    const TIME_LIMIT = timeLimit;
    let targetCount = parseInt(preferredEmployees) || employees.length;
    if (targetCount > employees.length) targetCount = employees.length;

    // ========================================================================
    // GENERATE & SOLVE LP (Dynamic Configuration)
    // ========================================================================
    const runSolverPass = (batchEmployees, options) => {
        const { targetHeadcount, timeLimit, isRelaxed = false, firmBlocking = false, quiet = false } = options;
        const validHours = new Set();
        // Demand and Supply levels at each time step
        const skillDemandAtT = Array.from({ length: 168 }, () => new Float32Array(skillNames.length));
        const skillSupplyAtT = Array.from({ length: 168 }, () => new Float32Array(skillNames.length));

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

        // Pre-compute supply of skills and valid hours for an employee at each time step
        batchEmployees.forEach(emp => {
            // Speed Optimization: Map strings to indices ONCE
            const validSkillIndices = (emp.skills || [])
                .map(s => s.trim())
                .map(s => skillNames.indexOf(s))
                .filter(idx => idx !== -1);

            for (let d = 0; d < 7; d++) {
                const avail = emp.availability[d] || [];
                avail.forEach(h => {
                    const t = d * 24 + h;
                    validSkillIndices.forEach(sIdx => {
                        skillSupplyAtT[t][sIdx] += 1;
                    });
                });
            }
        });

        const getEmpDayAvail = (emp, d) => {
            return (emp.availability[d] || [])
                .map(Number)
                .filter(h => validHours.has(d * 24 + h))
                .sort((a, b) => a - b);
        };

        let constraints = [];
        let binaries = new Set();
        let continuous = [];
        let objTerms = [];
        // Tracker to link employee variables to demand constraints
        const demandConstraintLHS = Array.from({ length: 168 }, () => skillNames.map(() => []));

        // Employee Constraints
        batchEmployees.forEach((emp, eIdx) => {
            const minH = parseFloat(emp.minHrs) || 0;
            const maxH = parseFloat(emp.maxHrs) || 40;
            const baseWage = parseFloat(emp.pay) || 20;
            let empAllY = [];
            let empDailyActive = [];
            let totalAvailableHours = 0;

            // Speed Optimization: Map strings to indices ONCE for the loops below
            const validSkillIndices = (emp.skills || [])
                .map(s => s.trim())
                .map(s => skillNames.indexOf(s))
                .filter(idx => idx !== -1);

            // --------------------------------------------------------------------
            // VARIABLE DEFINITIONS
            // --------------------------------------------------------------------
            /* u: Global Active (1 if working this week, 0 otherwise)
             * reg/ot: Payroll buckets for Regular and Overtime hours
             * s_min: Penalty for missing minimum hours, incentivize initial fill-in
             */
            binaries.add(`u_${eIdx}`);
            continuous.push(`reg_${eIdx}`, `ot_${eIdx}`);

            /* Objective Penalty Weights
             * CONTIGUITY_PENALTY: Penalty for missing hours in contiguous time slots
             * This is penalized slightly higher than bas wages, incentivizing filling
             * in any gaps over leaving them unscheduled.  If a gap must form then its
             * incentivized to keep it short.
             * BLOCK_PENALTY: Penalty for each block of unscheduled hours in a day.
             * The longest span for such a gap is 9 hours, so this is 12 times greater
             * than CONTIGUITY_PENALTY to prevent many gaps being formed to reduce total
             * interior unscheduled hours in shifts.
             * symmetryBreak: A fractional adjustment of the basewage of employees to
             * disrupt the symmetry of the problem. and help for rapid convergence.  This
             * helps reduce 'ties' and helps trim the Branch and Bound search space.
             */
            const symmetryBreak = (eIdx / batchEmployees.length) * 0.001;

            // Effective wage tricks the solver into keeping highly utilized employees from Stage 2
            const effectiveWage = baseWage - symmetryBreak;
            const otWage = isRelaxed ? (effectiveWage * 50) : (effectiveWage * 1.5);
            const CONTIGUITY_PENALTY = 25;
            const BLOCK_PENALTY = 300;

            objTerms.push(`${fmt(effectiveWage)} reg_${eIdx}`);
            objTerms.push(`${fmt(otWage)} ot_${eIdx}`);

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
                continuous.push(da);
                objTerms.push(`${fmt(CONTIGUITY_PENALTY)} da_${eIdx}_${d}`);

                // ----------------------------------------------------------------
                // SPATIAL VARIABLES: Isolated strictly for Discrete Integer Pass
                // ----------------------------------------------------------------
                /* The linearly relaxed version of the model uses a hard constraint
                 * to enforce blocking, compared to the discrete integer version, which
                 * uses the objective function to prevent gaps.  The continuous version
                 * has an objective function which focuses solely on financial costs.
                 */
                if (!isRelaxed) {
                    continuous.push(startVal, endVal);
                    objTerms.push(`${fmt(CONTIGUITY_PENALTY)} ${endVal}`);
                    objTerms.push(`-${fmt(CONTIGUITY_PENALTY)} ${startVal}`);
                    /* If da=0 (Not working), force Start and End to 0.
                     * If da=1 (Working), Start must be >= Earliest, End <= Latest.
                     * Mathematical Form: Start - (Earliest * da) >= 0
                     */
                    constraints.push(` b_min_${eIdx}_d${d}: ${startVal} - ${earliest} ${da} >= 0`);
                    constraints.push(` b_max_${eIdx}_d${d}: ${endVal} - ${latest} ${da} <= 0`);
                    constraints.push(` z_s_${eIdx}_d${d}: ${startVal} - 24 ${da} <= 0`);
                }

                let dayY = [];
                let dayBlocks = [];
                let lastHour = -1;

                // --- Hourly Logic Constraints ---
                avail.forEach((h) => {
                    const t = d * 24 + h;
                    let canCoverDemand = false;

                    validSkillIndices.forEach(sIdx => {
                        if (skillDemandAtT[t][sIdx] > 0) canCoverDemand = true;
                    });

                    if (!canCoverDemand) return;

                    const y = `y_${eIdx}_${t}`;
                    const block = `blok_${eIdx}_${t}`;

                    binaries.add(y);
                    dayY.push(y);
                    empAllY.push(y);
                    continuous.push(block);
                    dayBlocks.push(block);

                    objTerms.push(`${fmt(BLOCK_PENALTY)} ${block}`);
                    objTerms.push(`-${fmt(CONTIGUITY_PENALTY)} y_${eIdx}_${t}`);

                    let maxScarcity = 0;
                    validSkillIndices.forEach(sIdx => {
                        if (skillDemandAtT[t][sIdx] > 0) {
                            const ratio = skillDemandAtT[t][sIdx] / (skillSupplyAtT[t][sIdx] + 1);
                            if (ratio > maxScarcity) maxScarcity = ratio;
                        }
                    });
                    objTerms.push(`-${fmt(maxScarcity)} ${y}`);

                    // Blocking variables map the positive edge-transitions of a shift
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
                     * must "bracket" this hour.  These only apply to the discrete
                     * integer version.
                     */
                    if (!isRelaxed) {
                        // Start Time Constraint: Start <= Hour (if y=1)
                        constraints.push(` s_set_${eIdx}_${t}: ${startVal} + 24 ${y} <= ${h + 24}`);
                        // End Time Constraint: End >= Hour (if y=1)
                        constraints.push(` e_set_${eIdx}_${t}: ${endVal} ${h > 0 ? `- ${h} ${y}` : ""} >= 0`);
                    }
                    // Activation Link: If y=1, Day Active (da) MUST be 1.
                    constraints.push(` da_lk_${eIdx}_${t}: ${y} - ${da} <= 0`);

                    // --- Skill Assignment (w_{e,t,s}) ---
                    let validWs = [];
                    validSkillIndices.forEach(sIdx => {
                        if (skillDemandAtT[t][sIdx] > 0) {
                            const w = `w_${eIdx}_${t}_${sIdx}`;
                            continuous.push(w);
                            validWs.push(w);
                            demandConstraintLHS[t][sIdx].push(w);
                        }
                    });

                    if (validWs.length > 0) {
                        constraints.push(` lnk_w_${eIdx}_${t}: ${validWs.join(" + ")} - ${y} = 0`);
                    } else {
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

                    // Geometric shift span bounds applied strictly to discrete integer pass
                    if (!isRelaxed) {
                        const sumY = dayY.join(" - ");
                        constraints.push(` spanlb_${eIdx}_d${d}: ${endVal} - ${startVal} + ${da} - ${sumY} >=0`);
                        constraints.push(` spanub_${eIdx}_d${d}: ${endVal} - ${startVal} + ${da} - ${sumY} <=0.01`);
                    }

                    if (firmBlocking && dayBlocks.length > 0) {
                        constraints.push(` f_blok_${eIdx}_d${d}: ${dayBlocks.join(" + ")} - ${da} <= 0`);
                    }
                }
            }

            // --- Payroll & Labor Law Constraints ---
            const workSum = empAllY.length > 0 ? empAllY.join(" + ") : "0";
            // Sum(y) = Regular + Overtime
            constraints.push(` bal_${eIdx}: ${workSum} - reg_${eIdx} - ot_${eIdx} = 0`);
            // Max Hours: Regular <= Contract Max (if Scheduled)
            constraints.push(` max_${eIdx}: reg_${eIdx} - ${fmt(maxH)} u_${eIdx} <= 0`);

            const safeMinShift = Math.min(minH, totalAvailableHours);
            if (safeMinShift > 0) {
                constraints.push(` minh_${eIdx}: reg_${eIdx} - ${fmt(safeMinShift)} u_${eIdx} >= 0`);
            }
            // OT Cap: Hard limit on overtime (max 20 hours OT)
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
        if (targetHeadcount !== null) {
            const allU = batchEmployees.map((_, i) => `u_${i}`);
            constraints.push(` wf_cap: ${allU.join(" + ")} = ${fmt(targetHeadcount)}`);
        }

        // ========================================================================
        // COMPILE CPLEX LP STRING
        // ========================================================================
        // Clean objective string
        const cleanObjective = " obj: " + objTerms.join(" + ").replace(/\+ -/g, "- ");

        let lpStringParts = [
            "Minimize", cleanObjective,
            "Subject To", ...constraints
        ];

        let boundsList = [];
        continuous.forEach(c => {
            if (c.startsWith('da_')) {
                boundsList.push(` 0 <= ${c} <= 1`);
            } else {
                boundsList.push(` ${c} >= 0`);
            }
        });
        // Linearly Relaxed Model will treat binaries as bounded continuous variables
        if (isRelaxed) {
            Array.from(binaries).forEach(b => {
                boundsList.push(` 0 <= ${b} <= 1`);
            });
        } else {
            lpStringParts.push("Binaries", Array.from(binaries).join("\n"));
        }

        lpStringParts.push("Bounds", boundsList.join("\n"), "End");
        const lpString = lpStringParts.join("\n");
        // Counting Variables and Constraints for Metric Logging
        const binaryCount = isRelaxed ? 0 : binaries.size;
        const contCount = isRelaxed ? continuous.length + binaries.size : continuous.length;
        // Setting Parameters for Solver Execution, based on Mode
        const constraintCount = constraints.length;
        const passType = isRelaxed ? "RELAXED" : "DISCRETE";
        const timerID = `HiGHS Solver [${passType} | Headcount: ${targetHeadcount || 'Auto'}]`;
        // For Discrete Solver, output the counts and start the timer
        if (!quiet) {
            self.postMessage({
                type: 'metrics',
                data: { binaries: binaryCount, continuous: contCount, constraints: constraintCount }
            });
            console.time(timerID);
        }

        // Solving Execution
        const result = highsModule.solve(lpString, {
            time_limit: timeLimit,
            presolve: 'on',
            mip_rel_gap: isRelaxed ? 0.01 : 0.05
        });
        // For Discrete Solver, output the solve time.
        if (!quiet) console.timeEnd(timerID);
        return result;
    };

    // ========================================================================
    // STOCHASTIC MONTE CARLO PASS (Fractional Simulation)
    // ========================================================================
    if (params.mode === 'stochasticFractional') {
        const relaxedResult = runSolverPass(params.employees, {
            targetHeadcount: null,
            timeLimit: 60,
            isRelaxed: true,
            firmBlocking: true,
            quiet: true
        });

        if (relaxedResult && relaxedResult.Columns) {
            let fractionalHeadcount = 0;
            let baselineShifts = [];

            params.employees.forEach((emp, eIdx) => {
                const u = relaxedResult.Columns[`u_${eIdx}`]?.Primal || 0;
                fractionalHeadcount += u;

                // --- EXTRACT DAILY SHIFT PROFILES ---
                for (let d = 0; d < 7; d++) {
                    let shiftSegments = [];
                    for (let h = 0; h < 24; h++) {
                        const t = d * 24 + h;
                        const yVal = relaxedResult.Columns[`y_${eIdx}_${t}`]?.Primal || 0;

                        if (yVal > 0.1) {
                            let bestSkill = null;
                            let maxW = 0;
                            skillNames.forEach((s, sIdx) => {
                                const wVal = relaxedResult.Columns[`w_${eIdx}_${t}_${sIdx}`]?.Primal || 0;
                                if (wVal > maxW) { maxW = wVal; bestSkill = s; }
                            });
                            if (bestSkill) shiftSegments.push({ hour: h, skill: bestSkill });
                        }
                    }
                    if (shiftSegments.length > 0) {
                        baselineShifts.push({ day: d, segments: shiftSegments });
                    }
                }
            });

            return { status: 'Optimal', result: { fractionalHeadcount, baselineShifts } };
        } else {
            return { status: 'Error', error: 'Relaxed simulation failed or timed out.' };
        }
    }

    // Initiate Discrete MILP Execution
    console.log("%c>> EXECUTING DISCRETE MILP", "color: blue;");
    const result = runSolverPass(employees, {
        targetHeadcount: targetCount,
        timeLimit: TIME_LIMIT,
        isRelaxed: false,
        firmBlocking: false
    });

    if (!result.Columns) return { status: 'Error', error: "Infeasible or Timeout" };

    // ========================================================================
    // PARSE RESULT TO ROSTER
    // ========================================================================
    const parseResultToRoster = (batchEmployees, resultColumns) => {
        return batchEmployees.map((emp, eIdx) => {
            let schedule = Array(168).fill(null);

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

        console.log("%c--- SOLVER COMPLETE ---", "color: green; font-weight: bold;");
        console.table({
            "Total Scheduled": scheduledTotal,
            "Objective Value": objValue.toFixed(2),
            "Actual Cost": `$${(tWages + tOT).toFixed(2)}`
        });

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

    const roster = parseResultToRoster(employees, result.Columns);
    return finalizeAndReturn(roster, result.ObjectiveValue);
}

self.onmessage = async function (e) {
    const { type, data } = e.data;
    if (type === 'solve') {
        try {
            // Maximum safe allocation is just under 2GB to prevent native browser engine crashes.
            const memAlloc = data.mode === 'stochasticFractional' ? (256 * 1024 * 1024) : (2000 * 1024 * 1024);
            await initHighs(memAlloc);
            const output = await solveSchedulingMILP(data);
            self.postMessage({ type: 'result', ...output });
        } catch (error) {
            console.error("Worker Caught Fatal Error:", error);
            self.postMessage({ type: 'crash', error: error.toString() });
        }
    }
}
