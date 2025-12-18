/**
 * ============================================================================
 * Production Scheduler - Main Controller
 * ============================================================================
 * Description:
 * This script handles the User Interface (UI), State Management, and Worker
 * Initialization for the Steel Production Optimization application.
 * @author Joel Wood
 */

// ============================================================================
// GLOBAL CONSTANTS & STATE MANAGEMENT
// ============================================================================

// Default product row if data/SampleData.xlsx fails to load
const DEFAULT_PRODUCTS = [
    { id: 0, name: " ", sell: 0, cost: 0, changeOverCost: 0, changeOverTime: 0, cycleTime: 0, demand: [0, 0, 0, 0, 0, 0, 0] }
];

/**
 * State Management Object - Used for Central Variable Control, to help ensure data consistency.
 * @property {Array<number>} operationalTime - Array representing available operational hours per day of the week
 * @property {Array<Object>} products - List of product objects with costs/demands, managed through JSON
 * @property {Object|null} results - Stores outputs from the MILP optimization engine (worker.js)
 */
let systemState = {
    operationalTime: [0, 0, 0, 0, 0, 0, 0],
    products: JSON.parse(JSON.stringify(DEFAULT_PRODUCTS)),
    results: null
};

/**
 * Live operational Parameters bound to UI inputs to the DOM.
 */
let liveState = {
    rawSteelCost: 2000,
    invCost: 20,
    maxCapacity: 500,
    backorderPenalty: 2
};

/**
 * Cached UI DOM elements
 */
const els = {
    rawSteelCost: document.getElementById('rawSteelCost'),
    invCost: document.getElementById('invCost'),
    maxCapacity: document.getElementById('maxCapacity'),
    backorderPenalty: document.getElementById('backorderPenalty'),
    tableBody: document.getElementById('tableBody'),
    statusIndicator: document.getElementById('statusIndicator'),
    objValueDisplay: document.getElementById('objValueDisplay'),
    excelInput: document.getElementById('excelInput'),
    tabs: document.getElementById('tabs'),
    panels: document.querySelectorAll('.vis-panel'),
    chartPanel: document.getElementById('charts-panel'),
    saveConfigBtn: document.getElementById('saveConfigBtn'),
    addProductBtn: document.getElementById('addProductBtn'),
    autoSaveStatus: document.getElementById('autoSaveStatus'),
    exportBtn: document.getElementById('exportBtn')
};

// ============================================================================
// WORKER MANAGEMENT & OPTIMIZATION LOGIC
// ============================================================================
let currentWorker = null; // The Active Web-Worker instance
let solveTimer = null; // Debounce Timer

const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Initialization of Application (fires when the DOM is fully loaded)
 */
document.addEventListener('DOMContentLoaded', main);

function main() {
    syncLiveStateToInputs();
    renderInputTable();
    setupEventListeners();
    setupResizeObserver();
    setupTooltip();
    loadSampleData();

    // Initialize the shared legend container (between inventory/production charts)
    if (!document.getElementById('sharedLegend')) {
        const legendDiv = document.createElement('div');
        legendDiv.id = 'sharedLegend';
        if (els.chartPanel && els.chartPanel.children.length >= 2) {
            els.chartPanel.insertBefore(legendDiv, els.chartPanel.children[1]);
        }
    }
}

/**
 * HEURISTIC MINIMUMS
 * Calculates the absolute floor for Capacity and Operational Time.
 * This is to prevent optimization of impossible scenarios.
 */
function calculateTheoreticalFloor(params) {
    // Initialize Operational Totals
    const days = 7;
    let totalDemand = 0;
    let totalProcTime = 0;

    params.products.forEach(p => {
        const d = p.demand.reduce((a, b) => a + (parseFloat(b) || 0), 0);
        totalDemand += d; // Find total weekly demand for each Product
        totalProcTime += d * (parseFloat(p.cycleTime) || 0); // total processing time
        if (d > 0) {
            // Calculate minimum theoretical setups as Ceiling (Total Demand % Daily Capacity)
            const minSetups = Math.max(1, Math.ceil(d / params.maxCapacity));
            // Calculate maximum available Production Time per Product
            totalProcTime += (minSetups * (parseFloat(p.changeOverTime) || 0) * 60);
        }
    });

    // Return absolute feasibility limits
    return {
        floorCap: totalDemand / days,
        floorTime: totalProcTime / (days * 3600) // Hours per day
    };
}

/**
 * Requests an optimization run Implementing a 100ms debounce after user input
 * before triggering the solver to prevent redundant calculations and race conditions.
 */
function requestSolve() {
    if (solveTimer) clearTimeout(solveTimer);
    updateStatus("Changes Pending...", "waiting");
    solveTimer = setTimeout(() => { executeSolve(); }, 100);
}

/**
 * Executes targetted heuristic guided MILP optimization.
 */
function executeSolve(attempt = 1, adjustedParams = null) {
    const currentParams = adjustedParams || {
        products: JSON.parse(JSON.stringify(systemState.products)),
        operationalTime: [...systemState.operationalTime],
        ...liveState
    };

    // 1. Run Heuristic Check for if the Inputs are individually possible
    const floors = calculateTheoreticalFloor(currentParams);
    const avgOpTime = currentParams.operationalTime.reduce((a, b) => a + (parseFloat(b) || 0), 0) / 7;
    // Check if the Max
    if (currentParams.maxCapacity < floors.floorCap || avgOpTime < floors.floorTime) {
        updateStatus("Impossible Logic", "error");
        if (els.autoSaveStatus) els.autoSaveStatus.textContent = "Inputs below theoretical minimums.";
        return;
    }

    // 2. Initialize Worker & Set Status
    if (currentWorker) { currentWorker.terminate(); currentWorker = null; }
    if (attempt === 1) updateStatus("Solving...", "solving");
    currentWorker = new Worker('worker.js');

    currentWorker.onmessage = function (e) {
        const { type, status, result, slackUsed } = e.data;
        // If the worker returns Optimal and didn't use Slack, return Optimal
        const isOptimal = (status === 'Optimal' && (!slackUsed || slackUsed < 0.01));

        // If Optimal, set UI elements to the results
        if (type === 'result' && isOptimal) {
            systemState.results = result;
            updateResultsUI();
            updateStatus("Optimal Solution", "optimal");
        }

        /**
        * If the first attempt fails, it may not actually be infeasible, but rather due to getting stuck
        * computationally in a loop.  To resolve this, we will do a second attempt using the midpoint of
        * the current capacity, and the theoretical minimal capacity.  This will be a more aggressive
        * constraint which may actually be more computationally stable, the optimal solution of a more
        * aggressive constraint will be a valid answer to a more lax constraint.
        */
        else if (attempt === 1) {
            console.warn("Attempt 1 Unstable. Retrying with Midpoint Capacity...");
            const tightenedParams = {
                ...currentParams,
                maxCapacity: (currentParams.maxCapacity + floors.floorCap) / 2
            };
            executeSolve(2, tightenedParams);
        }
        // If both fail, then the solver will find the scenario to be infeasible.
        // A feasible solution may exist, but is outside the computational ability of a web-browser.
        else {
            updateStatus("Infeasible", "error");
        }
    };

    currentWorker.onerror = () => { if (attempt === 1) executeSolve(2); else updateStatus("Crash", "error"); };
    currentWorker.postMessage({ type: 'solve', data: currentParams });
}

/**
 * Helper to update the visual status badge in Right Sidebar (Showing the Status of the Solver).
 * @param {string} text - Display text
 * @param {string} className - CSS class for color styling
 */
function updateStatus(text, className) {
    if (els.statusIndicator) {
        els.statusIndicator.textContent = text;
        els.statusIndicator.className = "status-badge " + className;
    }
}

// ============================================================================
// STATE MANAGEMENT & DATA BINDING
// ============================================================================

/**
 * Pushes JavaScript state values into HTML Input DOM elements.
 */
function syncLiveStateToInputs() {
    Object.keys(liveState).forEach(key => {
        if (els[key]) els[key].value = liveState[key];
    });
}

/**
 * Handler for Global Parameter inputs, parse value and initiate solver.
 * @param {string} key - The state key to update.
 * @param {string} value - The new value from the input.
 */
function handleInputChange(key, value) {
    liveState[key] = parseFloat(value) || 0;
    requestSolve();
}

/**
 * Updates a specific field for a specific product in Product Demands Table.
 */
function updateProductData(idx, field, val) {
    // If user changes cycle/changeover time, the bottleneck is 'time'
    if (field.toLowerCase().includes('time')) {
    }
    if (field === 'name') systemState.products[idx].name = val;
    else systemState.products[idx][field] = parseFloat(val) || 0;
    requestSolve();
}

/**
 * Updates the demand array for a specific product and day.
 */
function updateDemandData(pIdx, dIdx, val) {
    systemState.products[pIdx].demand[dIdx] = parseFloat(val) || 0;
    requestSolve();
}

/**
 * Updates the Global Operational Time array.
 */
function updateOperationalTime(dIdx, val) {
    systemState.operationalTime[dIdx] = parseFloat(val) || 0;
    requestSolve();
}

/**
 * Dynamically adds a new product row to the Product Demands Table and state.
 */
function addProductRow() {
    const newId = systemState.products.length;
    systemState.products.push({
        id: newId,
        name: `New Product ${newId + 1}`,
        sell: 0, cost: 0, changeOverCost: 0, changeOverTime: 0, cycleTime: 0,
        demand: [0, 0, 0, 0, 0, 0, 0]
    });
    renderInputTable();
    requestSolve();
}

// ============================================================================
// DATA LOADING & EXPORT (EXCEL AND TABLE HANDLING)
// ============================================================================

/**
 * Attempts to fetch 'data/SampleData.xlsx' on page load to populate the table.
 */
async function loadSampleData() {
    try {
        const response = await fetch('data/SampleData.xlsx');
        if (response.ok) {
            const data = await response.arrayBuffer();
            const workbook = XLSX.read(data);
            processWorkbook(workbook);
            console.log("Sample Data Loaded");
        }
    } catch (e) { console.warn("No SampleData.xlsx found in /data, using defaults."); }
}

/**
 * Handles user-uploaded Excel files.
 */
async function handleExcelUpload() {
    const file = els.excelInput.files[0];
    if (!file) return;
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data);
    processWorkbook(workbook);
}

/**
 * Parses the Excel workbook using a dynamic, keyword-based approach.
 * Allows for variable row locations and any number of products.
 * @param {Object} workbook - SheetJS Workbook Object
 */
function processWorkbook(workbook) {
    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    // Convert sheet to array of arrays (rows)
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    // Helper functions
    const cleanStr = (val) => String(val || "").trim();
    const cleanNum = (val) => parseFloat(val) || 0;

    // Locate Key Sections by matching first column
    let prodHeaderIdx = -1;
    let opHeaderIdx = -1;
    let demandHeaderIdx = -1;

    for (let i = 0; i < rows.length; i++) {
        const firstCell = cleanStr(rows[i][0]).toLowerCase();

        if (firstCell === "products") prodHeaderIdx = i;
        else if (firstCell === "operational hours") opHeaderIdx = i;
        else if (firstCell === "demand in days") demandHeaderIdx = i;
    }

    // Parse Products
    let newProducts = [];
    if (prodHeaderIdx !== -1) {
        // Start reading from the row immediately following the "Products" header
        for (let i = prodHeaderIdx + 1; i < rows.length; i++) {
            const row = rows[i];
            const name = cleanStr(row[0]);

            // Stop reading at empty row
            if (!name) break;

            newProducts.push({
                name: name,                         // Column A
                sell: cleanNum(row[1]),             // Column B
                cost: cleanNum(row[2]),             // Column C
                changeOverCost: cleanNum(row[3]),   // Column D
                changeOverTime: cleanNum(row[4]),   // Column E
                cycleTime: cleanNum(row[5]),        // Column F
                demand: [0, 0, 0, 0, 0, 0, 0]
            });
        }
    }

    // Parse Operational Hours
    let newOpTime = [0, 0, 0, 0, 0, 0, 0];
    if (opHeaderIdx !== -1) {
        const row = rows[opHeaderIdx];
        // Read columns B through H
        for (let j = 0; j < 7; j++) {
            newOpTime[j] = cleanNum(row[j + 1]);
        }
    }

    // Parse Demands
    if (demandHeaderIdx !== -1) {
        // Start reading from row after "Demand in days"
        for (let i = demandHeaderIdx + 1; i < rows.length; i++) {
            const row = rows[i];
            const name = cleanStr(row[0]);

            // Stop if at an empty row
            if (!name) break;

            // Find matching product by name
            const product = newProducts.find(p => p.name.toLowerCase() === name.toLowerCase());
            if (product) {
                for (let j = 0; j < 7; j++) {
                    product.demand[j] = cleanNum(row[j + 1]);
                }
            }
        }
    }

    // Update System State
    if (newProducts.length > 0) {
        // Assign new IDs based on array index
        newProducts.forEach((p, i) => p.id = i);
        systemState.products = newProducts;
        systemState.operationalTime = newOpTime;

        // Update Table and Run Optimization
        renderInputTable();
        requestSolve();
        console.log(`Imported ${newProducts.length} products from Excel.`);
    } else {
        console.warn("No 'Products' section found in Excel file.");
    }
}

/**
 * Re-renders the HTML Input Table based on current System State.
 */
function renderInputTable() {
    els.tableBody.innerHTML = '';
    // Render Operational Time Header Row
    let opRow = `<tr style="background-color: #f0f4f8; font-weight: bold;">
        <td colspan="6" style="text-align: right; padding-right: 15px;">Total Operational Time (Hours):</td>`;
    systemState.operationalTime.forEach((t, i) => {
        opRow += `<td><input type="number" style="width: 100%; font-weight: bold; color: #333;"
            value="${t}" onchange="updateOperationalTime(${i}, this.value)"></td>`;
    });
    opRow += `</tr>`;
    els.tableBody.innerHTML += opRow;

    // Render Product Rows
    systemState.products.forEach((p, idx) => {
        let row = `<tr>
            <td><input type="text" value="${p.name}" onchange="updateProductData(${idx}, 'name', this.value)"></td>
            <td><input type="number" value="${p.sell}" onchange="updateProductData(${idx}, 'sell', this.value)"></td>
            <td><input type="number" value="${p.cost}" onchange="updateProductData(${idx}, 'cost', this.value)"></td>
            <td><input type="number" value="${p.changeOverCost}" onchange="updateProductData(${idx}, 'changeOverCost', this.value)"></td>
            <td><input type="number" value="${p.changeOverTime}" onchange="updateProductData(${idx}, 'changeOverTime', this.value)"></td>
            <td><input type="number" value="${p.cycleTime}" onchange="updateProductData(${idx}, 'cycleTime', this.value)"></td>`;

        p.demand.forEach((d, dayIdx) => {
            row += `<td><input type="number" value="${d}" onchange="updateDemandData(${idx}, ${dayIdx}, this.value)"></td>`;
        });
        row += `</tr>`;
        els.tableBody.innerHTML += row;
    });
}

/**
 * Exports Optimized Results to an Excel Spreadsheet (.xlsx)
 */
function handleExport() {
    if (!systemState.results) return alert("No results.");
    const wb = XLSX.utils.book_new();
    const wsData = [["Optimized Schedule"], ["Profit", systemState.results.objectiveValue], []];
    systemState.results.details.forEach(p => {
        wsData.push([p.product]);
        wsData.push(["Metric", ...days]);
        wsData.push(["Produced", ...p.produced]);
        wsData.push(["Sold", ...p.sold]);
        wsData.push(["Ending Inv", ...p.inventory]);
        wsData.push(["Backorder", ...p.backorder]);
        wsData.push([]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(wsData), "Solution");
    XLSX.writeFile(wb, "Results.xlsx");
}

// ============================================================================
// D3 DATA VISUALIZATION
// ============================================================================

function drawCharts() {
    if (!systemState.results) return;
    drawSharedLegend();
    drawProductionChart();
    drawInventoryChart();
}

/**
 * Drawing Flexible Product Legend between the Charts
 */
function drawSharedLegend() {
    const container = document.getElementById('sharedLegend');
    if (!container) return;
    container.innerHTML = '';

    // Apply styles for dynamic wrapping
    Object.assign(container.style, {
        height: 'auto',
        minHeight: '2.5rem',
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        gap: '1.2rem',
        padding: '10px',
        marginBottom: '10px'
    });

    if (!systemState.results) return;

    // Generate Legend Items
    const products = systemState.results.details.map(d => d.product);
    const color = d3.scaleOrdinal().domain(products).range(d3.schemeCategory10);

    // Setting Styling for the Product Groups
    products.forEach(product => {
        const item = document.createElement('div');
        Object.assign(item.style, {
            display: 'flex',
            alignItems: 'center',
            whiteSpace: 'nowrap'
        });

        // Color Box
        const box = document.createElement('div');
        Object.assign(box.style, {
            width: '12px',
            height: '12px',
            backgroundColor: color(product),
            marginRight: '6px',
            borderRadius: '2px'
        });

        // Label
        const text = document.createElement('span');
        text.textContent = product;
        Object.assign(text.style, {
            fontSize: '0.85rem',
            color: '#333',
            fontWeight: '500'
        });

        // Unifying Boxes and Texts into Legend Items
        item.appendChild(box);
        item.appendChild(text);
        container.appendChild(item);
    });
}

/**
 * Draws the Stacked Bar Chart for Production vs Capacity.
 */
function drawProductionChart() {
    const container = document.getElementById('productionChartContainer');
    container.innerHTML = '';

    // Define Chart Spacing Bounds
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    const margin = { top: 10, right: 30, bottom: 30, left: 50 };
    const width = rect.width - margin.left - margin.right;
    const height = rect.height - margin.top - margin.bottom;
    const svg = d3.select(container).append("svg")
        .attr("width", "100%")
        .attr("height", "100%")
        .attr("viewBox", `0 0 ${rect.width} ${rect.height}`)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    // Build Stacked Data Groups by Day of Week
    const data = systemState.results;
    const stackData = days.map((day, i) => {
        const obj = { day: day };
        data.details.forEach(p => { obj[p.product] = p.produced[i]; });
        return obj;
    });
    const subgroups = data.details.map(d => d.product);

    // Define Bar, Axis, and Color Scales
    const x = d3.scaleBand().domain(days).range([0, width]).padding([0.2]);
    const y = d3.scaleLinear().domain([0, liveState.maxCapacity * 1.1]).range([height, 0]);
    const color = d3.scaleOrdinal().domain(subgroups).range(d3.schemeCategory10);

    // Draw Axis
    svg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x));
    svg.append("g").call(d3.axisLeft(y));

    // Draw Stacked Bar-Chart
    const stackedData = d3.stack().keys(subgroups)(stackData);
    svg.append("g").selectAll("g").data(stackedData).enter().append("g")
        .attr("fill", d => color(d.key))
        .selectAll("rect").data(d => d).enter().append("rect")
        .attr("x", d => x(d.data.day))
        .attr("y", d => y(d[1]))
        .attr("height", d => y(d[0]) - y(d[1]))
        .attr("width", x.bandwidth())

        // Define Tooltip Behaviors for Products
        .on("mouseover", function (event, d) {
            const product = d3.select(this.parentNode).datum().key;
            const amount = d[1] - d[0];
            showTooltip(`<strong class="tooltip-header">${product}</strong>Produced: ${amount} tons`, event);
            d3.select(this).style("opacity", 0.8);
        })
        .on("mousemove", (event) => showTooltip(document.getElementById('d3-tooltip').innerHTML, event))
        .on("mouseout", function () {
            hideTooltip();
            d3.select(this).style("opacity", 1);
        });

    // Draw Max-Capacity Line
    svg.append("line").attr("x1", 0).attr("x2", width)
        .attr("y1", y(liveState.maxCapacity)).attr("y2", y(liveState.maxCapacity))
        .attr("class", "capacity-line");
}

/**
 * Draws the Line Chart for Inventory/Backlog.
 */
function drawInventoryChart() {
    const container = document.getElementById('inventoryChartContainer');
    container.innerHTML = '';

    // Define Chart Spacing Bounds
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    const margin = { top: 10, right: 30, bottom: 30, left: 50 };
    const width = rect.width - margin.left - margin.right;
    const height = rect.height - margin.top - margin.bottom;
    const svg = d3.select(container).append("svg")
        .attr("width", "100%")
        .attr("height", "100%")
        .attr("viewBox", `0 0 ${rect.width} ${rect.height}`)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    // Define X-Axis Scale (Days of Week)
    const x = d3.scalePoint().domain(days).range([0, width]);
    let maxVal = 100, minVal = 0;

    // Map Data to Product Lines
    const netInventoryData = systemState.results.details.map(p => {
        return {
            product: p.product,
            values: p.inventory.map((inv, i) => {
                const back = p.backorder[i];
                const net = inv - back;
                maxVal = Math.max(maxVal, net);
                minVal = Math.min(minVal, net);
                return net;
            }),
            rawInv: p.inventory,
            rawBack: p.backorder
        };
    });

    // Define Y-Axis and Color Scales
    const y = d3.scaleLinear().domain([minVal * 1.1, maxVal * 1.1]).range([height, 0]).nice();
    const color = d3.scaleOrdinal().domain(systemState.results.details.map(d => d.product)).range(d3.schemeCategory10);

    // Draw Axes and the Zero Line
    svg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x));
    svg.append("g").call(d3.axisLeft(y));
    svg.append("line")
        .attr("x1", 0).attr("x2", width)
        .attr("y1", y(0)).attr("y2", y(0))
        .attr("stroke", "#666").style("opacity", 0.5);
    const line = d3.line().x((d, i) => x(days[i])).y(d => y(d));

    // Draw Lines and Dots for each Product
    netInventoryData.forEach(p => {
        svg.append("path").datum(p.values)
            .attr("class", "chart-line")
            .attr("stroke", color(p.product))
            .attr("d", line);
        svg.selectAll(`.dot-${p.product.replace(/\s/g, '')}`)
            .data(p.values).enter().append("circle")
            .attr("cx", (d, i) => x(days[i]))
            .attr("cy", d => y(d))
            .attr("r", 5)
            .attr("fill", color(p.product))
            .attr("stroke", "white")

            // Define Tooltip Behaviors for Products
            .on("mouseover", (event, d, i) => {
                // Find index via X coordinate mapping
                const dayIndex = days.findIndex((day, idx) => Math.abs(x(day) - parseFloat(d3.select(event.target).attr('cx'))) < 1);
                const backorder = p.rawBack[dayIndex];
                const inv = p.rawInv[dayIndex];

                // Draw Tooltip
                const tooltipHtml = `
                    <div style="text-align:left;">
                        <strong class="tooltip-header">${p.product} (${days[dayIndex]})</strong>
                        Inventory: ${inv}<br>
                        Backorder: <span class="${backorder > 0 ? 'tooltip-value-bad' : ''}">${backorder}</span><br>
                    </div>
                `;
                showTooltip(tooltipHtml, event);
                d3.select(event.target).attr("r", 8);
            })
            .on("mousemove", (event) => showTooltip(document.getElementById('d3-tooltip').innerHTML, event))
            .on("mouseout", (event) => {
                hideTooltip();
                d3.select(event.target).attr("r", 5);
            });
    });
}

// ============================================================================
// UI HELPER FUNCTIONS
// ============================================================================

/**
 * Attaches Event Listeners to UI elements (Tabs and Buttons)
 */
function setupEventListeners() {
    Object.keys(els).forEach(key => {
        if (!els[key]) return;
        if (key === 'excelInput') els[key].addEventListener('change', handleExcelUpload);
        else if (els[key].tagName === 'INPUT') els[key].addEventListener('change', (e) => handleInputChange(key, e.target.value));
    });
    if (els.exportBtn) els.exportBtn.addEventListener('click', handleExport);
    if (els.saveConfigBtn) els.saveConfigBtn.addEventListener('click', () => {
        if (els.autoSaveStatus) els.autoSaveStatus.textContent = "Saved";
        requestSolve();
    });
    if (els.addProductBtn) els.addProductBtn.addEventListener('click', addProductRow);

    if (els.tabs) {
        els.tabs.addEventListener('click', (e) => {
            if (e.target.classList.contains('tab-btn')) {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                const target = e.target.dataset.tab;
                els.panels.forEach(p => {
                    p.classList.remove('active');
                    if (p.id === `${target}-panel`) p.classList.add('active');
                });
                if (target === 'charts') drawCharts();
            }
        });
    }

    window.updateProductData = updateProductData;
    window.updateDemandData = updateDemandData;
    window.updateOperationalTime = updateOperationalTime;
}

/**
 * Redraws the Website Dynamically when Resolution Changes
 */
function setupResizeObserver() {
    new ResizeObserver(() => {
        if (systemState.results) requestAnimationFrame(drawCharts);
    }).observe(els.chartPanel);
}

/**
 * Creates and Appends Classes to Tooltips
 */
function setupTooltip() {
    if (document.getElementById('d3-tooltip')) return;
    const t = document.createElement('div');
    t.id = 'd3-tooltip';
    t.className = 'd3-tooltip';
    document.body.appendChild(t);
}

/**
 * Sets Tooltip Positioning and Styles
 */
function showTooltip(html, event) {
    const t = document.getElementById('d3-tooltip');
    t.innerHTML = html;
    t.style.opacity = 0.8;
    t.style.left = (event.pageX + 15) + 'px';
    t.style.top = (event.pageY - 15) + 'px';
}

function hideTooltip() {
    const t = document.getElementById('d3-tooltip');
    if (t) t.style.opacity = 0;
}

/**
 * Updates the Objective Value Display
 */
function updateResultsUI() {
    const val = systemState.results.objectiveValue;
    if (els.objValueDisplay) {
        animateValue(els.objValueDisplay, val, 200, (v) =>
            v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 })
        );
    }
    drawCharts();
}

/**
 * Animates the Changing of a Displayed Number.
 */
function animateValue(element, end, duration, formatter) {
    let start = 0;
    const existing = element.textContent.replace(/[^0-9.-]+/g, "");
    if (existing && !isNaN(existing)) start = parseFloat(existing);

    const startTime = performance.now();
    function step(now) {
        const progress = Math.min((now - startTime) / duration, 1);
        const val = start + (end - start) * (1 - Math.pow(1 - progress, 3));
        element.textContent = formatter(val);
        if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}