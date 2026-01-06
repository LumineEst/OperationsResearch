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

// Date Conversion Values
const monthNames = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * State Management Object - Used for Central Variable Control, to help ensure data consistency.
 * @property {Array<number>} operationalTime - Array representing available operational hours per day of the week
 * @property {Array<Object>} products - List of product objects with costs/demands, managed through JSON
 * @property {Object|null} results - Stores outputs from the MILP optimization engine (scripts/inventoryWorker.js)
 */
let systemState = {
    operationalTime: [0, 0, 0, 0, 0, 0, 0],
    products: JSON.parse(JSON.stringify(DEFAULT_PRODUCTS)),
    results: null
};

/**
 * Inventory Parameters bound to UI inputs to the DOM.
 */
let liveState = {
    rawSteelCost: 2000,
    invCost: 20,
    maxCapacity: 500,
    backorderPenalty: 2
};

/**
 * Financial Stock Trading Parameters bound to UI inputs to the DOM.
 */
let stockState = {
    prices: [],
    stocks: [],
    results: null
};

/**
 * Scheduling Parameters bound to UI Inputs to the DOM.
 */
let schedState = {
    employees: [], // { id, pay, minHrs, maxHrs, skills[], availability: {0: [], 1: []...}}
    demands: [], // Hourly demands
    selectedEmpId: null,
    results: null
}

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
    topPanels: document.querySelectorAll('.vis-panel'),
    tabs: document.getElementById('tabs'),
    panels: document.querySelectorAll('.vis-panel'),
    chartPanel: document.getElementById('charts-panel'),
    saveConfigBtn: document.getElementById('saveConfigBtn'),
    addProductBtn: document.getElementById('addProductBtn'),
    autoSaveStatus: document.getElementById('autoSaveStatus'),
    exportBtn: document.getElementById('exportBtn'),
    universalExcelInput: document.getElementById('universalExcelInput'),
    globalObjDisplay: document.getElementById('globalObjDisplay'),
    statusIndicator: document.getElementById('statusIndicator'),
    topNav: document.getElementById('topNav'),
    stockExcelInput: document.getElementById('stockExcelInput'),
    stockTableHead: document.getElementById('stockTableHead'),
    stockTableBody: document.getElementById('stockTableBody'),
    stockTabs: document.getElementById('stockTabs'),
    schedulingTableBody: document.getElementById('schedulingTableBody'),
    schedulingStatus: document.getElementById('schedulingStatus')
};

// ============================================================================
// WORKER MANAGEMENT & OPTIMIZATION LOGIC
// ============================================================================
let currentWorker = null; // The Active Web-Worker instance
let solveTimer = null; // Debounce Timer

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

    const activeTab = document.querySelector('.top-tab-btn.active');
    if (activeTab) {
        const module = activeTab.dataset.topTab;
        setTimeout(() => loadModuleData(module), 100);
    }

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
 * Automatically loads data for a specific module and runs optimization.
 * @param {string} moduleType - 'inventory', 'stocks', or 'scheduling'
 */
async function loadModuleData(moduleType) {
    let filePath = '';

    // Determine the correct default file
    if (moduleType === 'inventory') {
        filePath = 'data/Inventory.xlsx';
    } else if (moduleType === 'stocks') {
        filePath = 'data/Stocks.xlsx';
    } else if (moduleType === 'scheduling') {
        filePath = 'data/Scheduling.xlsx'
    }

    try {
        updateStatus(`Loading ${moduleType} data...`, "solving");
        const response = await fetch(filePath);

        if (response.ok) {
            const buffer = await response.arrayBuffer();
            const workbook = XLSX.read(buffer);

            // Route to the appropriate parser (which triggers the respective solve)
            if (moduleType === 'inventory') {
                processInventoryWorkbook(workbook);
            } else if (moduleType === 'stocks') {
                processStockWorkbook(workbook);
            } else if (moduleType === 'scheduling') {
                processSchedulingWorkbook(workbook);
            }
        } else {
            console.warn(`Default file not found: ${filePath}`);
            updateStatus("File Not Found", "error");
        }
    } catch (err) {
        console.error("Data Load Error:", err);
        updateStatus("Load Error", "error");
    }
}

/**
 * HEURISTIC MINIMUMS
 * Calculates the absolute floor for Capacity and Operational Time.
 * This is to prevent optimization of impossible scenarios.
 */
function calculateTheoreticalFloor(params) {
    // Initialize Operational Totals
    const numDays = 7;
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
        floorCap: totalDemand / numDays,
        floorTime: totalProcTime / (numDays * 3600) // Hours per day
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
    currentWorker = new Worker('scripts/inventoryWorker.js');

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
 * requestStockSolve - The Simulation Controller
 * Manages the execution flow of the LP model based on user-selected strategy.
 */
function requestStockSolve() {
    if (!stockState.prices || stockState.prices.length === 0) return;

    updateStatus("Solving Optimal Path...", "solving");

    // Gather clean parameters directly from UI
    const params = {
        prices: stockState.prices, // Raw, undistorted historical prices
        initialCash: parseFloat(document.getElementById('initialCash').value) || 10000000,
        dailyInterest: parseFloat(document.getElementById('dailyInterest').value) || 0,
        marginalChangeParam: parseFloat(document.getElementById('marginalSlippage').value) || 0.002,
        decayFactor: parseFloat(document.getElementById('decayFactor').value) || 0,
        minTrade: parseFloat(document.getElementById('minTrade').value) || 1000
    };

    if (currentWorker) currentWorker.terminate();
    currentWorker = new Worker('scripts/stocksWorker.js');

    currentWorker.onmessage = (e) => {
        if (e.data.type === 'result' && e.data.status === 'Optimal') {
            stockState.results = e.data.result;
            updateStockResultsUI();
            updateStatus("Optimal Path Found", "optimal");
        } else {
            updateStatus("Infeasible Logic", "error");
        }
    };

    currentWorker.onerror = (err) => {
        console.error("Worker Error:", err);
        updateStatus("Solver Error", "error");
    };

    currentWorker.postMessage({ type: 'solve', data: params });
}

/**
 * STOCK KPI UPDATE
 */
function updateStockResultsUI() {
    if (!stockState.results) return;

    // Rounding to nearest dollar
    const val = Math.round(stockState.results.finalPortfolioValue);
    const display = document.getElementById('globalObjDisplay');
    const label = document.getElementById('kpiLabel');

    if (label) label.textContent = "Final Portfolio Value";
    if (display) {
        animateValue(display, val, 400, (v) =>
            Math.round(v).toLocaleString('en-US', {
                style: 'currency',
                currency: 'USD',
                maximumFractionDigits: 0 // Remove cents
            })
        );
    }

    // Draw stock charts if active
    const stockActive = document.getElementById('stocks-panel').classList.contains('active');
    if (stockActive) {
        drawStockCharts();
    }
}

function requestSchedulingSolve() {
    if (!schedState.employees || schedState.employees.length === 0) return;

    updateStatus("Optimizing Roster...", "solving");

    const params = {
        employees: schedState.employees,
        demands: schedState.demands,
        shiftLength: parseInt(document.getElementById('shiftLength').value) || schedState.employees.length
    };

    if (currentWorker) currentWorker.terminate();
    currentWorker = new Worker('scripts/scheduleWorker.js');

    currentWorker.onmessage = (e) => {
        if (e.data.type === 'result' && e.data.status === 'Optimal') {
            schedState.results = e.data.result;
            updateSchedulingResultsUI();
            updateStatus("Optimal Roster Found", "optimal");
        } else {
            updateStatus("Infeasible Requirements", "error");
        }
    };

    currentWorker.onerror = (err) => {
        console.error("Scheduling Worker Error:", err);
        updateStatus("Solver Error", "error");
    };

    currentWorker.postMessage({ type: 'solve', data: params });
}

/**
 * Adds UI controls for filtering the roster
 */
function updateSchedulingResultsUI() {
    if (!schedState.results) return;

    // Update KPI (Labor Cost)
    const display = document.getElementById('globalObjDisplay');
    if (display) {
        animateValue(display, schedState.results.objective, 400, (v) =>
            Math.round(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
        );
    }

    const container = document.getElementById('scheduling-panel-sub');
    container.innerHTML = `
        <div class="roster-header" style="display:flex; align-items:center; justify-content:space-between; margin-bottom:15px;">
            <div style="display:flex; align-items:center; gap:15px;">
                <h3>Optimal Roster</h3>
                <select id="rosterDaySelect" class="input-group" style="padding:5px; border-radius:4px;">
                    <option value="all">Full Week</option>
                    <option value="0">Sunday</option><option value="1">Monday</option>
                    <option value="2">Tuesday</option><option value="3">Wednesday</option>
                    <option value="4">Thursday</option><option value="5">Friday</option>
                    <option value="6">Saturday</option>
                </select>
            </div>
            <div id="rosterLegend"></div>
        </div>
        <div id="rosterChartContainer" style="overflow-x:auto;"></div>
    `;

    const skillNames = ["Cashiers", "Stocking", "Customer Service", "BackRoom", "Floor Associate"];
    drawSchedulingLegend(document.getElementById('rosterLegend'), skillNames);

    // Re-draw chart on select change
    document.getElementById('rosterDaySelect').addEventListener('change', drawRosterChart);

    drawRosterChart();
}
/**
 * Resets the global sidebar metrics to a neutral state.
 */
function resetGlobalKPI() {
    const display = document.getElementById('globalObjDisplay');

    // Animate KPI back to zero
    if (display) {
        animateValue(display, 0, 300, (v) =>
            v.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
        );
    }
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

function getFormattedDate(dayIdx) {
    const row = stockState.prices[dayIdx];
    const month = monthNames[parseInt(row.Month)] || row.Month;
    return `${month} ${row.Day}`;
}

/**
 * Converts array of hours [10, 11, 12, 14] into string "10-13, 14"
 */
function formatAvailability(hoursArray) {
    if (!hoursArray || hoursArray.length === 0) return "Not Available";

    // Force numeric sort to prevent ["10", "2", "20"] issues
    const sorted = [...hoursArray].map(Number).sort((a, b) => a - b);

    let blocks = [];
    let start = sorted[0];
    let prev = sorted[0];

    for (let i = 1; i <= sorted.length; i++) {
        if (i < sorted.length && sorted[i] === prev + 1) {
            prev = sorted[i];
        } else {
            // Display as "10-14" (meaning 10, 11, 12, 13) or "10"
            blocks.push(start === prev ? `${start}` : `${start}-${prev + 1}`);
            if (i < sorted.length) {
                start = sorted[i];
                prev = sorted[i];
            }
        }
    }
    return blocks.join(", ");
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
            processInventoryWorkbook(workbook);
            console.log("Sample Data Loaded");
        }
    } catch (e) { console.warn("No SampleData.xlsx found in /data, using defaults."); }
}

/**
 * Handles user-uploaded Excel files.
 */
async function handleUniversalUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const activeTabBtn = document.querySelector('.top-tab-btn.active');
    const activeModule = activeTabBtn ? activeTabBtn.dataset.topTab : 'inventory';

    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data);

    switch (activeModule) {
        case 'inventory':
            processInventoryWorkbook(workbook); // Inventory Tab
            break;
        case 'stocks':
            processStockWorkbook(workbook); // Stock Trading Tab
            break;
        case 'scheduling':
            processSchedulingWorkbook(workbook); // Scheduling Tab
            break;
    }
    event.target.value = '';
}

/**
 * Parses the Excel workbook using a dynamic, keyword-based approach.
 * Allows for variable row locations and any number of products.
 * @param {Object} workbook - SheetJS Workbook Object
 */
function processInventoryWorkbook(workbook) {
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
 * Stock-specific Parser
 */
function processStockWorkbook(workbook) {
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet);

    if (json.length > 0) {
        stockState.prices = json;
        stockState.stocks = Object.keys(json[0]).filter(k => k !== 'Month' && k !== 'Day');
        renderStockTable();
        requestStockSolve();
    }
}

/**
 * Renders the Price History table for the Stock module.
 * Dynamically identifies stock names and populates rows.
 */
function renderStockTable() {
    // 1. Clear and Update Table Header
    // Adds Month and Day, then maps every identified stock name as a column header
    let headerHtml = `<tr><th>Month</th><th>Day</th>`;
    stockState.stocks.forEach(stock => {
        headerHtml += `<th>${stock}</th>`;
    });
    headerHtml += `</tr>`;

    if (els.stockTableHead) {
        els.stockTableHead.innerHTML = headerHtml;
    }

    // 2. Clear and Update Table Body
    // We slice to the first 365 rows to maintain performance for large datasets
    if (els.stockTableBody) {
        els.stockTableBody.innerHTML = '';

        const displayRows = stockState.prices.slice(0, 365);

        displayRows.forEach(row => {
            let rowHtml = `<tr>
                <td>${row.Month || ''}</td>
                <td>${row.Day || ''}</td>`;

            // Map the value for each specific stock in the current row
            stockState.stocks.forEach(stock => {
                const val = parseFloat(row[stock]) || 0;
                rowHtml += `<td>$${val.toFixed(2)}</td>`;
            });

            rowHtml += `</tr>`;
            els.stockTableBody.innerHTML += rowHtml;
        });

        // Add a message if data is truncated for view
        if (stockState.prices.length > 365) {
            els.stockTableBody.innerHTML += `
                <tr>
                    <td colspan="${stockState.stocks.length + 2}" style="text-align:center; color:#888; font-style:italic;">
                        Showing first year of entries. Entire dataset (${stockState.prices.length} days) used for optimization.
                    </td>
                </tr>`;
        }
    }
}

function processSchedulingWorkbook(workbook) {
    try {
        const empSheet = workbook.Sheets["Employees Requests"];
        if (!empSheet) throw new Error("Sheet 'Employees Requests' not found");

        const rows = XLSX.utils.sheet_to_json(empSheet, { header: 1 });

        // 1. Standardized Skill Names (Matches Demands Sheet Headers)
        const skillNames = ["Cashiers", "Stocking", "Customer Service", "BackRoom", "Floor Associate"];

        // 2. Lexicographical ID Sort
        const empIds = rows[0].slice(1)
            .filter(id => id !== undefined && id !== "")
            .sort();

        schedState.employees = empIds.map((id) => {
            const col = rows[0].indexOf(id);
            return {
                id: id,
                pay: rows[1][col],
                minHrs: rows[2][col],
                maxHrs: rows[3][col],
                skills: [],
                availability: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }
            };
        });

        // 3. Parse Skills using mapped column indices
        schedState.employees.forEach(emp => {
            const col = rows[0].indexOf(emp.id);
            for (let r = 4; r <= 8; r++) {
                if (rows[r] && Number(rows[r][col]) === 1) {
                    emp.skills.push(skillNames[r - 4]);
                }
            }
        });

        // 4. Parse Availability (Handling "Day,Hour" format)
        for (let r = 10; r < rows.length; r++) {
            const row = rows[r];
            if (!row || !row[0]) continue;

            const parts = String(row[0]).split(',');
            if (parts.length < 2) continue;

            const d = parseInt(parts[0]);
            const h = parseInt(parts[1]);

            schedState.employees.forEach(emp => {
                const col = rows[0].indexOf(emp.id);
                // Ensure we handle both string "1" and numeric 1
                if (Number(row[col]) === 1) {
                    if (emp.availability[d]) emp.availability[d].push(h);
                }
            });
        }

        // 5. Parse and Normalize Demands (Ensure exactly 168 slots)
        const demandSheet = workbook.Sheets["Company Demands"] || workbook.Sheets["Demands"];
        if (demandSheet) {
            const raw = XLSX.utils.sheet_to_json(demandSheet);
            const demandMap = {};

            // Map raw data to a lookup table
            raw.forEach(row => {
                const key = row["Required Employees"]; // e.g., "0,10"
                demandMap[key] = row;
            });

            // Create normalized 168-slot array
            const normalizedDemands = [];
            for (let d = 0; d < 7; d++) {
                for (let h = 0; h < 24; h++) {
                    const lookup = `${d},${h}`;
                    const existing = demandMap[lookup] || {};
                    const slot = { day: d, hour: h };
                    skillNames.forEach(s => slot[s] = parseFloat(existing[s]) || 0);
                    normalizedDemands.push(slot);
                }
            }
            schedState.demands = normalizedDemands;
        }

        renderEmployeeList();
        if (schedState.employees.length > 0) selectEmployee(schedState.employees[0].id);
        requestSchedulingSolve();
        updateStatus("Data Loaded = Starting Solver...", "solving");

    } catch (err) {
        console.error("Scheduling Import Error:", err);
        updateStatus("Import Error", "error");
    }
}

/**
 * Exports Optimized Results to an Excel Spreadsheet (.xlsx)
 */
function handleExport() {
    console.log("Export triggered...");

    // Find the active module by looking for the .active class on top tabs
    const activeTabBtn = document.querySelector('.top-tab-btn.active');

    // Fallback logic in case the selector fails
    const activeModule = activeTabBtn ? activeTabBtn.getAttribute('data-top-tab') : 'inventory';

    console.log("Active Module detected:", activeModule);

    if (activeModule === 'inventory') {
        if (!systemState.results) {
            alert("No production results found. Please ensure the solver has finished.");
            return;
        }

        const wb = XLSX.utils.book_new();
        const wsData = [
            ["Optimized Production Schedule"],
            ["Total Profit", systemState.results.objectiveValue],
            []
        ];

        systemState.results.details.forEach(p => {
            wsData.push([p.product]);
            wsData.push(["Metric", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
            wsData.push(["Produced", ...p.produced]);
            wsData.push(["Sold", ...p.sold]);
            wsData.push(["Ending Inv", ...p.inventory]);
            wsData.push(["Backorder", ...p.backorder]);
            wsData.push([]);
        });

        const ws = XLSX.utils.aoa_to_sheet(wsData);
        XLSX.utils.book_append_sheet(wb, ws, "Production Solution");
        XLSX.writeFile(wb, "Production_Results.xlsx");

    } else if (activeModule === 'stocks') {
        if (!stockState.results) {
            alert("No stock results found. Please ensure the market analysis has finished.");
            return;
        }

        const logs = stockState.results.dailyLogs;
        const stockNames = stockState.stocks;
        const wb = XLSX.utils.book_new();

        // TAB 1: Daily Activity Ledger
        const ledgerHeader = ["Date", "Cash Reserves", ...stockNames.map(s => `${s} Change`)];
        const ledgerData = logs.map((d, i) => {
            const row = [getFormattedDate(i), d.cashHeld];
            stockNames.forEach(s => {
                const change = (d.buys[s] || 0) - (d.sells[s] || 0);
                row.push(change);
            });
            return row;
        });
        const wsLedger = XLSX.utils.aoa_to_sheet([ledgerHeader, ...ledgerData]);
        XLSX.utils.book_append_sheet(wb, wsLedger, "Daily Activity");

        // TAB 2: Cumulative Holdings
        const accumulationHeader = ["Date", "Total Portfolio Value", "Cash Position", ...stockNames];
        const accumulationData = logs.map((d, i) => {
            const row = [getFormattedDate(i), d.totalValue, d.cashHeld];
            stockNames.forEach(s => row.push(d.stockValues[s] || 0));
            return row;
        });
        const wsAccumulation = XLSX.utils.aoa_to_sheet([accumulationHeader, ...accumulationData]);
        XLSX.utils.book_append_sheet(wb, wsAccumulation, "Cumulative Holdings");

        const dateTag = new Date().toISOString().slice(0, 10);
        XLSX.writeFile(wb, `Portfolio_Analysis.xlsx`);
    } else {
        console.warn("No valid module found for export.");
    }
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
        .attr("stroke", "#666").style("opacity", 0.8);
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
                        Inventory: ${inv} tons<br>
                        Backorder: <span class="${backorder > 0 ? 'tooltip-value-bad' : ''}">${backorder} tons</span><br>
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

/**
 * Draws the Top Chart: Daily Trade Activity
 * Shows Cash vs. Buy transactions per day.
 */
function drawStockActivityChart() {
    const container = document.getElementById('portfolioChartContainer');
    if (!container || !stockState.results) return;
    container.innerHTML = '';

    const tooltip = createTooltip("stock-activity-tooltip");
    const rect = container.getBoundingClientRect();
    const margin = { top: 20, right: 30, bottom: 40, left: 70 };
    const width = rect.width - margin.left - margin.right;
    const height = rect.height - margin.top - margin.bottom;

    const svg = d3.select(container).append("svg")
        .attr("width", rect.width).attr("height", rect.height)
        .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const data = stockState.results.dailyLogs;
    const N = data.length;
    const stockNames = stockState.stocks;
    const color = d3.scaleOrdinal().domain(stockNames).range(d3.schemeCategory10);

    const stackData = data.map(d => {
        const row = { dayIdx: d.dayIdx };
        stockNames.forEach(s => row[s] = (d.buys[s] || 0) - (d.sells[s] || 0));
        return row;
    });

    const stackedSeries = d3.stack().keys(stockNames).offset(d3.stackOffsetDiverging)(stackData);
    const y = d3.scaleLinear()
        .domain([d3.min(stackedSeries, s => d3.min(s, d => d[0])) * 1.1, d3.max(stackedSeries, s => d3.max(s, d => d[1])) * 1.1])
        .range([height, 0]);

    // 1. ADD ZERO LINE
    svg.append("line")
        .attr("x1", 0).attr("x2", width)
        .attr("y1", y(0)).attr("y2", y(0))
        .attr("stroke", "#666").attr("stroke-width", 1).style("opacity", 0.8);

    const monthStarts = [];
    let currentM = -1;
    data.forEach((d, i) => {
        const m = parseInt(stockState.prices[i].Month);
        if (m !== currentM) {
            monthStarts.push({ index: i, label: monthNames[m].substring(0, 3) });
            currentM = m;
        }
    });

    const layers = svg.selectAll(".layer").data(stackedSeries).enter().append("g")
        .attr("class", "layer").attr("fill", d => color(d.key));

    // 2. ADD BORDER (STROKE) TO BARS
    const bars = layers.selectAll("rect").data(d => d).enter().append("rect")
        .attr("stroke", "#fff").attr("stroke-width", "1px")
        .attr("y", d => y(d[1])).attr("height", d => Math.abs(y(d[0]) - y(d[1])));

    const axisLayer = svg.append("g").attr("transform", `translate(0,${height})`);
    const monthLabels = axisLayer.selectAll(".month-label")
        .data(monthStarts).enter().append("text")
        .attr("class", "month-label").attr("y", 25).attr("text-anchor", "middle")
        .style("font-size", "11px").attr("fill", "#666").text(d => d.label);

    function updateGeometry(hoverIndex, mx) {
        const positions = new Float32Array(N + 1);
        if (hoverIndex === null) {
            for (let i = 0; i <= N; i++) positions[i] = (i / N) * width;
        } else {
            const distortionStrength = 6.0;
            const distortionRadius = 30;
            const weights = new Float32Array(N);
            for (let i = 0; i < N; i++) {
                const dist = Math.abs(i - hoverIndex);
                weights[i] = 1 + distortionStrength * Math.exp(-(dist * dist) / (2 * distortionRadius * distortionRadius));
            }
            let leftTotal = 0; for (let i = 0; i < hoverIndex; i++) leftTotal += weights[i];
            leftTotal += weights[hoverIndex] * 0.5;
            let rightTotal = weights[hoverIndex] * 0.5; for (let i = hoverIndex + 1; i < N; i++) rightTotal += weights[i];
            const scaleL = mx / leftTotal; const scaleR = (width - mx) / rightTotal;
            positions[0] = 0;
            for (let i = 0; i < N; i++) {
                const w = weights[i];
                if (i < hoverIndex) positions[i + 1] = positions[i] + w * scaleL;
                else if (i > hoverIndex) positions[i + 1] = positions[i] + w * scaleR;
                else positions[i + 1] = mx + (w * 0.5 * scaleR);
            }
        }
        bars.attr("x", (d, i) => positions[i]).attr("width", (d, i) => Math.max(0, positions[i + 1] - positions[i] - 0.2));
        let lastX = -100;
        monthLabels.attr("x", (d, i) => {
            const nextIdx = (i < monthStarts.length - 1) ? monthStarts[i + 1].index : N;
            return (positions[d.index] + positions[nextIdx]) / 2;
        }).style("opacity", function () {
            const cx = parseFloat(d3.select(this).attr("x"));
            if (cx - lastX < 30 || cx < 5 || cx > width - 5) return 0;
            lastX = cx; return 1;
        });
    }

    svg.append("rect").attr("width", width).attr("height", height).attr("fill", "transparent")
        .on("mousemove", function (event) {
            const [mx] = d3.pointer(event);
            const idx = Math.max(0, Math.min(N - 1, Math.round((mx / width) * (N - 1))));
            updateGeometry(idx, mx);
            showTopTooltip(data[idx], idx > 0 ? data[idx - 1] : null, event, tooltip, color);
        })
        .on("mouseleave", () => { updateGeometry(null); tooltip.style("opacity", 0); });

    // 3. ADD Y AXIS
    svg.append("g").call(d3.axisLeft(y).tickFormat(d3.format("$.2s")));
    updateGeometry(null);
}

/**
 * Draws the Bottom Chart: Portfolio Composition
 * Shows the value of shares held for each stock over time.
 */
function drawPortfolioCompositionChart() {
    const container = document.getElementById('allocationChartContainer');
    if (!container || !stockState.results) return;
    container.innerHTML = '';

    const tooltip = createTooltip("stock-composition-tooltip");
    const rect = container.getBoundingClientRect();
    const margin = { top: 20, right: 30, bottom: 40, left: 70 };
    const width = rect.width - margin.left - margin.right;
    const height = rect.height - margin.top - margin.bottom;

    const svg = d3.select(container).append("svg")
        .attr("width", rect.width).attr("height", rect.height)
        .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const data = stockState.results.dailyLogs;
    const N = data.length;
    const keys = [...stockState.stocks, "Cash"];
    const color = d3.scaleOrdinal().domain(keys).range([...d3.schemeCategory10, "#95a5a6"]);

    const stackData = data.map(d => {
        const row = { Cash: d.cashHeld };
        Object.entries(d.stockValues).forEach(([s, v]) => row[s] = v);
        return row;
    });

    const stackedSeries = d3.stack().keys(keys)(stackData);
    const y = d3.scaleLinear().domain([0, d3.max(data, d => d.totalValue) * 1.05]).range([height, 0]);

    // 1. APPLY 0.5 OPACITY TO CASH LAYER AND BORDERS
    const layers = svg.selectAll(".layer").data(stackedSeries).enter().append("g")
        .attr("class", "layer")
        .attr("fill", d => color(d.key))
        .attr("fill-opacity", d => d.key === "Cash" ? 0.3 : 1);

    const areas = layers.selectAll("rect").data(d => d).enter().append("rect")
        .attr("stroke", "rgba(255,255,255,0.3)").attr("stroke-width", "1px")
        .attr("y", d => y(d[1])).attr("height", d => Math.abs(y(d[0]) - y(d[1])));

    const axisLayer = svg.append("g").attr("transform", `translate(0,${height})`);
    const monthStarts = [];
    let currentM = -1;
    data.forEach((d, i) => {
        const m = parseInt(stockState.prices[i].Month);
        if (m !== currentM) {
            monthStarts.push({ index: i, label: monthNames[m].substring(0, 3) });
            currentM = m;
        }
    });

    const monthLabels = axisLayer.selectAll(".month-label")
        .data(monthStarts).enter().append("text")
        .attr("class", "month-label").attr("y", 25).attr("text-anchor", "middle")
        .style("font-size", "11px").attr("fill", "#666").text(d => d.label);

    function updateGeometry(hoverIndex, mx) {
        const positions = new Float32Array(N + 1);
        if (hoverIndex === null) {
            for (let i = 0; i <= N; i++) positions[i] = (i / N) * width;
        } else {
            const distortionStrength = 6.0;
            const distortionRadius = 30;
            const weights = new Float32Array(N);
            for (let i = 0; i < N; i++) {
                const dist = Math.abs(i - hoverIndex);
                weights[i] = 1 + distortionStrength * Math.exp(-(dist * dist) / (2 * distortionRadius * distortionRadius));
            }
            let lT = 0; for (let i = 0; i < hoverIndex; i++) lT += weights[i];
            lT += weights[hoverIndex] * 0.5;
            let rT = weights[hoverIndex] * 0.5; for (let i = hoverIndex + 1; i < N; i++) rT += weights[i];
            const sL = mx / lT; const sR = (width - mx) / rT;
            positions[0] = 0;
            for (let i = 0; i < N; i++) {
                const w = weights[i];
                if (i < hoverIndex) positions[i + 1] = positions[i] + w * sL;
                else if (i > hoverIndex) positions[i + 1] = positions[i] + w * sR;
                else positions[i + 1] = mx + (w * 0.5 * sR);
            }
        }
        areas.attr("x", (d, i) => positions[i]).attr("width", (d, i) => Math.max(0, positions[i + 1] - positions[i]));
        let lastX = -100;
        monthLabels.attr("x", (d, i) => {
            const nextIdx = (i < monthStarts.length - 1) ? monthStarts[i + 1].index : N;
            return (positions[d.index] + positions[nextIdx]) / 2;
        }).style("opacity", function () {
            const cx = parseFloat(d3.select(this).attr("x"));
            if (cx - lastX < 30 || cx < 5 || cx > width - 5) return 0;
            lastX = cx; return 1;
        });
    }

    svg.append("rect").attr("width", width).attr("height", height).attr("fill", "transparent")
        .on("mousemove", function (event) {
            const [mx] = d3.pointer(event);
            const idx = Math.max(0, Math.min(N - 1, Math.round((mx / width) * (N - 1))));
            updateGeometry(idx, mx);
            showBottomTooltip(data[idx], idx > 0 ? data[idx - 1] : null, event, tooltip, color);
        })
        .on("mouseleave", () => { updateGeometry(null); tooltip.style("opacity", 0); });

    // 2. ADD Y AXIS
    svg.append("g").call(d3.axisLeft(y).tickFormat(d3.format("$.2s")));
    updateGeometry(null);
}

function showTopTooltip(d, prevD, event, tooltip, colorScale) {
    const dateStr = getFormattedDate(d.dayIdx);
    const growth = prevD ? ((d.totalValue - prevD.totalValue) / prevD.totalValue) * 100 : 0;
    const priceRow = stockState.prices[d.dayIdx]; // Get current prices for this day

    let buyHtml = '', sellHtml = '';
    stockState.stocks.forEach(name => {
        const sharesBought = d.buys[name] || 0;
        const sharesSold = d.sells[name] || 0;
        const price = parseFloat(priceRow[name]) || 0;
        const c = colorScale(name);

        if (sharesBought > 0) {
            const dollarAmount = sharesBought * price;
            buyHtml += `
                <div class="tooltip-metric">
                    <span><i style="display:inline-block;width:8px;height:8px;background:${c};margin-right:5px;border-radius:1px;"></i>${name}:</span>
                    <span>${formatCurrency(dollarAmount)} (${sharesBought.toFixed(1)} shares)</span>
                </div>`;
        }
        if (sharesSold > 0) {
            const dollarAmount = sharesSold * price;
            sellHtml += `
                <div class="tooltip-metric">
                    <span><i style="display:inline-block;width:8px;height:8px;background:${c};margin-right:5px;border-radius:1px;"></i>${name}:</span>
                    <span>${formatCurrency(dollarAmount)} (${sharesSold.toFixed(1)} shares)</span>
                </div>`;
        }
    });

    tooltip.style("opacity", 1)
        .html(`
            <div style="font-weight:bold; border-bottom:1px solid #555; margin-bottom:5px;">${dateStr}</div>
            <div class="tooltip-row"><span>Cash Held:</span> <span>${formatCurrency(d.cashHeld)}</span></div>
            <div class="tooltip-row"><span>Daily Change:</span> <span style="color:${growth >= 0 ? '#2ecc71' : '#e74c3c'}">${growth.toFixed(2)}%</span></div>
            ${buyHtml ? `<div class="tooltip-block buy-block"><strong>Total Bought</strong>${buyHtml}</div>` : ''}
            ${sellHtml ? `<div class="tooltip-block sell-block"><strong>Total Sold</strong>${sellHtml}</div>` : ''}
        `)
        .style("left", (event.pageX + 15) + "px").style("top", (event.pageY - 28) + "px");
}

function showBottomTooltip(d, prevD, event, tooltip, colorScale) {
    const dateStr = getFormattedDate(d.dayIdx);
    const initialCash = parseFloat(document.getElementById('initialCash').value) || 10000000;
    const annReturn = ((d.totalValue - initialCash) / initialCash) * 100;

    let holdingsHtml = `<div class="tooltip-row">
        <span><i style="display:inline-block;width:8px;height:8px;background:${colorScale('Cash')};margin-right:5px;border-radius:1px;"></i>Cash:</span>
        <span>${formatCurrency(d.cashHeld)}</span>
    </div>`;

    Object.entries(d.stockValues).sort((a, b) => b[1] - a[1]).forEach(([name, val]) => {
        if (val > 1) {
            holdingsHtml += `<div class="tooltip-row">
                <span><i style="display:inline-block;width:8px;height:8px;background:${colorScale(name)};margin-right:5px;border-radius:1px;"></i>${name}:</span>
                <span>${formatCurrency(val)}</span>
            </div>`;
        }
    });

    tooltip.style("opacity", 1)
        .html(`
            <div style="font-weight:bold; border-bottom:1px solid #555; margin-bottom:5px;">Portfolio State</div>
            <strong>${dateStr}</strong>
            <div class="tooltip-row"><span>Total Worth:</span> <strong>${formatCurrency(d.totalValue)}</strong></div>
            <div class="tooltip-row"><span>Annual Return:</span> <strong style="color:${annReturn >= 0 ? '#2ecc71' : '#e74c3c'}">${annReturn.toFixed(2)}%</strong></div>
            <hr style="margin:5px 0; border-top:1px solid #444">
            <div style="font-size:0.75rem;"><strong>Current Allocation:</strong>${holdingsHtml}</div>
        `)
        .style("left", (event.pageX + 15) + "px").style("top", (event.pageY - 28) + "px");
}

function drawStockLegend() {
    const container = document.getElementById('sharedStockLegend');
    if (!container) return;
    container.innerHTML = '';

    // CENTER THE LEGEND
    container.style.display = 'flex';
    container.style.justifyContent = 'center';
    container.style.alignItems = 'center';
    container.style.flexWrap = 'wrap';

    const items = [...stockState.stocks, "Cash"];
    const color = d3.scaleOrdinal().domain(items).range([...d3.schemeCategory10, "#95a5a6"]);

    items.forEach(item => {
        const div = document.createElement('div');
        div.style.display = 'inline-flex';
        div.style.alignItems = 'center';
        div.style.margin = '5px 15px'; // Adjusted spacing for centering
        div.innerHTML = `
            <div style="width:12px;height:12px;background:${color(item)};margin-right:8px;border-radius:2px;${item === 'Cash' ? 'opacity:0.5;' : ''}"></div>
            <span style="font-size:0.8rem;color:#555;font-weight:500;">${item}</span>
        `;
        container.appendChild(div);
    });
}

// Master draw function for the Stock Tab
function drawStockCharts() {
    if (!stockState.results) return;
    drawStockActivityChart();
    drawPortfolioCompositionChart();
    drawStockLegend();
}

/**
 * Main Controller for Employee Details
 * Populates Profile, Availability Table, and the Schedule Gantt
 */
function selectEmployee(id) {
    console.log("Selecting Employee:", id); // Check console to see if this triggers
    schedState.selectedEmpId = id;
    const emp = schedState.employees.find(e => e.id === id);
    if (!emp) return;

    // 1. Update Sidebar Active State
    document.querySelectorAll('.emp-item').forEach(el => {
        el.classList.toggle('active', el.textContent === id);
    });

    // 2. Populate Profile Data
    const profileEl = document.getElementById('employeeProfileContent');
    if (profileEl) {
        profileEl.innerHTML = `
            <div class="profile-grid" style="color: #222;">
                <p><strong>Pay:</strong> $${parseFloat(emp.pay).toFixed(2)}/hr</p>
                <p><strong>Hours:</strong> ${emp.minHrs} - ${emp.maxHrs}</p>
                <p style="grid-column: span 2;"><strong>Skills:</strong> ${emp.skills.join(', ') || 'None'}</p>
            </div>
        `;
    }

    // 3. Populate Availability Table (Dark Text)
    const availEl = document.getElementById('employeeAvailabilityContent');
    if (availEl) {
        const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        let html = `<table class="availability-table" style="width:100%; color: #222;">`;
        dayNames.forEach((name, idx) => {
            const timeStr = formatAvailability(emp.availability[idx]);
            html += `<tr><td style="font-weight:bold; width:35%;">${name}</td><td>${timeStr}</td></tr>`;
        });
        availEl.innerHTML = html + `</table>`;
    }

    // 4. Draw Gantt Chart with a "Ready" check
    // We wait for the next animation frame to ensure the DOM has updated
    requestAnimationFrame(() => {
        renderIndividualGantt(emp);
    });
}

/**
 * Populates the scrollable list of Employee IDs
 */
function renderEmployeeList() {
    const list = document.getElementById('employeeList');
    if (!list) return;

    list.innerHTML = '';
    schedState.employees.forEach(emp => {
        const item = document.createElement('div');
        item.className = 'emp-item';
        // Add active class if this is the selected employee
        if (schedState.selectedEmpId === emp.id) item.classList.add('active');

        item.textContent = emp.id;
        item.onclick = () => selectEmployee(emp.id);
        list.appendChild(item);
    });
}

function renderIndividualGantt(emp) {
    const container = document.getElementById('individualGantt');
    if (!container) return;
    container.innerHTML = '';

    const margin = { top: 20, right: 30, bottom: 30, left: 60 };
    const width = (container.clientWidth || 800) - margin.left - margin.right;
    const rowHeight = 40;
    const height = 7 * rowHeight;

    const svg = d3.select(container).append("svg")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleLinear().domain([0, 24]).range([0, width]);
    const dayAbbr = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const skillNames = ["Cashiers", "Stocking", "Customer Service", "BackRoom", "Floor Associate"];
    const colorScale = d3.scaleOrdinal().domain(skillNames).range(d3.schemeCategory10);

    dayAbbr.forEach((day, dIdx) => {
        const y = dIdx * rowHeight;

        // Y-Axis Labels
        svg.append("text").attr("x", -10).attr("y", y + 20)
            .attr("text-anchor", "end").style("font-size", "12px").attr("fill", "#333").text(day);

        // Track Background
        svg.append("rect").attr("x", 0).attr("y", y).attr("width", width).attr("height", 30)
            .attr("fill", "#f8f9fa").attr("stroke", "#eee").attr("rx", 4);

        // 1. Availability (Green)
        if (emp.availability[dIdx]) {
            emp.availability[dIdx].forEach(h => {
                svg.append("rect").attr("x", x(h)).attr("y", y).attr("width", x(1) - x(0))
                    .attr("height", 30).attr("fill", "#c3e6cb").attr("opacity", 0.7);
            });
        }

        // 2. Scheduled Assignments (Tasks)
        if (schedState.results && schedState.results.roster) {
            const rosterEntry = schedState.results.roster.find(r => r.id === emp.id);
            if (rosterEntry) {
                for (let h = 0; h < 24; h++) {
                    const role = rosterEntry.schedule[dIdx * 24 + h];
                    if (role) {
                        svg.append("rect")
                            .attr("x", x(h)).attr("y", y + 4)
                            .attr("width", x(1) - x(0) - 1).attr("height", 22)
                            .attr("fill", colorScale(role))
                            .attr("rx", 2)
                            .append("title").text(role);
                    }
                }
            }
        }
    });

    svg.append("g").attr("transform", `translate(0,${height})`)
        .call(d3.axisBottom(x).ticks(12).tickFormat(d => d + ":00"));
}

/**
 * Updates the right-hand panel with specific Employee Details
 */
function selectEmployee(id) {
    schedState.selectedEmpId = id;
    const emp = schedState.employees.find(e => e.id === id);
    if (!emp) return;

    // Highlight in list
    document.querySelectorAll('.emp-item').forEach(el => {
        el.classList.toggle('active', el.textContent === id);
    });

    // Render Profile
    document.getElementById('employeeProfileContent').innerHTML = `
        <div class="profile-grid">
            <div class="profile-stat"><strong>Hourly Pay:</strong> $${parseFloat(emp.pay).toFixed(2)}</div>
            <div class="profile-stat"><strong>Min Hours:</strong> ${emp.minHrs}</div>
            <div class="profile-stat"><strong>Skills:</strong> ${emp.skills.join(', ') || 'None'}</div>
            <div class="profile-stat"><strong>Max Hours:</strong> ${emp.maxHrs}</div>
        </div>
    `;

    // Render Weekly Availability
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    let availHtml = `<table class="availability-table" style="width:100%">`;
    dayNames.forEach((name, idx) => {
        const timeString = formatAvailability(emp.availability[idx]);
        availHtml += `
            <tr>
                <td style="width:30%; font-weight:bold; color: #666;">${name}</td>
                <td style="color:${timeString === 'Not Available' ? '#222' : '#666'}">${timeString}</td>
            </tr>`;
    });
    availHtml += `</table>`;
    document.getElementById('employeeAvailabilityContent').innerHTML = availHtml;
}

function drawSchedulingCharts() {
    if (!schedState.employees.length || !schedState.demands.length) return;

    const skillNames = ["Cashiers", "Stocking", "Customer Service", "BackRoom", "Floor Associate"];

    // Aggregating Supply Data (Labor Availability)
    const supplyData = [];
    for (let d = 0; d < 7; d++) {
        for (let h = 0; h < 24; h++) {
            const slot = { day: d, hour: h, totalUnique: 0 };
            const uniqueEmps = new Set();
            skillNames.forEach(skill => slot[skill] = 0);

            schedState.employees.forEach(emp => {
                if (emp.availability[d].includes(h)) {
                    uniqueEmps.add(emp.id);
                    emp.skills.forEach(s => {
                        if (skillNames.includes(s)) slot[s]++;
                    });
                }
            });
            slot.totalUnique = uniqueEmps.size;
            supplyData.push(slot);
        }
    }

    // Ensure Legend Container exists between the two charts
    let legendContainer = document.getElementById('sharedSchedulingLegend');
    if (!legendContainer) {
        legendContainer = document.createElement('div');
        legendContainer.id = 'sharedSchedulingLegend';
        const supplyWrapper = document.getElementById('supplyChartContainer').parentElement;
        supplyWrapper.parentNode.insertBefore(legendContainer, supplyWrapper);
    }
    drawSchedulingLegend(legendContainer, skillNames);

    // Render the charts
    renderStackedChart("#demandChartContainer", schedState.demands, skillNames, "Demand");
    renderStackedChart("#supplyChartContainer", supplyData, skillNames, "Supply");
}

function drawSchedulingLegend(container, keys) {
    container.innerHTML = '';
    Object.assign(container.style, {
        display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '1.2rem', padding: '10px'
    });

    const color = d3.scaleOrdinal().domain(keys).range(d3.schemeCategory10);

    keys.forEach(key => {
        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.alignItems = 'center';

        const box = document.createElement('div');
        Object.assign(box.style, {
            width: '12px', height: '12px', backgroundColor: color(key), marginRight: '6px', borderRadius: '2px'
        });

        const text = document.createElement('span');
        text.textContent = key;
        text.style.fontSize = '0.85rem';
        text.style.color = '#333';

        item.appendChild(box);
        item.appendChild(text);
        container.appendChild(item);
    });
}

/**
 * Stacked Bar Chart Renderer
 */
function renderStackedChart(containerId, data, keys, type) {
    const container = d3.select(containerId);
    container.selectAll("*").remove();

    const rect = container.node().getBoundingClientRect();
    const margin = { top: 10, right: 30, bottom: 40, left: 50 };
    const width = rect.width - margin.left - margin.right;
    const height = rect.height - margin.top - margin.bottom;

    const svg = container.append("svg")
        .attr("width", rect.width)
        .attr("height", rect.height)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    const color = d3.scaleOrdinal().domain(keys).range(d3.schemeCategory10);
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    // 1. Calculate Variable Widths
    // Weight = 1.0 if any category > 0, else 0.5
    const weights = data.map(d => {
        const total = keys.reduce((sum, k) => sum + (d[k] || 0), 0);
        return total > 0 ? 1.0 : 0.3;
    });
    const totalWeight = d3.sum(weights);

    // Helper to get X position and Width for index i
    const getX = (index) => (d3.sum(weights.slice(0, index)) / totalWeight) * width;
    const getBarWidth = (index) => (weights[index] / totalWeight) * width;

    // 2. Y Scale
    const yMax = d3.max(data, d => keys.reduce((sum, k) => sum + (d[k] || 0), 0));
    const y = d3.scaleLinear().domain([0, Math.max(yMax, 1) * 1.1]).range([height, 0]);

    // 3. Axes
    // Draw Day labels at the start of each 24h block
    const xAxis = svg.append("g").attr("transform", `translate(0,${height})`);
    dayNames.forEach((day, i) => {
        const xPos = getX(i * 24);
        xAxis.append("text")
            .attr("x", xPos + 5)
            .attr("y", 20)
            .attr("fill", "#666")
            .style("font-size", "12px")
            .text(day);

        xAxis.append("line")
            .attr("x1", xPos).attr("x2", xPos)
            .attr("y1", 0).attr("y2", 5)
            .attr("stroke", "#ccc");
    });

    svg.append("g").call(d3.axisLeft(y).ticks(5));

    // 4. Bars
    const stackedData = d3.stack().keys(keys)(data);

    const layers = svg.selectAll(".layer")
        .data(stackedData)
        .enter().append("g")
        .attr("fill", d => color(d.key));

    layers.selectAll("rect")
        .data(d => d)
        .enter().append("rect")
        .attr("x", (d, i) => getX(i))
        .attr("y", d => y(d[1]))
        .attr("height", d => y(d[0]) - y(d[1]))
        .attr("width", (d, i) => getBarWidth(i) - 0.5);

    // 5. Tooltip Overlay (Transparent rects for per-hour hover)
    const tooltip = d3.select("#d3-tooltip");

    svg.selectAll(".tooltip-overlay")
        .data(data)
        .enter().append("rect")
        .attr("class", "tooltip-overlay")
        .attr("x", (d, i) => getX(i))
        .attr("y", 0)
        .attr("width", (d, i) => getBarWidth(i))
        .attr("height", height)
        .attr("fill", "transparent")
        .on("mouseover", function (event, d) {
            const isClosed = keys.reduce((sum, k) => sum + (d[k] || 0), 0) === 0;
            const totalDisplay = (type === "Supply") ? d.totalUnique : keys.reduce((sum, k) => sum + (d[k] || 0), 0);

            let html = `
                <div style="font-weight:bold; border-bottom:1px solid #444; margin-bottom:5px;">
                    ${dayNames[d.day]} - Hour ${d.hour}:00
                </div>`;
            if (isClosed) {
                html += `<div style="color:#e74c3c; font-weight:bold; text-align:center;">CLOSED</div>`;
            } else {
                keys.forEach(k => {
                    const val = d[k] || 0;
                    if (val > 0) {
                        html += `
                        <div style="display:flex; justify-content:space-between; gap:20px; font-size:0.85rem;">
                            <span><i style="display:inline-block; width:8px; height:8px; background:${color(k)}; margin-right:5px; border-radius:1px;"></i>${k}:</span>
                            <span style="font-weight:bold;">${val}</span>
                        </div>`;
                    }
                });
                html += `
                <div style="margin-top:5px; padding-top:5px; border-top:1px solid #444; display:flex; justify-content:space-between; font-weight:bold;">
                    <span>Total Employees:</span>
                    <span>${totalDisplay}</span>
                </div>`;
            }

            tooltip.style("opacity", 1).html(html);
        })
        .on("mousemove", (event) => {
            tooltip.style("left", (event.pageX + 15) + "px")
                .style("top", (event.pageY - 28) + "px");
        })
        .on("mouseout", () => tooltip.style("opacity", 0));
}

/**
 * Filtered Roster Chart logic
 */
function drawRosterChart() {
    const container = document.getElementById('rosterChartContainer');
    if (!container || !schedState.results) return;
    container.innerHTML = '';

    const selectedDay = document.getElementById('rosterDaySelect').value;
    const fullData = schedState.results.roster;

    // FILTER: Only show employees working on the selected day
    let filteredData = fullData;
    if (selectedDay !== "all") {
        const dayIdx = parseInt(selectedDay);
        filteredData = fullData.filter(emp => {
            const daySlice = emp.schedule.slice(dayIdx * 24, (dayIdx + 1) * 24);
            return daySlice.some(role => role !== null);
        });
    }

    const skillNames = ["Cashiers", "Stocking", "Customer Service", "BackRoom", "Floor Associate"];
    const color = d3.scaleOrdinal().domain(skillNames).range(d3.schemeCategory10);
    const dayAbbr = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    const cellWidth = 15;
    const cellHeight = 22;
    const hoursToShow = selectedDay === "all" ? 168 : 24;
    const width = (hoursToShow * cellWidth);
    const height = (filteredData.length * cellHeight);

    const svg = d3.select(container).append("svg")
        .attr("width", width + 100).attr("height", height + 50)
        .append("g").attr("transform", "translate(80,30)");

    // Render logic (Adjusted for Filtered View)
    filteredData.forEach((emp, eIdx) => {
        const y = eIdx * cellHeight;

        svg.append("text").attr("x", -10).attr("y", y + 15)
            .attr("text-anchor", "end").style("font-size", "11px").text(emp.id);

        const startIdx = selectedDay === "all" ? 0 : parseInt(selectedDay) * 24;
        for (let t = 0; t < hoursToShow; t++) {
            const role = emp.schedule[startIdx + t];
            if (role) {
                svg.append("rect")
                    .attr("x", t * cellWidth).attr("y", y + 2)
                    .attr("width", cellWidth - 1).attr("height", cellHeight - 4)
                    .attr("fill", color(role)).attr("rx", 2);
            }
        }
    });

    // Time Labels
    for (let t = 0; t < hoursToShow; t += (selectedDay === "all" ? 24 : 4)) {
        const label = selectedDay === "all" ? dayAbbr[t / 24] : `${t}:00`;
        svg.append("text").attr("x", t * cellWidth).attr("y", -10)
            .style("font-size", "10px").attr("fill", "#888").text(label);

        svg.append("line").attr("x1", t * cellWidth).attr("x2", t * cellWidth)
            .attr("y1", -5).attr("y2", height).attr("stroke", "#eee");
    }
}

// ============================================================================
// UI HELPER FUNCTIONS
// ============================================================================

/**
 * Attaches Event Listeners to UI elements (Tabs and Buttons)
 * Manages module switching, sub-tab navigation, and parameter changes.
 */
function setupEventListeners() {
    // 1. TOP-LEVEL NAVIGATION (Module Switching)
    // Manages switching between Inventory, Stocks, and Scheduling
    const topNav = document.getElementById('topNav');
    if (topNav) {
        topNav.addEventListener('click', (e) => {
            const btn = e.target.closest('.top-tab-btn');
            if (!btn || btn.classList.contains('active')) return;

            // Clear KPI and Status immediately
            resetGlobalKPI();
            updateStatus("Switching Module...", "waiting");

            // Toggle Visuals
            document.querySelectorAll('.top-tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.top-level-panel').forEach(p => p.classList.remove('active'));

            btn.classList.add('active');
            const module = btn.dataset.topTab;
            const targetPanel = document.getElementById(module + '-panel');
            if (targetPanel) targetPanel.classList.add('active');

            // Update Global UI Context (KPI Label)
            const kpiLabel = document.getElementById('kpiLabel');
            if (kpiLabel) {
                if (module === 'inventory') kpiLabel.textContent = "Total Profit";
                else if (module === 'stocks') kpiLabel.textContent = "Final Portfolio Value";
                else if (module === 'scheduling') kpiLabel.textContent = "Efficiency Score";
            }

            // Trigger Automatic Load and Solve
            loadModuleData(module);
        });
    }

    // 2. INVENTORY SUB-TAB NAVIGATION
    // Manages switching between "Production Schedule" and "Product Demands"
    const invTabs = document.getElementById('invTabs');
    if (invTabs) {
        invTabs.addEventListener('click', (e) => {
            const btn = e.target.closest('.tab-btn');
            if (!btn) return;

            invTabs.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const invContainer = document.getElementById('inventory-panel');
            invContainer.querySelectorAll('.vis-panel').forEach(p => p.classList.remove('active'));

            const targetId = btn.dataset.tab + '-panel';
            const targetPanel = document.getElementById(targetId);
            if (targetPanel) {
                targetPanel.classList.add('active');
                if (btn.dataset.tab === 'charts' && systemState.results) {
                    drawCharts();
                }
            }
        });
    }

    // 3. STOCK SUB-TAB NAVIGATION
    // Manages switching between "Performance" and "Price History"
    const stockTabs = document.getElementById('stockTabs');
    if (stockTabs) {
        stockTabs.addEventListener('click', (e) => {
            const btn = e.target.closest('.tab-btn');
            if (!btn) return;

            stockTabs.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const stockContainer = document.getElementById('stocks-panel');
            stockContainer.querySelectorAll('.vis-panel').forEach(p => p.classList.remove('active'));

            const targetId = btn.dataset.tab + '-panel';
            const targetPanel = document.getElementById(targetId);
            if (targetPanel) {
                targetPanel.classList.add('active');
                if (btn.dataset.tab === 'stockCharts' && stockState.results) {
                    drawStockCharts();
                }
            }
        });
    }

    // 4. SCHEDULING SUB-TAB NAVIGATION
    // Manages switching between Scheduling, Employees, and Demands
    const schedTabs = document.getElementById('schedTabs');
    if (schedTabs) {
        schedTabs.addEventListener('click', (e) => {
            const btn = e.target.closest('.tab-btn');
            if (!btn) return;

            schedTabs.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const schedContainer = document.getElementById('scheduling-panel');
            schedContainer.querySelectorAll('.vis-panel').forEach(p => p.classList.remove('active'));

            // The 'scheduling' tab uses a specific sub-panel ID to avoid conflict with the main panel
            const targetId = btn.dataset.tab === 'scheduling' ? 'scheduling-panel-sub' : btn.dataset.tab + '-panel';
            const targetPanel = document.getElementById(targetId);

            // Handle Sidebar Visibility for Employee List
            const empListContainer = document.getElementById('employee-list-container');
            if (empListContainer) {
                empListContainer.style.display = (btn.dataset.tab === 'employees') ? 'block' : 'none';
            }

            if (targetPanel) {
                targetPanel.classList.add('active');
                // Redraw charts if Demands tab is selected
                if (btn.dataset.tab === 'demands') {
                    drawSchedulingCharts();
                }
            }

            if (btn.dataset.tab === 'scheduling' && schedState.results) {
                drawRosterChart();
            }

            if (btn.dataset.tab === 'employees' && schedState.selectedEmpId) {
                const emp = schedState.employees.find(e => e.id === schedState.selectedEmpId);
                if (emp) setTimeout(() => renderIndividualGantt(emp, 50));
            }

            if (btn.dataset.tab === 'demands' && schedState.results) {
                drawSchedulingCharts();
            }
        });
    }

    // 5. INVENTORY PARAMETER LISTENERS
    ['rawSteelCost', 'invCost', 'maxCapacity', 'backorderPenalty'].forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener('change', (e) => {
                handleInputChange(id, e.target.value);
            });
        }
    });

    // 6. STOCK PARAMETER LISTENERS
    ['initialCash', 'buyFactor', 'sellFactor', 'dailyInterest', 'decayFactor', 'simulationMode', 'forecastNoise'].forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener('change', () => {
                requestStockSolve();
            });
        }
    });

    // 7. SCHEDULING PARAMETER LISTENERS
    // NEW: Automatically trigger updates when shift or worker counts change
    ['shiftLength', 'workerCount'].forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener('change', () => {
                requestSchedulingSolve();
            });
        }
    });

    // 8. GLOBAL ACTION LISTENERS (Import/Export/Add)
    if (els.universalExcelInput) {
        els.universalExcelInput.addEventListener('change', handleUniversalUpload);
    }

    if (els.addProductBtn) {
        els.addProductBtn.addEventListener('click', addProductRow);
    }

    if (els.exportBtn) {
        els.exportBtn.addEventListener('click', function (e) {
            e.preventDefault();
            handleExport();
        });
    }

    // Attach global functions to window for dynamic HTML elements (like table inputs or list items)
    window.updateProductData = updateProductData;
    window.updateDemandData = updateDemandData;
    window.updateOperationalTime = updateOperationalTime;
    window.selectEmployee = selectEmployee; // Required for clicking names in the Employee scroll list
}

function setupTopNavigation() {
    topNav = document.getElementById('topNav');
    if (!topNav) return;

    topNav.addEventListener('click', (e) => {
        const btn = e.target.closest('.top-tab-btn');
        if (!btn) return;

        // 1. Reset Buttons
        document.querySelectorAll('.top-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // 2. Reset Panels
        document.querySelectorAll('.top-level-panel').forEach(p => {
            p.classList.remove('active');
            p.style.display = 'none'; // Force hide
        });

        // 3. Activate Target
        const targetId = btn.dataset.topTab + "-panel";
        const targetPanel = document.getElementById(targetId);

        if (targetPanel) {
            targetPanel.classList.add('active');
            targetPanel.style.display = 'flex'; // Force Flex for side-by-side
        }

        // 4. Update Global UI Context
        if (btn.dataset.topTab === 'inventory') {
            document.getElementById('globalObjDisplay').previousElementSibling.textContent = "Total Profit";
        } else if (btn.dataset.topTab === 'stocks') {
            document.getElementById('globalObjDisplay').previousElementSibling.textContent = "Final Portfolio Value";
        }
    });
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
 * Creates or retrieves a D3 selection for a tooltip div.
 * Ensures the tooltip exists in the DOM and has the correct classes.
 */
function createTooltip(id) {
    let tooltip = d3.select("body").select("#" + id);
    if (tooltip.empty()) {
        tooltip = d3.select("body")
            .append("div")
            .attr("id", id)
            .attr("class", "d3-tooltip") // Uses the styles already in your style.css
            .style("opacity", 0)
            .style("position", "absolute")
            .style("pointer-events", "none");
    }
    return tooltip;
}

/**
 * Positions the tooltip relative to the mouse cursor.
 * Includes logic to prevent the tooltip from overflowing the screen.
 */
function positionTooltip(tooltip, event, offsetLeft = 15, offsetTop = -28) {
    const ttNode = tooltip.node();
    if (!ttNode) return;

    const ttWidth = ttNode.offsetWidth;
    const ttHeight = ttNode.offsetHeight;
    let x = event.pageX + offsetLeft;
    let y = event.pageY + offsetTop;

    // Boundary check: right side
    if (x + ttWidth > window.innerWidth) {
        x = event.pageX - ttWidth - offsetLeft;
    }
    // Boundary check: top side
    if (y < window.pageYOffset) {
        y = event.pageY + 20;
    }

    tooltip
        .style("left", x + "px")
        .style("top", y + "px");
}

/**
 * Global currency formatter for consistent UI.
 */
function formatCurrency(val) {
    return val.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0
    });
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
    if (!systemState.results) return;

    const val = systemState.results.objectiveValue;
    const display = document.getElementById('globalObjDisplay');
    const label = document.getElementById('kpiLabel');

    if (label) label.textContent = "Total Profit";
    if (display) {
        animateValue(display, val.toFixed(0), 200, (v) =>
            v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 })
        );
    }

    // Only draw charts if the inventory module and chart sub-tab are active
    const invActive = document.getElementById('inventory-panel').classList.contains('active');
    const chartTabActive = document.querySelector('[data-tab="charts"]').classList.contains('active');

    if (invActive && chartTabActive) {
        drawCharts();
    }
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