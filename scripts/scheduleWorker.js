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
 * Due to the use of minimal staffing slack variables, the solver may return
 * a solution that is understaffed.  A smoothing Heuristic is used to fill in and
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
 * the financially motivated LP Solver.  Additionally, since the MILP solver uses
 * slack variables which may allow it to return an understaffed schedule, this
 * function also does a smoothed fill in of these requirement misses.
 * This output is then passed back into the MILP solver with weights to do an
 * additional solve to minimize the price of this feasible solution.
 */
function smoothSkillAllocation(roster, demands, skillNames, allEmployeeData) {
    const fixes = [];  // List of skill-fixes to be applied at the end
    // Build Employee Map (Original MaxHrs, Skills, etc)
    const empMap = new Map(allEmployeeData.map(e => [e.id, e]));
    // Build Demand Map
    const demandMap = {};
    demands.forEach(d => {
        const t = d.day * 24 + d.hour;
        if (!demandMap[t]) demandMap[t] = {};
        skillNames.forEach(s => demandMap[t][s] = parseFloat(d[s]) || 0);
    });

    // Helper Function to Count current supply for a skill at time t
    const getSupply = (t, skill) => roster.filter(e => e.schedule[t] === skill).length;

    // ========================================================================
    // ROLE OPTIMIZATION
    // ========================================================================
    // Swaps assigned skills if the current role is overstaffed but another is needed.
    roster.forEach(emp => {
        const mySkills = (emp.skills || []).map(s => s.trim());
        for (let t = 0; t < 168; t++) {
            if (!emp.schedule[t]) continue;
            const currentRole = emp.schedule[t];
            const d = demandMap[t] || {};

            // If current role has surplus (or 0 demand), and another skill has need
            if ((d[currentRole] || 0) < getSupply(t, currentRole)) {
                let bestSkill = currentRole;
                let maxUnmet = 0;

                // Look at all other skills this employee has and find the one that needs more
                mySkills.forEach(s => {
                    const req = d[s] || 0;
                    const sup = getSupply(t, s);

                    // If the skill is understaffed, prioritize the skill with the most shortage
                    if (req > sup && (req - sup) > maxUnmet) {
                        maxUnmet = req - sup;
                        bestSkill = s;
                    }
                });

                if (bestSkill !== currentRole) {
                    emp.schedule[t] = bestSkill;
                }
            }
        }
    });

    // ========================================================================
    // EMPLOYEE MINIMUM HOURS FILL-IN
    // ========================================================================
    roster.forEach(emp => {
        const conf = empMap.get(emp.id);
        const minHrs = parseFloat(conf.minHrs) || 0;
        const maxHrs = parseFloat(conf.maxHrs) || 40;
        const ABSOLUTE_CAP = maxHrs + 20; // Max possible scheduled hours

        // Hou many hours they have already allocated
        let currentHrs = emp.schedule.filter(s => s).length;

        while (currentHrs < minHrs) {
            if (currentHrs >= ABSOLUTE_CAP) break; // Break if fully allocated

            // Find all candidate hours (Available but not working)
            let candidates = [];
            for (let d = 0; d < 7; d++) {
                // Look at hours the employee is available
                (conf.availability[d] || []).forEach(h => {
                    const t = d * 24 + h;
                    if (!emp.schedule[t]) {
                        // If they aren't working, Score for Smoothness
                        let score = 0;  // Score for smoothness of added hours being shift-contiguous
                        if (emp.schedule[t - 1]) score += 100; // Extend forward
                        if (emp.schedule[t + 1]) score += 100; // Extend backward
                        if (emp.schedule[t - 1] && emp.schedule[t + 1]) score += 200; // Fill gap

                        // Demand Utility - check if this skill is needed
                        const mySkills = conf.skills || [];
                        let bestSkill = mySkills[0];
                        let maxNeed = -Infinity;

                        // Look at all other skills this employee has and find the one that needs more
                        mySkills.forEach(s => {
                            const req = (demandMap[t] && demandMap[t][s]) || 0;
                            const sup = getSupply(t, s);
                            if ((req - sup) > maxNeed) {
                                maxNeed = req - sup;
                                bestSkill = s;
                            }
                        });

                        // If the skill is understaffed, prioritize the skill with the most shortage
                        if (maxNeed > 0) score += 50;
                        candidates.push({ t, score, skill: bestSkill, day: d, hour: h });
                    }
                });
            }

            if (candidates.length === 0) break; // No availability left

            // Pick the "Smoothest" slot
            candidates.sort((a, b) => b.score - a.score);
            const best = candidates[0];

            // Assign the best slot
            emp.schedule[best.t] = best.skill;
            currentHrs++;

            // Log the actions, to be displayed in the console
            fixes.push({
                Type: "Min Hours Fix",
                Employee: emp.id,
                Time: `Day ${best.day} @ ${best.hour}:00`,
                Action: `Added Shift (${best.skill})`
            });
        }
    });

    // ========================================================================
    // PASS 3: UNMET DEMAND REPAIR (The "Under-Staffed" Fix)
    // ========================================================================
    for (let t = 0; t < 168; t++) {
        skillNames.forEach(skill => {
            const req = (demandMap[t] && demandMap[t][skill]) || 0;
            const sup = getSupply(t, skill);

            // Shortage found. Find the "Smoothest" then "Cheapest" employee.
            if (sup < req) {
                // Find everyone who could work this shift
                let candidates = roster.filter(e => {
                    if (e.schedule[t]) return false; // Already working
                    const conf = empMap.get(e.id);
                    if (!conf.skills.includes(skill)) return false; // Wrong skill

                    // Check if they are available
                    const d = Math.floor(t / 24), h = t % 24;
                    if (!conf.availability[d] || !conf.availability[d].includes(h)) return false; // Not available

                    // Check if they can work this shift, based on their MaxHrs
                    const maxH = parseFloat(conf.maxHrs) || 40;
                    const ABSOLUTE_CAP = maxH + 20;
                    const currTotal = e.schedule.filter(s => s).length;

                    return currTotal < ABSOLUTE_CAP;
                });

                if (candidates.length > 0) {
                    // Score Candidates by Smoothness and Cost
                    candidates.forEach(c => {
                        const conf = empMap.get(c.id);
                        const wage = parseFloat(c.pay) || 20;
                        const maxH = parseFloat(conf.maxHrs) || 40;
                        const currTotal = c.schedule.filter(s => s).length;
                        // Calculate Financial Cost as a Tie-Breaker for selection
                        const isOT = currTotal >= maxH;
                        const marginalCost = isOT ? (wage * 1.5) : wage;
                        // Calculate Smoothness Tier as the Primary Selector
                        // Massive bonuses are used to ensure Smoothness overrules Wage costs.
                        let smoothBonus = 0;
                        const prev = c.schedule[t - 1];
                        const next = c.schedule[t + 1];

                        if (prev && next) {
                            smoothBonus = 10000000; // Largest bonus to bridge a shift gap
                        } else if (prev || next) {
                            smoothBonus = 1000000; // Reduced bonus to Extend a shift
                        }
                        // Fill-In Score - Lower is Better
                        c.repairScore = marginalCost - smoothBonus;
                    });

                    // Sort by Lowest Score First
                    candidates.sort((a, b) => a.repairScore - b.repairScore);
                    const pick = candidates[0];
                    const d = Math.floor(t / 24), h = t % 24;
                    // Apply the best slot
                    pick.schedule[t] = skill;

                    // Log the actions, to be displayed in the console
                    fixes.push({
                        Type: "Demand Fix",
                        Employee: pick.id,
                        Time: `Day ${d} @ ${h}:00`,
                        Action: `Assigned ${skill}`
                    });
                }
            }
        });
    }

    // Log the shift repairs in the console
    if (fixes.length > 0) {
        console.log("%c--- SCHEDULE REPAIR LOG ---", "color: #e67e22; font-weight: bold;");
        console.groupCollapsed(`%cSchedule Repairs: (${fixes.length} total)`, "color: #e67e22; font-weight: bold;"); 
        console.table(fixes); 
        console.groupEnd();
    }
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
    // Interval and Global Time Limit are imbalanced to give more time to the first solver (to ensure blocking)
    const GLOBAL_TIME_LIMIT = 600;  // This is the total Solver Time Limit
    const INTERVAL = 360;           // How long each sub-solver should run for in seconds
    const DEMAND_PENALTY = 6000;     // This is the penalty for each unmet demand hour
    const MIN_HR_PENALTY = 5000;     // This is the penalty for each unmet minimum hour  
    const WARM_START_BONUS = 30;    // This is a weight applied to each successive solve, acting as a "gradient-step".

    const { employees, demands, preferredEmployees } = params;
    const skillNames = ["Cashiers", "Stocking", "Customer Service", "BackRoom", "Floor Associate"];

    const preferredCount = parseInt(preferredEmployees) || employees.length;

    // ============================================================================
    // PARAMETERS PRE-PROCESSING
    // ============================================================================
    const validHours = new Set();   // Float32Array is ideal for large sparse matrices
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

    // ============================================================================
    // CONSTRAINT GENERATION
    // ============================================================================
    let constraints = [];
    let binaries = new Set();
    let continuous = [];
    // Tracker to link Employee Variables to Demand Constraints
    const demandConstraintLHS = Array.from({ length: 168 }, () => skillNames.map(() => []));

    // --- Employee Constraints ---
    employees.forEach((emp, eIdx) => {
        const minH = parseFloat(emp.minHrs) || 0;
        const maxH = parseFloat(emp.maxHrs) || 40;
        let empAllY = [];           // Track all hours worked in week
        let empDailyActive = [];    // Track all active days in week

        // --------------------------------------------------------------------
        // VARIABLE DEFINITIONS
        // --------------------------------------------------------------------
        /* uEmp: Global Active (1 if working this week, 0 otherwise)
         * reg/ot: Payroll buckets for Regular and Overtime hours
         * s_min: Slack variable for missing minimum hours (Cost = Penalty)
         */
        continuous.push(`uEmp_${eIdx}`, `reg_${eIdx}`, `ot_${eIdx}`, `s_min_${eIdx}`);

        for (let d = 0; d < 7; d++) {
            const avail = getEmpDayAvail(emp, d);
            if (avail.length === 0) continue;
            // Determine earliest and latest hours available
            const earliest = avail[0];
            const latest = avail[avail.length - 1];

            // ----------------------------------------------------------------
            // SHIFT VARIABLES (Continuous Implementation)
            // ----------------------------------------------------------------
            /* da_e_d:    Day Active (Binary-ish). 1 if working, 0 if off.
             * start_e_d: The hour the shift starts (0.0 - 24.0)
             * end_e_d:   The hour the shift ends (0.0 - 24.0)
             */
            const da = `da_${eIdx}_${d}`;
            const startVal = `start_e${eIdx}_d${d}`;
            const endVal = `end_e${eIdx}_d${d}`;
            continuous.push(da, startVal, endVal);

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

            // ----------------------------------------------------------------
            // HOURLY LOGIC CONSTRAINTS
            // ----------------------------------------------------------------
            avail.forEach(h => {
                const t = d * 24 + h;
                // Employee Skill Check
                const mySkills = (emp.skills || []).map(s => s.trim());
                let canCoverDemand = false;
                mySkills.forEach(s => {
                    const sIdx = skillNames.indexOf(s);
                    // Only create variables if demand actually exists
                    if (sIdx !== -1 && skillDemandAtT[t][sIdx] > 0) canCoverDemand = true;
                });
                if (!canCoverDemand) return;

                // ------------------------------------------------------------
                // CORE WORKING BINARY: y_{e,t} (1 if e working at t, 0 if off)
                // ------------------------------------------------------------
                const y = `y_${eIdx}_${t}`;
                binaries.add(y);
                dayY.push(y);
                empAllY.push(y);

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

                // ------------------------------------------------------------
                // SKILL ASSIGNMENT (w_{e,t,s})
                // ------------------------------------------------------------
                // If working (y=1), must be assigned exactly ONE skill.
                let validWs = [];
                mySkills.forEach(s => {
                    const sIdx = skillNames.indexOf(s);
                    if (sIdx !== -1 && skillDemandAtT[t][sIdx] > 0) {
                        const w = `w_${eIdx}_${t}_${sIdx}`;
                        continuous.push(w);         // Relaxed binary (0-1 continuous)
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

        // --------------------------------------------------------------------
        // PAYROLL & LABOR LAW CONSTRAINTS
        // --------------------------------------------------------------------
        const workSum = empAllY.length > 0 ? empAllY.join(" + ") : "0";

        // Sum(y) = Regular + Overtime
        constraints.push(` bal_${eIdx}: ${workSum} - reg_${eIdx} - ot_${eIdx} = 0`);
        // Max Hours: Regular <= Contract Max
        constraints.push(` max_${eIdx}: reg_${eIdx} <= ${fmt(maxH)}`);
        // Min Hours: Regular + OT + Slack >= Contract Min
        constraints.push(` min_${eIdx}: reg_${eIdx} + ot_${eIdx} + s_min_${eIdx} >= ${fmt(minH)}`);
        // OT Cap: Hard limit on overtime (e.g., max 20 hours OT)
        constraints.push(` ot_${eIdx}: ot_${eIdx} <= 20`);

        // Global Activation Link: If any day active, uEmp must be 1.
        const u = `uEmp_${eIdx}`;
        empDailyActive.forEach(da => constraints.push(` lnk_u_${eIdx}_${da}: ${da} - ${u} <= 0`));
    });

    // --- Demand Constraints ---
    validHours.forEach(t => {
        skillNames.forEach((_, sIdx) => {
            const req = skillDemandAtT[t][sIdx];
            if (req > 0) {
                const workers = demandConstraintLHS[t][sIdx];
                const lhs = workers.length > 0 ? workers.join(" + ") : "0";
                const slack = `s_dem_${sIdx}_${t}`;     // Allows under-staffing for a penalty
                continuous.push(slack);
                constraints.push(` dem_${sIdx}_${t}: ${lhs} + ${slack} >= ${fmt(req)}`);
            }
        });
    });

    // --- Workforce Cap ---
    const allU = employees.map((_, i) => `uEmp_${i}`);
    constraints.push(` wf_cap: ${allU.join(" + ")} <= ${fmt(preferredCount)}`);

    // --- Formatting Bounds ---
    const relaxedBounds = continuous
        .filter(c => c.startsWith('da_') || c.startsWith('uEmp_') || c.startsWith('w_'))
        .map(c => `${c} <= 1`)
        .join("\n");

    // --- Compile LP Body ---
    const lpBody = [
        "Subject To", ...constraints,
        "Binaries", Array.from(binaries).join("\n"),
        "Bounds",
        continuous.map(c => `${c} >= 0`).join("\n"),
        relaxedBounds,
        "End"
    ].join("\n");


    // ============================================================================
    // ITERATIVE SOLVER LOOP
    // ============================================================================
    let timeRemaining = GLOBAL_TIME_LIMIT;
    let currentRoster = null;       // Holds the smoothed roster for next iteration's bias
    let bestSolution = null;        // Stores the best solution found so far
    let minTotalCost = Infinity;    // Stores the lowest total cost found so far
    console.time("TotalSolverDuration");

    while (timeRemaining > 0) {
        console.log(`%c--- INITIALIZING SOLVER INTERVAL: ${((GLOBAL_TIME_LIMIT - timeRemaining + INTERVAL)/INTERVAL).toFixed(0)} ---`, "color: blue; font-weight: bold;");

        // --- DYNAMIC OBJECTIVE FUNCTION GENERATOR ---
        // Rebuild the Objective Function every loop, to apply feasible region weights
        let objTerms = [];

        employees.forEach((emp, eIdx) => {
            const base = parseFloat(emp.pay) || 20;
            const gP = base * 100.0;          // Gap Penalty Factor

            // Payroll Costs (Minimize Wages)
            objTerms.push(`${fmt(base)} reg_${eIdx}`);
            objTerms.push(`${fmt(base * 1.5)} ot_${eIdx}`);
            objTerms.push(`${fmt(MIN_HR_PENALTY)} s_min_${eIdx}`);

            for (let d = 0; d < 7; d++) {
                const avail = getEmpDayAvail(emp, d);
                if (avail.length === 0) continue;

                // ------------------------------------------------------------
                // CONTIGUITY PENALTY
                // ------------------------------------------------------------
                /* Cost = Penalty * (End - Start - HoursWorked)
                 * This penalizes unscheduled gaps inside a shift, by penalizing
                 * gaps greater than worked or OT hours.
                 */
                objTerms.push(`${fmt(gP)} end_e${eIdx}_d${d}`);
                objTerms.push(`-${fmt(gP)} start_e${eIdx}_d${d}`);
                objTerms.push(`${fmt(gP)} da_${eIdx}_${d}`);

                avail.forEach(h => {
                    const t = d * 24 + h;
                    // Subtract 1 unit of Penalty for every hour actually worked
                    objTerms.push(`-${fmt(gP)} y_${eIdx}_${t}`);

                    // ------------------------------------------------------------
                    // WARM START BIAS
                    // ------------------------------------------------------------
                    /* If this employee worked this specific hour in the previous "Best"
                     * schedule, we give a discount (negative cost) to working it again.
                     * This creates a "gravity well" around the previous solution. In
                     * which feasible solutions are used to build a more optimal solution.
                     */
                    if (currentRoster && currentRoster[eIdx].schedule[t]) {
                        objTerms.push(`-${fmt(WARM_START_BONUS)} y_${eIdx}_${t}`);
                    }
                });
            }
        });

        // Demand Penalties to Minimize Demand Slack
        validHours.forEach(t => {
            skillNames.forEach((_, sIdx) => {
                if (skillDemandAtT[t][sIdx] > 0) {
                    objTerms.push(`${fmt(DEMAND_PENALTY)} s_dem_${sIdx}_${t}`);
                }
            });
        });

        // Combine Dynamic Head + Static Body (CONSTRAINTS)
        const currentLPString = "Minimize\n obj: " + objTerms.join(" + ") + "\n" + lpBody;

        // --- SOLVE ---
        const result = highsModule.solve(currentLPString, {
            time_limit: Math.min(INTERVAL, timeRemaining), // Set solver time limit to be at most the interval
            presolve: 'on',
            mip_rel_gap: 0.05   // Stop if within 5% of mathematical perfection
        });

        // If this interval fails, return the last known good solution.
        if (!result.Columns) {
            console.warn("Solver Interval returned no columns (Infeasible/Timeout). Reverting to best found.");
            break;
        }

        // --- PARSE & SMOOTH ---
        let rawRoster = employees.map((emp, eIdx) => {
            let schedule = Array(168).fill(null);
            for (let t = 0; t < 168; t++) {
                // If binary y > 0.5, the employee is working
                if ((result.Columns[`y_${eIdx}_${t}`]?.Primal || 0) > 0.5) {
                    let assignedRole = "Assigned";
                    let maxVal = 0;
                    // Find which 'w' skill variable is active
                    skillNames.forEach((s, sIdx) => {
                        const val = result.Columns[`w_${eIdx}_${t}_${sIdx}`]?.Primal || 0;
                        if (val > 0.5) assignedRole = s;
                        else if (val > maxVal && val > 0.1) { maxVal = val; assignedRole = s; }
                    });
                    schedule[t] = assignedRole;
                }
            }
            return {
                id: emp.id, skills: emp.skills, pay: parseFloat(emp.pay) || 15,
                schedule,
                regHrs: result.Columns[`reg_${eIdx}`]?.Primal || 0,
                otHrs: result.Columns[`ot_${eIdx}`]?.Primal || 0
            };
        });

        // Apply Heuristic Skill Smoothing and Fill-in
        const smoothedRoster = smoothSkillAllocation(rawRoster, demands, skillNames, employees);

        // --- CALCULATE WAGES ---
        let tWages = 0;
        let tOT = 0;

        smoothedRoster.forEach(e => {
            tWages += (e.regHrs * e.pay);
            tOT += (e.otHrs * e.pay * 1.5);
        });
        const currentRealCost = tWages + tOT;

        console.log(`Interval Result for Headcount ${preferredCount}: Cost $${currentRealCost.toFixed(2)} (Objective: ${result.ObjectiveValue.toFixed(2)})`);

        // Update loop state for next "Warm Start" iteration
        currentRoster = smoothedRoster;

        // Compare Wages to the best solution found so far
        if (currentRealCost < (minTotalCost - 0.01)) {
            console.log(`>> Improvement Found! ($${minTotalCost.toFixed(2)} -> $${currentRealCost.toFixed(2)})`);
            // Store the new best solution
            minTotalCost = currentRealCost;
            bestSolution = {
                status: 'Optimal',
                result: {
                    roster: smoothedRoster,
                    objective: result.ObjectiveValue,
                    overTime: tOT,
                    actualLaborCost: currentRealCost.toFixed(2)
                }
            };
        } else {
            // If no improvement, terminate the solver
            console.log(`>> No improvement in Labor Cost. (Current: $${currentRealCost.toFixed(2)} vs Best: $${minTotalCost.toFixed(2)})`);
            break;
        }

        // If the global time limit has been reached, stop the solver
        timeRemaining -= INTERVAL;
        if (timeRemaining <= 0) console.log(">> Global Time Limit Reached.");
    }

    console.timeEnd("TotalSolverDuration");

    // ============================================================================
    // RETURN BEST FOUND SOLUTION
    // ============================================================================
    if (bestSolution) {
        console.log("%c--- FINANCIAL SUMMARY (BEST) ---", "color: #0b8f0bff; font-weight: bold;");
        console.table({
            "Solver Objective": { Value: bestSolution.result.objective.toFixed(2) },
            "Total Labor Cost": { Value: `$${bestSolution.result.actualLaborCost}` }
        });
        return bestSolution;
    }

    return { status: 'Error', error: "Loop failed to produce any feasible result" };
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
        const output = await solveSchedulingMILP(data);
        // Post a message back to the main thread with the result data;
        // The spread operator (...) merges the result object with the type field
        self.postMessage({ type: 'result', ...output });
    }
};