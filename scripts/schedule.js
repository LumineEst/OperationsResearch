/**
 * scripts/schedule.js
 * ==============================================================================
 * Strategic Workforce Optimizer - Scheduling Module
 * ==============================================================================
 * Description:
 * Orchestrates workforce management, employee profiling, and labor demand
 * projections. Integrates with a MILP solver to generate optimized shift
 * rosters. Features a predictive training engine that analyzes personnel
 * availability against system-wide coverage smoothing within optimal blocks.
 * Uses D3 to render comparative supply/demand charts and Gantt rosters.
 * @author Joel Wood
 */
window.ScheduleModule = {
    skillNames: ["Cashiers", "Stocking", "Customer Service", "BackRoom", "Floor Associate"],

    //Initializes module event listeners and binds UI controls to the solver request cycle.
    init() {
        ['minRest', 'maxShift', 'hourlyRate'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => this.requestSolve());
        });

        // Add event listener for employee count input
        const empCountInput = document.getElementById('employeeCount');
        if (empCountInput) {
            empCountInput.addEventListener('change', () => this.requestSolve());
            empCountInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    empCountInput.blur();
                    this.requestSolve();
                }
            });
        }

        // Add event listener for employee search and list connectivity
        document.getElementById('employeeSearch')?.addEventListener('input', (e) => {
            ScheduleModule.renderEmployeeList(e.target.value);
        });
        window.selectEmployee = (id) => this.selectEmployee(id);
    },

    /**Coordinates chart rendering and sidebar visibility based on the active sub-tab.
     * This function is triggered when a user switches between sub-tabs in the scheduling module.
     * It adjusts the display of the employee list and renders the appropriate chart based on the
     * active sub-tab. The active sub-tab is determined from the 'active' class on the tab buttons.
     */
    drawCharts() {
        // Get the active sub-tab from the 'active' class on the tab buttons
        const activeSubTab = document.querySelector('#schedTabs .tab-btn.active')?.dataset.tab;
        // Get the container for the employee list
        const listContainer = document.getElementById('employee-list-container');

        if (listContainer) {
            // If the active sub-tab is 'employees', show the employee list and render the list
            if (activeSubTab === 'employees') {
                listContainer.style.display = 'block';
                this.renderEmployeeList();
            } else {
                // If the active sub-tab is not 'employees', hide the employee list
                listContainer.style.display = 'none';
            }
        }

        // If the active sub-tab is 'scheduling', draw the roster chart
        if (activeSubTab === 'scheduling') {
            this.drawRosterChart();
        }
        // If the active sub-tab is 'employees', select the currently selected employee
        else if (activeSubTab === 'employees') {
            if (!window.schedState.selectedEmpId && window.schedState.employees.length > 0) {
                // If there is no selected employee select the first employee
                window.schedState.selectedEmpId = window.schedState.employees[0].id;
            }
            if (window.schedState.selectedEmpId) {
                // If there is a selected employee, select that employee in the employee list
                this.selectEmployee(window.schedState.selectedEmpId);
            }
        }
        // If the active sub-tab is 'demands', draw the demand charts
        else if (activeSubTab === 'demands') {
            this.drawSchedulingCharts();
        }
    },

    /**Requests that the workforce model be solved using the MILP worker, scheduleWorker.js. 
     * This function dispatches the model and manage the solver countdown, and renders the
     * solver dashboard and the various employee, scheduling, and demand charts..
     */
    requestSolve() {
        if (!window.schedState.employees.length) return;
        // Reset KPI Scorecard
        if (window.resetGlobalKPI) window.resetGlobalKPI();

        // Restart the global solver countdown, and render the solver dashboard
        window.schedState.solverTimeLeft = 600;
        this.startGlobalTicker();
        this.renderSolverDashboard();

        // Prepare the parameters for the worker
        const params = {
            // Copy the list of employees to the parameters
            employees: JSON.parse(JSON.stringify(window.schedState.employees)),
            // Copy the list of demands to the parameters
            demands: JSON.parse(JSON.stringify(window.schedState.demands)),
            // Get the number of employees to prefer from the UI
            preferredEmployees: document.getElementById('employeeCount')?.value || 100
        };

        // Create a new Worker Instance
        if (window.currentWorker) window.currentWorker.terminate();
        window.currentWorker = new Worker('scripts/scheduleWorker.js');

        // Define the handler for the worker messages
        window.currentWorker.onmessage = (e) => {
            // Decrement the solver time left
            window.schedState.solverTimeLeft = 0;
            clearInterval(this.tickerInterval);

            // Get the message type, status, and result
            const { type, status, result } = e.data;

            // If optimal, update the global state and update the UI
            if (type === 'result' && status === 'Optimal') {
                window.schedState.results = result;

                if (window.updateResultsUI) {
                    window.updateResultsUI();
                }

                updateStatus("Optimal Roster Found", "optimal");
            } else {
                // If not 'Optimal', update the status message and scheduling panel error message
                updateStatus("Infeasible", "error");
                document.getElementById('scheduling-panel-sub').innerHTML =
                    `<div class="error-state">Optimization failed: ${status}</div>`;
            }
        };

        // Post the parameters to the worker to start the optimization
        window.currentWorker.postMessage({ type: 'solve', data: params });
    },

    /**Updates the background solver countdown in the global state.
     * This function starts a ticker interval that decrements the solver time left 
     * and updates the global state and the countdown display.  When the time left 
     * is 0, the ticker is stopped.  Set to 5 minutes to match the Worker Timeout.
     */
    startGlobalTicker() {
        if (this.tickerInterval) clearInterval(this.tickerInterval); // Reset the ticker
        // Start a new ticker interval that runs every 1000ms (1s)
        this.tickerInterval = setInterval(() => {
            // Check if the solver time left is still greater than 0
            if (window.schedState.solverTimeLeft > 0) {
                window.schedState.solverTimeLeft--; // Decrement the solver time left
                const display = document.getElementById('solverCountdown'); // Get the countdown display element
                if (display) {
                    // Calculate the minutes and seconds from the time left, and format as MM:SS
                    const mins = Math.floor(window.schedState.solverTimeLeft / 60);
                    const secs = window.schedState.solverTimeLeft % 60;
                    const formattedTime = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                    display.textContent = formattedTime; // Set the text content of the display to the formatted time
                }
            } else {
                // If the time left is 0, stop the ticker
                clearInterval(this.tickerInterval);
            }
        }, 1000);
    },

    /**Renders the model complexity metrics and solver countdown.
     * This function generates a dashboard panel to display the current model complexity metrics 
     * and the current remaining runtime of the solver.  Due to the 5 minute runtime, it is essential 
     * to communicate why and track how long a computation will take, to the end-user.
     * The model complexity metrics include:
     * - The total number of parameters (global, binary, and continuous)
     * - The number of binary decision variables
     * - The number of continuous decision variables
     * - The total number of constraints in the model
     * The solver countdown displays the current runtime of the solver in
     * minutes and seconds and updates every second until the runtime is 0.
     * @returns {void}
     */
    renderSolverDashboard() {
        const container = document.getElementById('scheduling-panel-sub');
        if (!container) return;

        // Calculate the total number of parameters in the model
        const E = window.schedState.employees.length; // Number of employees
        const S = this.skillNames.length; // Number of skill levels (1-5)
        const T = 77; // Number of hours in a week
        const D = 7; // Number of days in a week

        // Binary decision variables
        const binaryVars = (E * T); // Total number of binary decision variables
        // Continuous decision variables = Assignments + Shift Bounds + Demand Slack
        const continuousVars = (E * T * S) + (E * D * 3) + (E * 4) + (T * S); // Total number of continuous decision variables
        // Total constraints = Demand Satisfaction + Skill Linking and Bounds + Daily Shift Logic + Balancing Capacity and Global Links
        const totalConstraints = (E * T * 4) + (E * D * 6) + (E * T * S * 1) + + (E * S) + (E * 4) + (T * S) + 1; // Total number of constraints

        // Calculate the time left in minutes and seconds
        const mins = Math.floor(window.schedState.solverTimeLeft / 60);
        const secs = window.schedState.solverTimeLeft % 60;
        const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`; // Time left formatted as MM:SS

        // Generate inner HTML for the temporary model solving dashboard
        container.innerHTML = `
            <div class="solver-dashboard">
                <div class="timer-section">
                    <h3>Scheduling Optimizer Solver Active</h3>
                    <div id="solverCountdown" class="countdown-clock">${timeStr}</div>
                    <p>Currently Performing Deep Solve</p>
                </div>
                <hr class="sidebar-divider">
                <div class="metrics-grid">
                    <h4>Model Complexity</h4>
                    <table class="metrics-table">
                        <tr><td>Binary Decision Variables:</td><td>${binaryVars.toLocaleString()}</td></tr>
                        <tr><td>Continuous Decision Variables:</td><td>${continuousVars.toLocaleString()}</td></tr>
                        <tr><td>Constraints:</td><td>${totalConstraints.toLocaleString()}</td></tr>
                    </table>
                </div>
            </div>`;
    },

    /**Parses employee availability and labor demand from XLSX workbook data.
     * This function takes an XLSX workbook as input and processes two specific sheets:
     * 'Employees Requests' and 'Company Demands' (or 'Demands').
     * The 'Employees Requests' sheet contains information about each employee, including their
     * pay rate, minimum and maximum hours they can work, and their availability on each day of the week,
     * broken down by hour.
     * The 'Company Demands' (or 'Demands') sheet contains the labor demand for each role and hour
     * of the week.
     * @param {Workbook} workbook - The XLSX workbook to process
     */
    processWorkbook(workbook) {
        try {
            // --- Process the 'Employees Requests' sheet ---
            const empSheet = workbook.Sheets["Employees Requests"];
            if (!empSheet) throw new Error("Sheet 'Employees Requests' not found");
            const rows = XLSX.utils.sheet_to_json(empSheet, { header: 1 }); // Convert the sheet to a JSON object
            // Extract the employee IDs from the first row of data
            const empIds = rows[0].slice(1).filter(id => id !== undefined && id !== "").sort();
            window.schedState.employees = empIds.map((id) => {
                const col = rows[0].indexOf(id); // Find the column index of the employee's ID in the first row of data
                // Build an employee object mapped to its ID
                return {
                    id: String(id),
                    pay: rows[1][col] || 20, // Pay rate (default 20)
                    minHrs: rows[2][col] || 0, // Minimum hours they can work (default 0)
                    maxHrs: rows[3][col] || 40, // Maximum hours they can work (default 40)
                    skills: this.skillNames.filter((_, i) => rows[4 + i] && Number(rows[4 + i][col]) === 1), // Skills Trained
                    // Each index represents a day of the week (0-Sun, 6-Sat) with an array of available hours
                    availability: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }
                };
            });

            // Populate the availability object for each employee based on the availability data in the rows
            for (let r = 10; r < rows.length; r++) {
                const row = rows[r];
                if (!row || !row[0]) continue;
                const parts = String(row[0]).split(',');
                if (parts.length < 2) continue;
                const d = parseInt(parts[0]), h = parseInt(parts[1]);
                // For each employee, if they have availability for the given day and hour, add the hour to their availability array
                window.schedState.employees.forEach(emp => {
                    const col = rows[0].indexOf(emp.id);
                    if (Number(row[col]) === 1 && emp.availability[d]) emp.availability[d].push(h);
                });
            }

            // --- Process the 'Company Demands' (or 'Demands') sheet ---
            const demandSheet = workbook.Sheets["Company Demands"] || workbook.Sheets["Demands"];
            if (demandSheet) {
                const raw = XLSX.utils.sheet_to_json(demandSheet); // Convert the sheet to a JSON object
                // Build a map where role demand for each hour of the week is mapped to the number of employees
                const demandMap = {};
                raw.forEach(row => demandMap[row["Required Employees"]] = row);
                // An array of normalized demand, where each slot is the day and hour and the role demand for each skill
                const normalized = [];
                for (let d = 0; d < 7; d++) {
                    for (let h = 0; h < 24; h++) {
                        const lookup = `${d},${h}`;
                        // Get the slot object from the demand map or a default object if not found
                        const existing = demandMap[lookup] || {};
                        // Build a slot object with the relevant data
                        const slot = { day: d, hour: h };
                        this.skillNames.forEach(s => slot[s] = parseFloat(existing[s]) || 0);
                        normalized.push(slot); // Add the slot object to the array
                    }
                }

                window.schedState.demands = normalized; // Set the demand data in the global state
            }

            // Draw the charts and request a solve
            this.drawCharts();
            this.requestSolve();
        } catch (err) { updateStatus("Import Error", "error"); }
    },

    /**Exports optimized rosters and improvement audits to an Excel file.
     * The file is saved with a timestamp in the filename to support multiple exports.
     * The exported file has two sheets:
     * 1. Schedule by Day: shows the schedule by hour and day, with each row representing an hour.
     * The first column is the day, the second column is the hour, and the remaining columns are the employees.
     * Each cell in a column represents whether an employee is scheduled for that hour (X) or not (-).
     * 2. Schedule by Employee: shows the schedule by hour for each employee, with each row representing an hour.
     * The first column is the employee ID, and the remaining columns are the hours.
     * Each cell in a row represents whether an employee is scheduled for that hour (X) or not (-).
     */
    exportResults() {
        // No optimized results found, alert the user and return
        if (!window.schedState.results) {
            alert("No optimized results found to export.");
            return;
        }

        const wb = XLSX.utils.book_new(); // Create a new workbook
        const roster = window.schedState.results.roster;
        const demands = window.schedState.demands;
        const employees = window.schedState.employees;

        // Prepare the data for the Schedule by Day sheet
        const dayHeader = ["Day", "Hour", ...roster.map(e => e.id)];
        const dayRows = [];
        for (let t = 0; t < 168; t++) {
            const d = Math.floor(t / 24), h = t % 24; // Calculate the day and hour for the current time step
            const hourDem = demands.find(dem => dem.day === d && dem.hour === h); // Find the demand for current hour and day
            const hasActivity = (this.skillNames.some(s => hourDem && hourDem[s] > 0) || roster.some(e => e.schedule[t] !== null));
            if (hasActivity) {
                dayRows.push([days[d], `${h}:00`, ...roster.map(emp => emp.schedule[t] || "-")]);
            }
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([dayHeader, ...dayRows]), "Schedule by Day");

        // Prepare the data for the Schedule by Employee sheet
        const empHeader = ["Employee ID", ...Array.from({ length: 168 }, (_, i) => `${days[Math.floor(i / 24)]} ${i % 24}:00`)];
        const empRows = roster.map(emp => [emp.id, ...emp.schedule.map(r => r || "-")]);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([empHeader, ...empRows]), "Schedule by Employee");

        // Write the workbook for Download
        XLSX.writeFile(wb, `Workforce_Optimization.xlsx`);
    },

    /**Renders the employee list in the left sidebar. This function is responsible for generating
     * the visual representation of the list of employees. Each employee is represented by a <div>
     * element with the class 'emp-item'. If an employee is selected (i.e., the user clicked on it),
     * the 'emp-item' class is augmented with the 'active' class.
     * The function first gets the reference to the DOM element with the id 'employeeList'. If this
     * element is not found, the function returns immediately and does nothing.
     * Inside the loop, the function creates a new <div> element for each employee. The text content
     * of this element is the employee's ID. The onclick event handler is set to call the
     * window.selectEmployee function with the employee's ID as argument.
     * The 'active' class is added to the element if the employee is selected. This way, the
     * selected employee is highlighted in the list.
     * The new element is then appended to the 'employeeList' element.
     */
    renderEmployeeList(filter = '') {
        const list = document.getElementById('employeeList');
        if (!list) return;
        list.innerHTML = '';
        const searchTerm = (filter || '').toLowerCase();

        window.schedState.employees.forEach(emp => {
            if (emp.id.toLowerCase().includes(searchTerm)) {
                const item = document.createElement('div');
                item.className = 'emp-item' + (window.schedState.selectedEmpId === emp.id ? ' active' : '');
                item.textContent = emp.id;
                item.onclick = () => window.selectEmployee(emp.id);
                list.appendChild(item);
            }
        });
    },

    /**Employee Selection Handler: Updates the application state to reflect the selected employee,
     * and generates visualizations to display information about the employee, such as availability,
     * qualifications, and recommendations for training.
     * @param {string} id - The ID of the employee to select.
     */
    selectEmployee(id) {
        window.schedState.selectedEmpId = String(id);
        const emp = window.schedState.employees.find(e => e.id === String(id));
        if (!emp) return;

        document.querySelectorAll('.emp-item').forEach(el => {
            el.classList.toggle('active', el.textContent === String(id));
        });
        const color = d3.scaleOrdinal().domain(this.skillNames).range(d3.schemeCategory10);

        // Calculate live utilization metrics (Scheduled vs Overtime)
        let schedHrs = 0;
        const rosterEntry = window.schedState.results?.roster?.find(r => r.id === emp.id);
        if (rosterEntry) {
            rosterEntry.schedule.forEach(role => { if (role) schedHrs++; });
        }
        const otHrs = Math.max(0, schedHrs - 40);

        const profileCard = document.querySelector('#employees-panel .detail-card:first-child');
        if (profileCard) {
            profileCard.querySelector('h3').innerHTML = `Employee Profile <span style="float:right; color:#2980b9; font-weight:400;"># ${emp.id}</span>`;

            // Skill List Generation (Color-coded)
            const skillsHtml = emp.skills.map(s => `<div style="color:${color(s)}; font-weight:bold; margin-bottom:4px;">• ${s}</div>`).join('') || '<div style="color:#888;">No skills assigned</div>';
            document.getElementById('employeeProfileContent').innerHTML = `
                <div class="profile-grid" style="display:grid; grid-template-columns: 1.2fr 1fr; gap: 20px;">
                    <div class="metrics-column">
                        <div class="profile-stat"><strong>Hourly Pay:</strong> $${parseFloat(emp.pay).toFixed(2)}/hr</div>
                        <div class="profile-stat"><strong>Min Hours:</strong> ${emp.minHrs}</div>
                        <div class="profile-stat"><strong>Max Hours:</strong> ${emp.maxHrs}</div>
                        <div style="margin-top:10px; padding-top:10px; border-top:1px solid #eee;">
                            <div class="profile-stat"><strong>Scheduled:</strong> ${schedHrs} hrs</div>
                            <div class="profile-stat" style="color:${otHrs > 0 ? 'var(--danger)' : 'inherit'};"><strong>Overtime:</strong> ${otHrs} hrs</div>
                        </div>
                    </div>
                    <div class="skills-column">
                        <label style="font-size:0.75rem; font-weight:bold; color:#888; display:block; margin-bottom:5px;">QUALIFIED SKILLS</label>
                        ${skillsHtml}
                    </div>
                </div>
                <div id="trainingRecs" style="margin-top:20px; padding-top:15px; border-top:1px solid #ddd;"></div>`;
        }

        // Trigger recommendation heuristic, where employee availability is compared to scheduling smoothness
        this.generateRecommendations(emp);

        const availEl = document.getElementById('employeeAvailabilityContent');
        if (availEl) {
            const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
            let html = `<table class="availability-table" style="width:100%">`;
            dayNames.forEach((name, idx) => {
                const sorted = [...(emp.availability[idx] || [])].sort((a, b) => a - b);
                let timeStr = sorted.length > 0 ? sorted[0] + ":00 - " + (sorted[sorted.length - 1] + 1) + ":00" : "Not Available";
                html += `<tr><td style="width:35%; font-weight:bold; color: #666;">${name}</td><td style="color:#222">${timeStr}</td></tr>`;
            });
            availEl.innerHTML = html + `</table>`;
        }
        // Generate Employee Schedule Chart
        this.renderIndividualGantt(emp);
    },

    /**Generates training recommendations for an individual employee based on
     * system scarity and employee availability.
     * The function first retrieves the necessary global state (results, demands,
     * employees), then loops through all hours in the week and identifies which hours 
     * the employee is available and which hours have a labor demand (hourDem).
     * For each hourDem, it checks which skills are in demand and which skills
     * the employee has. If there's a skills imbalance, it saves the relevant
     * information (skill, day, hour, buffer) in the gaps array.
     * After the loop, the function sorts the gaps array by buffer (how critical
     * the shortage is) and selects the top 3 skills with the highest buffer
     * values. It then generates an HTML string describing each recommendation and 
     * the associated skill, day, and buffer value.
     * @param {Object} emp - The employee object to generate recommendations for.
     */
    generateRecommendations(emp) {
        const recContainer = document.getElementById('trainingRecs');
        if (!recContainer) return;

        const results = window.schedState.results, demands = window.schedState.demands, allEmps = window.schedState.employees;
        if (!results) {
            recContainer.innerHTML = `<p style="font-size:0.8rem; color:#888; font-style:italic;">Solve roster to generate recommendations.</p>`;
            return;
        }

        let gaps = []; // Array to save skills shortage information
        for (let t = 0; t < 168; t++) { // Loop through all hours in the week
            const d = Math.floor(t / 24), h = t % 24; // Calculate the day and hour
            if (!emp.availability[d].includes(h)) continue; // If the employee is not available, skip to the next hour

            const hourDem = demands.find(dem => dem.day === d && dem.hour === h); // Check which hour has a labor demand
            if (!hourDem) continue; // If there's no labor demand, skip to the next hour

            // For each skill in the hourDem, check if the employee has the skill.
            // If the employee is missing a skill, save the relevant information in the gaps array.
            this.skillNames.forEach(skill => {
                const req = hourDem[skill] || 0;
                if (req === 0 || emp.skills.includes(skill)) return;

                const qualAvail = allEmps.filter(e => e.skills.includes(skill) && e.availability[d].includes(h)).length;
                gaps.push({ skill, day: d, hour: h, buffer: qualAvail - req });
            });
        }

        // Sort the gaps array by buffer (how critical the shortage is) and select the top 3 skills with the highest buffer values.
        const topRecs = gaps.sort((a, b) => a.buffer - b.buffer).slice(0, 3);
        const color = d3.scaleOrdinal().domain(this.skillNames).range(d3.schemeCategory10);

        let html = `<h4 style="margin:0 0 10px 0; font-size:0.85rem; color:var(--secondary);">Optimization Opportunities</h4>`;
        if (topRecs.length === 0) { // If no recommendations found, display a message
            html += `<p style="font-size:0.75rem; color:#666;">This employee's current skill set is fully optimized for their availability.</p>`;
        } else {
            topRecs.forEach(r => { // For each recommendation, generate an HTML string recommending new skills to help smooth scheduling.
                html += `
                <div style="margin-bottom:8px; font-size:0.75rem; border-left:3px solid ${color(r.skill)}; padding-left:8px;">
                    Learn <span style="color:${color(r.skill)}; font-weight:bold;">${r.skill}</span> to cover
                    ${days[r.day]} at ${r.hour}:00 - (Current Buffer: ${r.buffer})
                </div>`;
            });
        }
        recContainer.innerHTML = html; // Render the HTML in the container
    },

    /**
    * Orchestrates the Golden Section Search using the WorkforceOptimizer class.
    * Updates the UI with status messages, runs the search, and applies the optimal result.
    */
    async runStaffingOptimizer() {
        if (!window.schedState.employees.length) return;

        const btn = document.getElementById('btnOptimizeStaff');
        const statusContainer = document.getElementById('scheduling-panel-sub');
        const originalText = btn.textContent;

        // Resetting the GUI and disabling the button while the search is running
        btn.disabled = true;
        btn.textContent = "Running Optimization..."; {
            if (window.currentWorker) {
                window.currentWorker.terminate();
                window.currentWorker = null;
                if (this.tickerInterval) {
                    clearInterval(this.tickerInterval);
                    this.tickerInterval = null;
                }
            }
        }
        if (statusContainer) {
            statusContainer.innerHTML = `
                <div class="solver-dashboard">
                    <div class="timer-section">
                        <h3 style="color:#8e44ad;">Staffing Level Optimizer Active</h3>
                        <p>Performing Multi-Thread Optimal Staffing Search...<br></p>
                        <div class="loading-spinner"></div>
                    </div>
                    <div class="metrics-grid">
                        <p>One Worker is performing a Golden Search, while the other Worker is using an opposing Bisection Search to Aggressively Prune the Search Space--reducing search time by almost 40%<br>Iterations may be tracked using the Browser's Developer Tools.</p>
                        <p>This search may take up to an hour, Please wait...</p>
                    </div>
                </div>`;
        }

        try {
            // Prepare Data
            const params = {
                employees: JSON.parse(JSON.stringify(window.schedState.employees)),
                demands: JSON.parse(JSON.stringify(window.schedState.demands))
            };

            // Instantiate and Run Optimizer with 2 workers for parallel search steps
            const optimizer = new WorkforceOptimizer('scripts/scheduleWorker.js', 2);
            const bestResult = await optimizer.findOptimalHeadcount(params);

            // Apply Results
            if (bestResult) {
                // Update Global State and Preferred Employee Input Field
                window.schedState.results = bestResult; // The full result object
                const optimalCount = bestResult.optimalHeadcount || document.getElementById('employeeCount').value;
                document.getElementById('employeeCount').value = optimalCount;
                if (window.updateResultsUI) {
                    window.updateResultsUI();
                }
                // Render Charts
                this.drawCharts();
                updateStatus(`Optimization Complete: ${optimalCount} Employees`, "optimal");
            }

        } catch (err) {
            console.error("Optimization Error:", err);
            updateStatus("Optimization Failed", "error");
            if (statusContainer) statusContainer.innerHTML = `<div class="error-state">Optimization failed: ${err.message}</div>`;
        } finally {
            // Reset Button State
            btn.disabled = false;
            btn.textContent = originalText;
        }
    },

    /**Renders an individual weekly Gantt chart with an enlarged dynamic legend using the global initChart utility.
     * The Gantt chart shows the employee's weekly availability and role assignments in 
     * 1-hour increments for each day of the week.
     * @param {Object} emp - The employee object containing availability and role assignment data.
     */
    renderIndividualGantt(emp) {
        // Use the utility to handle SVG setup and standard margins.
        const chart = window.initChart('individualGantt', { top: 20, left: 60 });
        const header = document.querySelector('#individualScheduleContainer h3');
        if (!chart || !header) return;

        const { svg, width } = chart;
        const color = d3.scaleOrdinal().domain(this.skillNames).range(d3.schemeCategory10); // Create a color scale

        // Enlarged Legend Generation (including Availability)
        let legendHtml = `<div style="display:inline-flex; gap:15px; margin-left:20px; font-size:0.85rem; font-weight:500; vertical-align:middle;">`;
        legendHtml += `<div style="display:flex; align-items:center;"><div style="width:12px; height:12px; background:#c3e6cb; margin-right:5px; border-radius:2px; opacity:0.6;"></div>Availability</div>`;
        // Add a legend item for each skill
        this.skillNames.forEach(skill => {
            legendHtml += `<div style="display:flex; align-items:center;"><div style="width:12px; height:12px; background:${color(skill)}; margin-right:5px; border-radius:2px;"></div>${skill}</div>`;
        });
        legendHtml += `</div>`;
        // Set the header content
        header.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center; width:100%;"><span>Weekly Schedule Detail</span> ${legendHtml}</div>`;

        const height = 7 * 40;
        // Update SVG height to accommodate the 7-day height
        d3.select('#individualGantt svg').attr("height", height + 50);

        const x = d3.scaleLinear().domain([0, 24]).range([0, width]); // Create the x-axis scale
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]; // Day names

        // Draw each day of the week
        dayNames.forEach((day, dIdx) => {
            const y = dIdx * 40; // Calculate the y-position for the day
            svg.append("text").attr("x", -10).attr("y", y + 20).attr("text-anchor", "end").style("font-size", "12px").text(day); // Add the day name
            svg.append("rect").attr("x", 0).attr("y", y).attr("width", width).attr("height", 30).attr("fill", "#f8f9fa").attr("stroke", "#eee").attr("rx", 4); // Add a background rectangle for the day

            // Draw each availability segment for the day
            if (emp.availability[dIdx]) {
                emp.availability[dIdx].forEach(h => { // For each availability segment, create a rectangle
                    svg.append("rect").attr("x", x(h)).attr("y", y).attr("width", x(1) - x(0))
                        .attr("height", 30).attr("fill", "#a2ddb0").attr("opacity", 0.6);
                });
            }

            // Draw each role assignment for the day
            if (window.schedState.results?.roster) { // If there's a roster, draw the role assignments
                const rosterEntry = window.schedState.results.roster.find(r => r.id === emp.id); // Get the roster entry for the employee
                if (rosterEntry) {
                    for (let h = 0; h < 24; h++) { // For each hour, create a rectangle
                        const role = rosterEntry.schedule[dIdx * 24 + h]; // Get the role assignment for the hour
                        if (role) {
                            svg.append("rect").attr("x", x(h)).attr("y", y + 4).attr("width", x(1) - x(0) - 1).attr("height", 22)
                                .attr("fill", color(role)).attr("rx", 2)
                                .on("mouseover", (e) => { // Add a tooltip when the mouse hovers over the rectangle
                                    const timeStr = `${h}:00 - ${h + 1}:00`;
                                    window.showTooltip(`<strong>${day} ${timeStr}</strong><br>Role: ${role}`, e);
                                })
                                .on("mouseout", () => window.hideTooltip()); // Hide the tooltip when the mouse moves out of the rectangle
                        }
                    }
                }
            }
        });
        svg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x).ticks(12).tickFormat(d => d + ":00")); // Add the x-axis with hour labels
    },

    /**Renders the daily roster segments and the Labor Summary and Recommendations.
     * This function creates a visualization of the daily roster, showing the rostered
     * employees for each hour of the day, and providing statistics on the daily labor
     * overages and top 10 training opportunities.
     */
    drawRosterChart() {
        const container = document.getElementById('scheduling-panel-sub');
        if (!container || !window.schedState.results) return;

        const rosterSelect = document.getElementById('rosterDaySelect');
        const selectedDay = rosterSelect ? parseInt(rosterSelect.value) : 0;
        const roster = window.schedState.results.roster, demands = window.schedState.demands;

        // --- Generate Legend HTML ---
        const color = d3.scaleOrdinal().domain(this.skillNames).range(d3.schemeCategory10);
        let legendHtml = `<div style="display:inline-flex; gap:12px; font-size:0.8rem; margin-right:15px;">`;
        this.skillNames.forEach(skill => {
            legendHtml += `<div style="display:flex; align-items:center;"><div style="width:10px; height:10px; background:${color(skill)}; margin-right:4px; border-radius:2px;"></div>${skill}</div>`;
        });
        legendHtml += `</div>`;

        const dailyDemands = demands.filter(d => d.day === selectedDay);
        const activeHours = dailyDemands.filter(d => this.skillNames.some(s => d[s] > 0)).map(d => d.hour);
        const minH = activeHours.length > 0 ? Math.min(...activeHours) : 0;
        const maxH = activeHours.length > 0 ? Math.max(...activeHours) : 23;

        const filteredData = roster.filter(emp => {
            const daySlice = emp.schedule.slice(selectedDay * 24 + minH, selectedDay * 24 + maxH + 1);
            return daySlice.some(role => role !== null);
        });

        // FULL HTML UPDATE: Includes the stats column required by render7DayStats
        container.innerHTML = `
        <div class="roster-split-view" style="display: flex; gap: 20px; align-items: flex-start;">
            <div class="roster-visual-column" style="flex: 1.4; min-width: 0;">
                <div class="roster-header" style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                    <h3>Roster: ${days[selectedDay]} (${minH}:00 - ${maxH + 1}:00)</h3>
                    <div style="display:flex; align-items:center;">${legendHtml}
                        <select id="rosterDaySelect" onchange="window.ScheduleModule.drawCharts()" style="padding:5px; border-radius:4px;">
                            ${[0, 1, 2, 3, 4, 5, 6].map(i => `<option value="${i}" ${selectedDay === i ? 'selected' : ''}>${days[i]}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div id="rosterGanttContainer" style="background:#fff; border:1px solid #eee; border-radius:8px; padding:15px;"></div>
            </div>
            <div class="roster-stats-column" style="flex: 1; background: #f8f9fa; padding: 20px; border-radius: 8px; border: 1px solid #ddd;">
                <h3 style="margin-top:0;">Daily Labor Overages</h3>
                <div id="weeklySlackBreakdown"></div> <hr class="sidebar-divider">
                <h4 style="margin-bottom:10px; color: #2980b9;">Top 10 High-Risk Coverage Gaps</h4>
                <div id="trainingOpportunities"></div> </div>
        </div>`;

        this.renderGantt(filteredData, selectedDay, minH, maxH, color);
        this.render7DayStats(); // This can now find the elements above
    },

    /**This function renders a Gantt chart showing the schedule for a single day 
     * The Gantt chart shows the schedule for each employee, and allows users to hover over 
     * a cell to see the labor supply and demand metrics for that hour.
     * @param {Array<Object>} data - The data to display, which is an array of employee objects
     * @param {number} dayIdx - The day index to display (0-6), where 0 is Sunday.
     * @param {number} minH - The hour of the first hour in the day to display (0-23).
     * @param {number} maxH - The hour of the last hour in the day to display (0-23).
     * @param {d3.ScaleOrdinal} colorScale - The color scale to use for the cells.
     */
    renderGantt(data, dayIdx, minH, maxH, colorScale) {
        // Standardize setup while allowing the utility to clear the container.
        const chart = window.initChart('rosterGanttContainer', { left: 80, bottom: 10 }, false);
        if (!chart) return;

        const { svg, width } = chart;
        const hoursCount = (maxH - minH) + 1;
        const xScale = d3.scaleLinear().domain([0, hoursCount]).range([0, width]);
        const cellHeight = 22;
        const height = data.length * cellHeight;

        // Update SVG height to accommodate the full roster
        d3.select('#rosterGanttContainer svg').attr("height", height + 50);

        data.forEach((emp, eIdx) => {
            const y = eIdx * cellHeight;
            svg.append("text").attr("x", -10).attr("y", y + 25).attr("text-anchor", "end").style("font-size", "11px").text(emp.id);

            for (let h = 0; h < hoursCount; h++) {
                const role = emp.schedule[dayIdx * 24 + minH + h];
                if (role) {
                    const currentHour = minH + h;

                    // Lookup Demand and Supply metrics
                    const demandData = window.schedState.demands.find(d => d.day === dayIdx && d.hour === currentHour);
                    const demandVal = demandData ? (demandData[role] || 0) : 0;
                    const supplyVal = window.schedState.employees.filter(e =>
                        e.skills.includes(role) && e.availability[dayIdx].includes(currentHour)
                    ).length;

                    svg.append("rect")
                        .attr("x", xScale(h) - 5).attr("y", y + 12)
                        .attr("width", Math.max(0, (width / hoursCount) - 0.5)) // Robust width calculation
                        .attr("height", cellHeight - 4).attr("fill", colorScale(role)).attr("rx", 2)
                        .on("mouseover", (e) => {
                            const tooltipHtml = `
                                <div class="tooltip-header"><strong>Employee: ${emp.id}</strong></div>
                                <div class="tooltip-row"><span>Time:</span> <span>${currentHour}:00</span></div>
                                <div class="tooltip-row"><span>Skill:</span> <span>${role}</span></div>
                                <div class="tooltip-block">
                                    <div class="tooltip-row"><span>Labor Supply:</span> <span>${supplyVal}</span></div>
                                    <div class="tooltip-row"><span>Labor Demand:</span> <span>${demandVal}</span></div>
                                </div>`;
                            window.showTooltip(tooltipHtml, e);
                        })
                        .on("mouseout", () => window.hideTooltip());
                }
            }
        });

        // For each hour, add a label to the chart
        for (let h = 0; h <= hoursCount; h += 2) {
            // Add a label to the x-axis for every even hour
            svg.append("text").attr("x", xScale(h)).attr("y", 5).style("font-size", "9px").attr("fill", "#999").attr("text-anchor", "middle").text(`${minH + h}:00`);
        }
    },

    /**This function calculates the 7-day stats for supply and demand, and displays them on the UI.
     * It also generates a list of the top 10 training opportunities and displays them on the UI.
     */
    render7DayStats() {
        // Get the necessary global state variables
        const res = window.schedState.results, dems = window.schedState.demands, emps = window.schedState.employees;
        // Initialize variables arrays
        let dailyOverageHrs = Array(7).fill(0);
        let opportunities = [];

        // Loop through all hours in the week and calculate the supply and demand
        for (let t = 0; t < 168; t++) {
            const d = Math.floor(t / 24), h = t % 24; // Calculate the day and hour of the current time step
            const hourDem = dems.find(dem => dem.day === d && dem.hour === h); // Get the hour demand for the current time step
            const totalReq = this.skillNames.reduce((sum, s) => sum + (hourDem ? hourDem[s] : 0), 0); // Calculate the total requirements for the current time step
            const supplyAtT = res.roster.filter(emp => emp.schedule[t] !== null).length; // Calculate the supply at the current time step
            // If the supply is greater than the total requirements, add the overage to the dailyOverageHrs array
            if (supplyAtT > totalReq) dailyOverageHrs[d] += (supplyAtT - totalReq);

            // Loop through all skills and calculate the opportunities for the current time step
            this.skillNames.forEach(skill => {
                // Get the requirement for the current skill at the current time step
                const req = hourDem ? hourDem[skill] : 0;
                // If the requirement is 0, skip to the next skill
                if (req === 0) return;
                // Calculate the availability for the current skill at the current time step
                const qualAvailable = emps.filter(emp => emp.skills.includes(skill) && emp.availability[d].includes(h)).length;
                // Add the current opportunity to the opportunities array
                opportunities.push({ skill, day: d, hour: h, buffer: qualAvailable - req, req });
            });
        }

        // Calculate the average wage of all employees
        const avgWage = emps.length ? (emps.reduce((sum, e) => sum + (parseFloat(e.pay) || 0), 0) / emps.length).toFixed(2) : "0.00";
        // Display the 7-day stats on the UI
        document.getElementById('weeklySlackBreakdown').innerHTML = `<div class="stats-grid">` +
            dailyOverageHrs.map((hrs, i) => `
            <div class="stats-card">
                <span class="stats-label">${days[i]}</span>
                <div class="stats-value">${hrs} hrs over</div>
            </div>`).join('') +
            `<div class="kpi-split-row">
            <div class="kpi-split-item border-right">
                <span style="font-size:0.6rem; font-weight:bold; color:#e74c3c;">TOTAL OT</span>
                <div style="font-size:0.85rem; font-weight:bold; color:#e74c3c;">$${res.overTime.toLocaleString()}</div>
            </div>
            <div class="kpi-split-item" style="background:#ebf5fb;">
                <span style="font-size:0.6rem; font-weight:bold; color:#2980b9;">AVG WAGE</span>
                <div style="font-size:0.85rem; font-weight:bold; color:#2980b9;">$${avgWage}</div>
            </div>
        </div></div>`;

        // Sort the opportunities array by buffer (lowest to highest) and get the top 10
        const top10 = opportunities.sort((a, b) => a.buffer - b.buffer).slice(0, 10);
        // Display the top 10 training opportunities on the UI
        document.getElementById('trainingOpportunities').innerHTML = top10.map(op => {
            const isCrit = op.buffer <= 1;
            return `<div class="opportunity-card ${isCrit ? 'critical' : ''}">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <strong style="font-size:0.85rem;">${op.skill}</strong>
                    <span style="font-size:0.7rem; font-weight:bold; color:${isCrit ? '#e74c3c' : '#2980b9'};">${isCrit ? 'CRITICAL' : 'SCARCE'}</span>
                </div>
                <div style="font-size:0.75rem; color:#666; margin-top:4px;">${days[op.day]} at ${op.hour}:00 (Buffer: ${op.buffer})</div>
            </div>`;
        }).join('');
    },

    /**Draws the scheduling charts for the supply and demand data.
     * This function generates the data for the supply and demand charts, and
     * then renders those charts using the drawSchedulingLegend and
     * renderStackedChart functions.
     * The supply data is generated by iterating over each day and hour
     * of the week, and for each hour checking the availability of each
     * employee and counting the number of skills that are available for
     * that hour and day.
     */
    drawSchedulingCharts() {
        const supplyData = [];
        for (let d = 0; d < 7; d++) { // Loop over each day of the week
            for (let h = 0; h < 24; h++) { // Loop over each hour of the day
                // Create a new object to represent the supply at this day and hour
                const slot = { day: d, hour: h };
                this.skillNames.forEach(s => slot[s] = 0); // For each skill, set the value to 0
                window.schedState.employees.forEach(emp => { // Check the availability of each employee for this day and hour
                    if (emp.availability[d].includes(h)) { // If the employee is available for this hour and day
                        // For each skill that the employee has, increment the count of that skill for this slot
                        emp.skills.forEach(s => {
                            if (this.skillNames.includes(s)) {
                                slot[s]++;
                            }
                        });
                    }
                });
                supplyData.push(slot); // Add the slot to the supply data array
            }
        }

        // Get the scheduling legend
        let legend = document.getElementById('sharedSchedulingLegend');
        if (!legend) {
            legend = document.createElement('div');
            legend.id = 'sharedSchedulingLegend';
            const supplyWrapper = document.getElementById('supplyChartContainer').parentElement;
            supplyWrapper.parentNode.insertBefore(legend, supplyWrapper);
        }

        // Draw the scheduling legend, passing the skill names as the keys
        this.drawSchedulingLegend(legend, this.skillNames);

        // Render the demand chart using the demand data and the name "Demand"
        this.renderStackedChart("#demandChartContainer", window.schedState.demands, "Demand");

        // Render the supply chart using the supply data and the name "Supply"
        this.renderStackedChart("#supplyChartContainer", supplyData, "Supply");
    },

    /**Render the scheduling legend.
     * This function is responsible for generating the visual representation of the legend,
     * which is implemented using a set of div elements, each containing a colored box and
     * a label showing the skill name. The legend is synchronized with the chart.
     * @param {HTMLElement | null} container - The HTMLElement that will contain the legend.
     * @param {string[]} keys - The list of skill names to include in the legend.
     * @return {void} This function does not return anything.
     */
    drawSchedulingLegend(container, keys) {
        container.innerHTML = '';
        // Clear and set the class of the container to 'legend-container'
        container.className = 'legend-container';
        // Create a color scale for the different skills, using the schemeCategory10 colormap
        const color = d3.scaleOrdinal().domain(keys).range(d3.schemeCategory10);
        keys.forEach(key => { // For each skill, add a legend item to the container
            const div = document.createElement('div'); // Create a new div of class 'legend-item' to hold the legend item
            // Set the HTML content of the div to a colored box and a label
            div.innerHTML = `<div class="legend-box" style="background:${color(key)};"></div><span class="legend-label">${key}</span>`;
            container.appendChild(div); // Add the div to the container
        });
    },

    /**Render a stacked bar chart using the global initChart utility.
     * This function is responsible for generating the visual representation of the given data,
     * which is implemented using a set of bar elements, each representing a skill and filled
     * with a color based on the skill name. The chart is synchronized with the legend.
     * @param {string} containerId - The id of the HTML element that will contain the chart.
     * @param {Array} data - The list of objects containing the skill values.
     * @param {string} type - The type of chart to render.
     * @return {void} This function does not return anything.
     */
    renderStackedChart(containerId, data, type) {
        // Use the utility to ensure consistency with other modules.
        const selector = containerId.startsWith('#') ? containerId.slice(1) : containerId;
        const chart = window.initChart(selector, { bottom: 40 });
        if (!chart) return;

        const { svg, width, height } = chart;

        // Create a color scale for the different skills
        const color = d3.scaleOrdinal().domain(this.skillNames).range(d3.schemeCategory10);
        // Calculate the weights of each skill
        const weights = data.map(d => this.skillNames.reduce((s, k) => s + (d[k] || 0), 0) > 0 ? 1.0 : 0.3), totalW = d3.sum(weights);
        // Calculate the X and BW (bar width) functions, where hours with Demand are scaled up in width
        const getX = (idx) => (d3.sum(weights.slice(0, idx)) / totalW) * width, getBW = (idx) => Math.max(0, (weights[idx] / totalW) * width);
        // Calculate the maximum value of the stacked series and create the y-axis
        const yMax = d3.max(data, d => this.skillNames.reduce((s, k) => s + (d[k] || 0), 0)) || 1, y = d3.scaleLinear().domain([0, yMax * 1.1]).range([height, 0]);

        // Add a horizontal line at the top of the chart
        svg.append("line").attr("x1", 0).attr("x2", width).attr("y1", height).attr("y2", height).attr("stroke", "#444");
        // Create a stacked series using the data and the skill names
        const stacked = d3.stack().keys(this.skillNames)(data);
        // Add the bars and set their color, height, and width
        svg.selectAll(".layer").data(stacked).enter().append("g").attr("fill", d => color(d.key)).selectAll("rect").data(d => d).enter().append("rect").attr("x", (d, i) => getX(i)).attr("y", d => y(d[1])).attr("height", d => Math.max(0, y(d[0]) - y(d[1]))).attr("width", (d, i) => Math.max(0, getBW(i) - 0.5));
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

        // Creating Tooltip which will show CLOSED if there is no Demand
        svg.selectAll(".overlay").data(data).enter().append("rect").attr("x", (d, i) => getX(i)).attr("y", 0).attr("width", (d, i) => getBW(i)).attr("height", height).attr("fill", "transparent")
            .on("mouseover", (event, d) => {
                const isClosed = this.skillNames.reduce((s, k) => s + (d[k] || 0), 0) === 0;
                let html = `<div class="tooltip-header">${dayNames[d.day]} - ${d.hour}:00</div>`;
                if (isClosed) html += `<div style="color:#e74c3c; font-weight:bold; text-align:center;">CLOSED</div>`;
                else { this.skillNames.forEach(k => { if (d[k] > 0) html += `<div class="tooltip-row"><span><i style="display:inline-block; width:8px; height:8px; background:${color(k)}; margin-right:5px; border-radius:1px;"></i>${k}:</span><b>${d[k]}</b></div>`; }); html += `<div class="tooltip-block"><span>Total: </span><span>${d3.sum(this.skillNames.map(k => d[k]))}</span></div>`; }
                window.showTooltip(html, event);
            }).on("mouseout", () => window.hideTooltip());

        // Add the X and Y axis
        const xAxis = svg.append("g").attr("transform", `translate(0,${height})`);
        dayNames.forEach((d, i) => xAxis.append("text").attr("x", getX(i * 24) + 5).attr("y", 20).attr("fill", "#666").style("font-size", "11px").text(d));
        svg.append("g").call(d3.axisLeft(y).ticks(5));
    }
};