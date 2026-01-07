/**
 * scripts/schedule.js
 * Scheduling Module - High-Fidelity Restoration of Sidebar, Profiles, and Charts.
 */

window.ScheduleModule = {
    skillNames: ["Cashiers", "Stocking", "Customer Service", "BackRoom", "Floor Associate"],

    init() {
        ['employeeCount', 'minRest', 'maxShift', 'hourlyRate'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => this.requestSolve());
        });
        window.selectEmployee = (id) => this.selectEmployee(id);
    },

    drawCharts() {
        const activeSubTab = document.querySelector('#schedTabs .tab-btn.active')?.dataset.tab;
        const listContainer = document.getElementById('employee-list-container');

        // Sidebar logic: Must show on 'employees' tab and populate the list
        if (listContainer) {
            if (activeSubTab === 'employees') {
                listContainer.style.display = 'block';
                this.renderEmployeeList();
            } else {
                listContainer.style.display = 'none';
            }
        }

        if (activeSubTab === 'scheduling') {
            this.drawRosterChart();
        } else if (activeSubTab === 'employees') {
            if (!window.schedState.selectedEmpId && window.schedState.employees.length > 0) {
                window.schedState.selectedEmpId = window.schedState.employees[0].id;
            }
            if (window.schedState.selectedEmpId) {
                this.selectEmployee(window.schedState.selectedEmpId);
            }
        } else if (activeSubTab === 'demands') {
            this.drawSchedulingCharts();
        }
    },

    /**
     * Triggers the solver worker and initializes the Solver Dashboard with a countdown.
     */
    requestSolve() {
        if (!window.schedState.employees.length) return;
        if (window.resetGlobalKPI) window.resetGlobalKPI();

        // 1. Initialize persistent time (300 seconds)
        window.schedState.solverTimeLeft = 300;

        // 2. Start the Global Ticker (runs in background)
        this.startGlobalTicker();

        // 3. Render the dashboard (which now just looks at the state)
        this.renderSolverDashboard();

        const params = {
            employees: JSON.parse(JSON.stringify(window.schedState.employees)),
            demands: JSON.parse(JSON.stringify(window.schedState.demands)),
            preferedEmployees: document.getElementById('employee-count')?.value || 10
        };

        if (window.currentWorker) window.currentWorker.terminate();
        window.currentWorker = new Worker('scripts/scheduleWorker.js');

        window.currentWorker.onmessage = (e) => {
            // Stop the countdown timer when result returns
            window.schedState.solverTimeLeft = 0;
            clearInterval(this.tickerInterval);

            const { type, status, result } = e.data;
            if (type === 'result' && status === 'Optimal') {
                window.schedState.results = result;
                if (window.updateResultsUI) window.updateResultsUI();
                updateStatus("Optimal Roster Found", "optimal");
            } else {
                updateStatus("Infeasible", "error");
                document.getElementById('scheduling-panel-sub').innerHTML =
                    `<div class="error-state">Optimization failed: ${status}</div>`;
            }
        };
        window.currentWorker.postMessage({ type: 'solve', data: params });
    },

    startGlobalTicker() {
        if (this.tickerInterval) clearInterval(this.tickerInterval);

        this.tickerInterval = setInterval(() => {
            if (window.schedState.solverTimeLeft > 0) {
                window.schedState.solverTimeLeft--;

                // Attempt to update the UI if the element exists in the current DOM
                const display = document.getElementById('solverCountdown');
                if (display) {
                    const mins = Math.floor(window.schedState.solverTimeLeft / 60);
                    const secs = window.schedState.solverTimeLeft % 60;
                    display.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                }
            } else {
                clearInterval(this.tickerInterval);
            }
        }, 1000);
    },

    /**
     * Renders the detailed model breakdown and countdown timer.
     */
    renderSolverDashboard() {
        const container = document.getElementById('scheduling-panel-sub');
        if (!container) return;

        const E = window.schedState.employees.length;
        const S = 5; // Skill categories
        const T = 168; // Total hours in a week
        const D = 7; // Days

        // --- MILP MODEL METRIC CALCULATIONS ---
        // Parameter Calculation
        const demandParams = T * S;
        const availabilityParams = E * T;
        const temporalParams = E * (D * 2);
        const profileParams = E * 4;
        const solverConstants = 10;
        const totalParameters = demandParams + availabilityParams + temporalParams + profileParams + solverConstants;

        // Binaries: y(Ex168) + da(Ex7) + uEmp(E)
        const binaryVars = (E * T) + (E * D) + E;
        // Continuous: start(Ex7) + end(Ex7) + reg(E) + ot(E) + s_min(E) + w(Ex168x5) + slack_dem(168x5)
        const continuousVars = (E * 7 * S) + (E * 3) + (E * T * 2) + (T * S);

        // Interaction Constraints (Matrix Rows)
        const demandCons = (T * S);
        const skillCons = (E * T) + (E * T * S); // Link + Bounds
        const spanCons = (E * D * 4) + (E * T * 2); // Start/End Logic
        const weeklyCons = (E * 4) + 1;
        const nonNegativity = continuousVars; // Implicit constraints
        const totalConstraints = demandCons + skillCons + spanCons + weeklyCons + nonNegativity;

        // Initial formatted time
        const mins = Math.floor(window.schedState.solverTimeLeft / 60);
        const secs = window.schedState.solverTimeLeft % 60;
        const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

        container.innerHTML = `
            <div class="solver-dashboard">
                <div class="timer-section">
                    <h3>Scheduling Optimizer Solver Active</h3>
                    <div id="solverCountdown" class="countdown-clock">${timeStr}</div>
                    <p>Currently Performing Deep Solve</p>
                </div>
                <hr>
                <div class="metrics-grid">
                    <h4>Model Complexity</h4>
                    <table class="metrics-table">
                        <tr><td>Global Parameters:</td><td>${totalParameters.toLocaleString()}</td></tr>
                        <tr><td>Binary Decision Variables:</td><td>${binaryVars.toLocaleString()}</td></tr>
                        <tr><td>Continuous Decision Variables:</td><td>${continuousVars.toLocaleString()}</td></tr>
                        <tr><td>Constraints:</td><td>${totalConstraints.toLocaleString()}</td></tr>
                    </table>
                </div>
            </div>
        `;
    },

    processWorkbook(workbook) {
        try {
            const empSheet = workbook.Sheets["Employees Requests"];
            if (!empSheet) throw new Error("Sheet 'Employees Requests' not found");
            const rows = XLSX.utils.sheet_to_json(empSheet, { header: 1 });

            // Sort Lexicographically
            const empIds = rows[0].slice(1).filter(id => id !== undefined && id !== "").sort();

            window.schedState.employees = empIds.map((id) => {
                const col = rows[0].indexOf(id);
                return {
                    id: String(id),
                    pay: rows[1][col] || 20,
                    minHrs: rows[2][col] || 0,
                    maxHrs: rows[3][col] || 40,
                    skills: this.skillNames.filter((_, i) => rows[4 + i] && Number(rows[4 + i][col]) === 1),
                    availability: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }
                };
            });

            // Parse Availability
            for (let r = 10; r < rows.length; r++) {
                const row = rows[r];
                if (!row || !row[0]) continue;
                const parts = String(row[0]).split(',');
                if (parts.length < 2) continue;
                const d = parseInt(parts[0]), h = parseInt(parts[1]);
                window.schedState.employees.forEach(emp => {
                    const col = rows[0].indexOf(emp.id);
                    if (Number(row[col]) === 1 && emp.availability[d]) emp.availability[d].push(h);
                });
            }

            // Parse Demand
            const demandSheet = workbook.Sheets["Company Demands"] || workbook.Sheets["Demands"];
            if (demandSheet) {
                const raw = XLSX.utils.sheet_to_json(demandSheet);
                const demandMap = {};
                raw.forEach(row => demandMap[row["Required Employees"]] = row);
                const normalized = [];
                for (let d = 0; d < 7; d++) {
                    for (let h = 0; h < 24; h++) {
                        const lookup = `${d},${h}`;
                        const existing = demandMap[lookup] || {};
                        const slot = { day: d, hour: h };
                        this.skillNames.forEach(s => slot[s] = parseFloat(existing[s]) || 0);
                        normalized.push(slot);
                    }
                }
                window.schedState.demands = normalized;
            }

            this.drawCharts();
            this.requestSolve();
        } catch (err) { updateStatus("Import Error", "error"); }
    },

    /**
     * Updated Export logic to include granular audit rows.
     */
    exportResults() {
        if (!window.schedState.results) {
            alert("No optimized results found to export.");
            return;
        }

        const wb = XLSX.utils.book_new();
        const roster = window.schedState.results.roster;
        const demands = window.schedState.demands;
        const employees = window.schedState.employees;

        // --- TAB 1: SCHEDULE BY DAY (Chronological) ---
        const dayHeader = ["Day", "Hour", ...roster.map(e => e.id)];
        const dayRows = [];
        for (let t = 0; t < 168; t++) {
            const d = Math.floor(t / 24), h = t % 24;
            const hourDem = demands.find(dem => dem.day === d && dem.hour === h);
            const hasActivity = (this.skillNames.some(s => hourDem && hourDem[s] > 0) || roster.some(e => e.schedule[t] !== null));

            if (hasActivity) {
                dayRows.push([days[d], `${h}:00`, ...roster.map(emp => emp.schedule[t] || "-")]);
            }
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([dayHeader, ...dayRows]), "Schedule by Day");

        // --- TAB 2: SCHEDULE BY EMPLOYEE (Personnel) ---
        const empHeader = ["Employee ID", ...Array.from({ length: 168 }, (_, i) => `${days[Math.floor(i / 24)]} ${i % 24}:00`)];
        const empRows = roster.map(emp => [emp.id, ...emp.schedule.map(r => r || "-")]);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([empHeader, ...empRows]), "Schedule by Employee");

        // --- TAB 3: IMPROVEMENT AUDIT (Overages & Scarcity) ---
        const auditHeader = ["Category", "Reference", "Hour", "Metric", "Value", "Criticality"];
        const auditRows = [];
        let dailyOverageHrs = Array(7).fill(0);
        let allOpportunities = [];

        for (let t = 0; t < 168; t++) {
            const d = Math.floor(t / 24), h = t % 24, hourDem = demands.find(dem => dem.day === d && dem.hour === h);
            const reqTotal = this.skillNames.reduce((s, k) => s + (hourDem ? hourDem[k] : 0), 0);
            const supplyAtT = roster.filter(e => e.schedule[t] !== null).length;

            if (supplyAtT > reqTotal) dailyOverageHrs[d] += (supplyAtT - reqTotal);

            this.skillNames.forEach(skill => {
                const r = hourDem ? hourDem[skill] : 0;
                if (r > 0) {
                    const qa = employees.filter(e => e.skills.includes(skill) && e.availability[d].includes(h)).length;
                    allOpportunities.push({ skill, day: days[d], hour: h, buffer: qa - r });
                }
            });
        }

        dailyOverageHrs.forEach((hrs, i) => {
            auditRows.push(["OVERAGE", days[i], "-", "Excess Man-Hours", hrs, hrs > 5 ? "HIGH" : "NORMAL"]);
        });

        const top10Audit = allOpportunities.sort((a, b) => a.buffer - b.buffer).slice(0, 10);
        top10Audit.forEach(op => {
            auditRows.push(["OPPORTUNITY", op.skill, `${op.day} ${op.hour}:00`, "Supply Scarcity", op.buffer, op.buffer <= 1 ? "CRITICAL" : "SCARCE"]);
        });

        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([auditHeader, ...auditRows]), "Improvement Audit");

        // --- SAVE FILE ---
        const dateTag = new Date().toISOString().slice(0, 10);
        XLSX.writeFile(wb, `Personnel_Optimization_Report_${dateTag}.xlsx`);
    },

    renderEmployeeList() {
        const list = document.getElementById('employeeList');
        if (!list) return;
        list.innerHTML = '';
        window.schedState.employees.forEach(emp => {
            const item = document.createElement('div');
            item.className = 'emp-item' + (window.schedState.selectedEmpId === emp.id ? ' active' : '');
            item.textContent = emp.id;
            item.onclick = () => window.selectEmployee(emp.id);
            list.appendChild(item);
        });
    },

    selectEmployee(id) {
        window.schedState.selectedEmpId = String(id);
        const emp = window.schedState.employees.find(e => e.id === String(id));
        if (!emp) return;

        document.querySelectorAll('.emp-item').forEach(el => {
            el.classList.toggle('active', el.textContent === String(id));
        });

        // 1. Employee Profile Header + ID
        const profileCard = document.querySelector('#employees-panel .detail-card:first-child');
        if (profileCard) {
            profileCard.querySelector('h3').innerHTML = `Employee Profile <span style="float:right; color:#2980b9; font-weight:400;"># ${emp.id}</span>`;
            document.getElementById('employeeProfileContent').innerHTML = `
                <div class="profile-grid">
                    <div class="profile-stat"><strong>Hourly Pay:</strong> $${parseFloat(emp.pay).toFixed(2)}/hr</div>
                    <div class="profile-stat"><strong>Min Hours:</strong> ${emp.minHrs}</div>
                    <div class="profile-stat"><strong>Skills:</strong> ${emp.skills.join(', ') || 'None'}</div>
                    <div class="profile-stat"><strong>Max Hours:</strong> ${emp.maxHrs}</div>
                </div>`;
        }

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

        this.renderIndividualGantt(emp);
    },

    renderIndividualGantt(emp) {
        const container = document.getElementById('individualGantt');
        const header = document.querySelector('#individualScheduleContainer h3');
        if (!container || !header) return;
        container.innerHTML = '';

        // --- DYNAMIC LEGEND GENERATION ---
        const color = d3.scaleOrdinal().domain(this.skillNames).range(d3.schemeCategory10);
        let legendHtml = `<div style="display:inline-flex; gap:12px; margin-left:20px; font-size:0.75rem; font-weight:400; vertical-align:middle;">`;
        this.skillNames.forEach(skill => {
            legendHtml += `<div style="display:flex; align-items:center;"><div style="width:10px; height:10px; background:${color(skill)}; margin-right:4px; border-radius:2px;"></div>${skill}</div>`;
        });
        legendHtml += `</div>`;
        header.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center; width:100%;"><span>Weekly Schedule</span> ${legendHtml}</div>`;

        const rect = container.getBoundingClientRect();
        const margin = { top: 20, right: 30, bottom: 30, left: 60 };
        const width = Math.max(0, rect.width - margin.left - margin.right);
        const height = 7 * 40;
        if (width <= 0) return;

        const svg = d3.select(container).append("svg")
            .attr("width", rect.width).attr("height", height + margin.top + margin.bottom)
            .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

        const x = d3.scaleLinear().domain([0, 24]).range([0, width]);
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

        dayNames.forEach((day, dIdx) => {
            const y = dIdx * 40;
            svg.append("text").attr("x", -10).attr("y", y + 20).attr("text-anchor", "end").style("font-size", "12px").text(day);
            svg.append("rect").attr("x", 0).attr("y", y).attr("width", width).attr("height", 30).attr("fill", "#f8f9fa").attr("stroke", "#eee").attr("rx", 4);

            if (emp.availability[dIdx]) {
                emp.availability[dIdx].forEach(h => {
                    svg.append("rect").attr("x", x(h)).attr("y", y).attr("width", x(1) - x(0))
                        .attr("height", 30).attr("fill", "#c3e6cb").attr("opacity", 0.6);
                });
            }

            if (window.schedState.results?.roster) {
                const rosterEntry = window.schedState.results.roster.find(r => r.id === emp.id);
                if (rosterEntry) {
                    for (let h = 0; h < 24; h++) {
                        const role = rosterEntry.schedule[dIdx * 24 + h];
                        if (role) {
                            svg.append("rect").attr("x", x(h)).attr("y", y + 4).attr("width", x(1) - x(0) - 1).attr("height", 22)
                                .attr("fill", color(role)).attr("rx", 2)
                                .on("mouseover", (e) => {
                                    // TOOLTIP INCLUDES DAY AND HOUR
                                    const timeStr = `${h}:00 - ${h + 1}:00`;
                                    window.showTooltip(`<strong>${day} ${timeStr}</strong><br>Role: ${role}`, e);
                                })
                                .on("mouseout", () => window.hideTooltip());
                        }
                    }
                }
            }
        });
        svg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x).ticks(12).tickFormat(d => d + ":00"));
    },

    /**
 * Renders the compressed Gantt and the 7-Day Intelligence Dashboard.
 */
    drawRosterChart() {
        const container = document.getElementById('scheduling-panel-sub');
        if (!container || !window.schedState.results) return;

        const rosterSelect = document.getElementById('rosterDaySelect');
        const selectedDay = rosterSelect ? parseInt(rosterSelect.value) : 0;
        const roster = window.schedState.results.roster;
        const demands = window.schedState.demands;
        const color = d3.scaleOrdinal().domain(this.skillNames).range(d3.schemeCategory10);

        const dailyDemands = demands.filter(d => d.day === selectedDay);
        const activeHours = dailyDemands.filter(d => this.skillNames.some(s => d[s] > 0)).map(d => d.hour);

        const minH = activeHours.length > 0 ? Math.min(...activeHours) : 0;
        const maxH = activeHours.length > 0 ? Math.max(...activeHours) : 23;

        const filteredData = roster.filter(emp => {
            const daySlice = emp.schedule.slice(selectedDay * 24 + minH, selectedDay * 24 + maxH + 1);
            return daySlice.some(role => role !== null);
        });

        container.innerHTML = `
        <div class="roster-split-view" style="display: flex; gap: 20px; align-items: flex-start;">
            <div class="roster-visual-column" style="flex: 1.4; min-width: 0;">
                <div class="roster-header" style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                    <h3>Roster: ${days[selectedDay]} (${minH}:00 - ${maxH + 1}:00)</h3>
                    <select id="rosterDaySelect" onchange="window.ScheduleModule.drawCharts()" style="padding:5px; border-radius:4px;">
                        ${[0, 1, 2, 3, 4, 5, 6].map(i => `<option value="${i}" ${selectedDay === i ? 'selected' : ''}>${days[i]}</option>`).join('')}
                    </select>
                </div>
                <div id="rosterGanttContainer" style="background:#fff; border:1px solid #eee; border-radius:8px; padding:15px;"></div>
            </div>

            <div class="roster-stats-column" style="flex: 1; background: #f8f9fa; padding: 20px; border-radius: 8px; border: 1px solid #ddd; max-height: 85vh; overflow-y: auto;">
                <h3 style="margin-top:0;">Daily Labor Overages</h3>
                <div id="weeklySlackBreakdown"></div>
                <hr style="margin: 15px 0; border: 0; border-top: 1px solid #ccc;">
                <h4 style="margin-bottom:10px; color: #2980b9;">Top 10 Training Opportunities</h4>
                <p style="font-size: 0.75rem; color: #666; margin-bottom: 12px;">Ranked by coverage gaps due to limited training or restricted availability.</p>
                <div id="trainingOpportunities"></div>
            </div>
        </div>`;

        this.renderGantt(filteredData, selectedDay, minH, maxH, color);
        this.render7DayStats();
    },

    /**
     * Supporting function to render the actual D3 SVG Gantt.
     * Updated to scale horizontally to container width.
     */
    renderGantt(data, dayIdx, minH, maxH, colorScale) {
        const container = document.getElementById('rosterGanttContainer');
        if (!container) return;

        const rect = container.getBoundingClientRect();
        const margin = { top: 20, right: 20, bottom: 20, left: 80 };
        const width = rect.width - margin.left - margin.right;

        // Scale logic to prevent horizontal scrolling
        const hoursCount = (maxH - minH) + 1;
        const xScale = d3.scaleLinear().domain([0, hoursCount]).range([0, width]);
        const cellHeight = 22;
        const height = data.length * cellHeight;

        const svg = d3.select(container).append("svg")
            .attr("width", rect.width)
            .attr("height", height + margin.top + margin.bottom)
            .append("g")
            .attr("transform", `translate(${margin.left},${margin.top})`);

        data.forEach((emp, eIdx) => {
            const y = eIdx * cellHeight;

            // Label
            svg.append("text").attr("x", -10).attr("y", y + 15)
                .attr("text-anchor", "end").style("font-size", "11px").text(emp.id);

            // Rects
            for (let h = 0; h < hoursCount; h++) {
                const role = emp.schedule[dayIdx * 24 + minH + h];
                if (role) {
                    svg.append("rect")
                        .attr("x", xScale(h))
                        .attr("y", y + 2)
                        .attr("width", xScale(1) - xScale(0) - 0.5)
                        .attr("height", cellHeight - 4)
                        .attr("fill", colorScale(role))
                        .attr("rx", 2);
                }
            }
        });

        // Time Axis labels
        for (let h = 0; h <= hoursCount; h += 2) {
            svg.append("text")
                .attr("x", xScale(h))
                .attr("y", -5)
                .style("font-size", "9px")
                .attr("fill", "#999")
                .attr("text-anchor", "middle")
                .text(`${minH + h}:00`);
        }
    },

    /**
     * Renders the 24-hour Gantt limited to the selected day.
     */
    renderGantt(data, dayIdx, minH, maxH, colorScale) {
        const container = document.getElementById('rosterGanttContainer');
        const rect = container.getBoundingClientRect();
        const hourCount = (maxH - minH) + 1;
        const cellWidth = Math.max(35, (rect.width - 100) / hourCount);
        const cellHeight = 28;
        const height = Math.max(300, data.length * cellHeight);

        const svg = d3.select(container).append("svg")
            .attr("width", (hourCount * cellWidth) + 100).attr("height", height + 40)
            .append("g").attr("transform", "translate(80,20)");

        data.forEach((emp, eIdx) => {
            const y = eIdx * cellHeight;
            svg.append("text").attr("x", -10).attr("y", y + 18).attr("text-anchor", "end")
                .style("font-size", "11px").style("font-weight", "600").text(emp.id);

            for (let t = minH; t <= maxH; t++) {
                const role = emp.schedule[dayIdx * 24 + t];
                if (role) {
                    svg.append("rect")
                        .attr("x", (t - minH) * cellWidth).attr("y", y + 2)
                        .attr("width", cellWidth - 2).attr("height", cellHeight - 4)
                        .attr("fill", colorScale(role)).attr("rx", 3)
                        .on("mouseover", (e) => window.showTooltip(`<strong>${emp.id}</strong><br>${t}:00<br>Role: ${role}`, e))
                        .on("mouseout", () => window.hideTooltip());
                }
            }
        });

        // X-Axis Labels
        for (let t = minH; t <= maxH; t++) {
            svg.append("text").attr("x", (t - minH) * cellWidth).attr("y", -5)
                .style("font-size", "10px").attr("fill", "#999").text(t + ":00");
        }
    },

    /**
     * Renders the 7-day Intelligence Dashboard with Day-by-Day Overages 
     * and Risk-Based Training Opportunities.
     */
    render7DayStats() {
        const results = window.schedState.results,
            demands = window.schedState.demands,
            employees = window.schedState.employees;

        let dailyOverageHrs = Array(7).fill(0);
        let totalOTCost = results.overTime;
        let opportunities = [];

        // 1. CALCULATE GLOBAL OVERTIME & DAILY OVERAGES
        results.roster.forEach(resEmp => {
            const empData = employees.find(e => e.id === resEmp.id);
            if (!empData) return;

            let hoursCount = 0;

            resEmp.schedule.forEach((role, t) => {
                if (role) {
                    hoursCount++;
                }
            });
        });

        for (let t = 0; t < 168; t++) {
            const d = Math.floor(t / 24), h = t % 24;
            const hourDem = demands.find(dem => dem.day === d && dem.hour === h);
            const totalReq = this.skillNames.reduce((sum, s) => sum + (hourDem ? hourDem[s] : 0), 0);
            const supplyAtT = results.roster.filter(emp => emp.schedule[t] !== null).length;

            if (supplyAtT > totalReq) {
                dailyOverageHrs[d] += (supplyAtT - totalReq);
            }

            // SCARCITY AUDIT
            this.skillNames.forEach(skill => {
                const req = hourDem ? hourDem[skill] : 0;
                if (req === 0) return;
                const qualAvailable = employees.filter(emp => emp.skills.includes(skill) && emp.availability[d].includes(h)).length;
                opportunities.push({ skill, day: d, hour: h, buffer: qualAvailable - req, req: req });
            });
        }

        const totalPay = employees.reduce((sum, e) => sum + (parseFloat(e.pay) || 0), 0);
        const avgWage = employees.length ? (totalPay / employees.length).toFixed(2) : "0.00";

        // 2. RENDER GRID (7 DAYS + 1 SPLIT KPI BOX)
        document.getElementById('weeklySlackBreakdown').innerHTML = `<div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px;">` +
            dailyOverageHrs.map((hrs, i) => `
            <div style="background:#fff; padding:8px; border-radius:4px; border:1px solid #eee;">
                <span style="font-size:0.7rem; font-weight:bold; color:#888;">${days[i]}</span>
                <div style="font-size:0.9rem; font-weight:bold; color:#2c3e50;">${hrs} hrs over</div>
            </div>`).join('') +
            `<div style="grid-column: span 1; background:#f8f9fa; border:1px solid #ddd; border-radius:4px; display:flex; overflow:hidden;">
            <div style="flex:1; padding:8px; border-right:1px solid #ddd; text-align:center;">
                <span style="font-size:0.6rem; font-weight:bold; color:#e74c3c;">TOTAL OT</span>
                <div style="font-size:0.85rem; font-weight:bold; color:#e74c3c;">$${totalOTCost.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
            </div>
            <div style="flex:1; padding:8px; text-align:center; background:#ebf5fb;">
                <span style="font-size:0.6rem; font-weight:bold; color:#2980b9;">AVG WAGE</span>
                <div style="font-size:0.85rem; font-weight:bold; color:#2980b9;">$${avgWage}</div>
            </div>
        </div></div>`;

        // 3. RENDER TOP 10 OPPORTUNITIES (RELATIVE SCARCITY)
        const top10 = opportunities.sort((a, b) => a.buffer - b.buffer).slice(0, 10);
        document.getElementById('trainingOpportunities').innerHTML = top10.map(op => {
            const isCrit = op.buffer <= 1;
            return `<div style="margin-bottom:10px; padding:10px; background:${isCrit ? '#fdedec' : '#fff'}; border:1px solid #ddd; border-left:6px solid ${isCrit ? '#e74c3c' : '#2980b9'}; border-radius:4px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <strong style="font-size:0.85rem;">${op.skill}</strong>
                <span style="font-size:0.7rem; font-weight:bold; color:${isCrit ? '#e74c3c' : '#2980b9'};">${isCrit ? 'CRITICAL / FRAGILE' : 'SCARCE'} (Buffer: ${op.buffer})</span>
            </div>
            <div style="font-size:0.75rem; color:#666; margin-top:4px;">${days[op.day]} at ${op.hour}:00 (Demand: ${op.req})</div>
        </div>`;
        }).join('');
    },

    drawSchedulingCharts() {
        const supplyData = [];
        for (let d = 0; d < 7; d++) {
            for (let h = 0; h < 24; h++) {
                const slot = { day: d, hour: h };
                this.skillNames.forEach(s => slot[s] = 0);
                window.schedState.employees.forEach(emp => { if (emp.availability[d].includes(h)) emp.skills.forEach(s => { if (this.skillNames.includes(s)) slot[s]++; }); });
                supplyData.push(slot);
            }
        }
        let legend = document.getElementById('sharedSchedulingLegend');
        if (!legend) {
            legend = document.createElement('div'); legend.id = 'sharedSchedulingLegend';
            const supplyWrapper = document.getElementById('supplyChartContainer').parentElement;
            supplyWrapper.parentNode.insertBefore(legend, supplyWrapper);
        }
        this.drawSchedulingLegend(legend, this.skillNames);
        this.renderStackedChart("#demandChartContainer", window.schedState.demands, "Demand");
        this.renderStackedChart("#supplyChartContainer", supplyData, "Supply");
    },

    drawSchedulingLegend(container, keys) {
        container.innerHTML = '';
        Object.assign(container.style, { display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '1.2rem', padding: '10px' });
        const color = d3.scaleOrdinal().domain(keys).range(d3.schemeCategory10);
        keys.forEach(key => { container.innerHTML += `<div style="display:flex; align-items:center;"><div style="width:12px; height:12px; background:${color(key)}; margin-right:6px; border-radius:2px;"></div><span style="font-size:0.85rem; color:#333; font-weight:500;">${key}</span></div>`; });
    },

    renderStackedChart(containerId, data, type) {
        const container = d3.select(containerId); container.selectAll("*").remove();
        const rect = container.node().getBoundingClientRect();
        const margin = { top: 10, right: 30, bottom: 40, left: 50 }, width = Math.max(0, rect.width - margin.left - margin.right), height = Math.max(0, rect.height - margin.top - margin.bottom);
        if (width <= 0) return;
        const svg = container.append("svg").attr("width", rect.width).attr("height", rect.height).append("g").attr("transform", `translate(${margin.left},${margin.top})`);
        const color = d3.scaleOrdinal().domain(this.skillNames).range(d3.schemeCategory10);
        const weights = data.map(d => this.skillNames.reduce((s, k) => s + (d[k] || 0), 0) > 0 ? 1.0 : 0.3), totalW = d3.sum(weights);
        const getX = (idx) => (d3.sum(weights.slice(0, idx)) / totalW) * width, getBW = (idx) => Math.max(0, (weights[idx] / totalW) * width);
        const yMax = d3.max(data, d => this.skillNames.reduce((s, k) => s + (d[k] || 0), 0)) || 1, y = d3.scaleLinear().domain([0, yMax * 1.1]).range([height, 0]);
        svg.append("line").attr("x1", 0).attr("x2", width).attr("y1", height).attr("y2", height).attr("stroke", "#444");
        const stacked = d3.stack().keys(this.skillNames)(data);
        svg.selectAll(".layer").data(stacked).enter().append("g").attr("fill", d => color(d.key)).selectAll("rect").data(d => d).enter().append("rect").attr("x", (d, i) => getX(i)).attr("y", d => y(d[1])).attr("height", d => Math.max(0, y(d[0]) - y(d[1]))).attr("width", (d, i) => Math.max(0, getBW(i) - 0.5));
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        svg.selectAll(".overlay").data(data).enter().append("rect").attr("x", (d, i) => getX(i)).attr("y", 0).attr("width", (d, i) => getBW(i)).attr("height", height).attr("fill", "transparent")
            .on("mouseover", (event, d) => {
                const isClosed = this.skillNames.reduce((s, k) => s + (d[k] || 0), 0) === 0;
                let html = `<div style="font-weight:bold; border-bottom:1px solid #444; margin-bottom:5px;">${dayNames[d.day]} - ${d.hour}:00</div>`;
                if (isClosed) html += `<div style="color:#e74c3c; font-weight:bold; text-align:center;">CLOSED</div>`;
                else { this.skillNames.forEach(k => { if (d[k] > 0) html += `<div style="display:flex; justify-content:space-between; gap:20px; font-size:0.85rem;"><span><i style="display:inline-block; width:8px; height:8px; background:${color(k)}; margin-right:5px; border-radius:1px;"></i>${k}:</span><b>${d[k]}</b></div>`; }); html += `<div style="margin-top:5px; padding-top:5px; border-top:1px solid #444; font-weight:bold; display:flex; justify-content:space-between;"><span>Total:</span><span>${d3.sum(this.skillNames.map(k => d[k]))}</span></div>`; }
                window.showTooltip(html, event);
            }).on("mouseout", () => window.hideTooltip());
        const xAxis = svg.append("g").attr("transform", `translate(0,${height})`);
        dayNames.forEach((d, i) => xAxis.append("text").attr("x", getX(i * 24) + 5).attr("y", 20).attr("fill", "#666").style("font-size", "11px").text(d));
        svg.append("g").call(d3.axisLeft(y).ticks(5));
    }
};

window.ScheduleModule = window.ScheduleModule;