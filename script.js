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
 * Live operational Parameters bound to UI inputs to the DOM.
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
    stockTabs: document.getElementById('stockTabs')
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
        filePath = 'data/SampleData.xlsx';
    } else if (moduleType === 'stocks') {
        filePath = 'data/Stocks.xlsx';
    } else {
        updateStatus("Module Pending", "ready");
        return;
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
        buyFactor: parseFloat(document.getElementById('buyFactor').value) || 1.002,
        sellFactor: parseFloat(document.getElementById('sellFactor').value) || 0.998,
        dailyInterest: parseFloat(document.getElementById('dailyInterest').value) || 0,
        decayFactor: parseFloat(document.getElementById('decayFactor').value) || 0,
        marginalChangeParam: 0.002 // λ (Lambda)
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
            processStockWorkbook(workbook); // Stock Tab
            break;
        case 'scheduling':
            console.log("Scheduling parser not yet implemented.");
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
    // We slice to the first 100 rows to maintain performance for large datasets
    if (els.stockTableBody) {
        els.stockTableBody.innerHTML = '';

        const displayRows = stockState.prices.slice(0, 100);

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
        if (stockState.prices.length > 100) {
            els.stockTableBody.innerHTML += `
                <tr>
                    <td colspan="${stockState.stocks.length + 2}" style="text-align:center; color:#888; font-style:italic;">
                        Showing first 100 entries. Entire dataset (${stockState.prices.length} days) used for optimization.
                    </td>
                </tr>`;
        }
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

    let buyHtml = '', sellHtml = '';
    stockState.stocks.forEach(name => {
        const bVal = d.buys[name] || 0;
        const sVal = d.sells[name] || 0;
        const c = colorScale(name); // Now guaranteed to work

        if (bVal > 0.1) buyHtml += `
            <div class="tooltip-metric">
                <span><i style="display:inline-block;width:8px;height:8px;background:${c};margin-right:5px;border-radius:1px;"></i>${name}:</span>
                <span>${formatCurrency(bVal)}</span>
            </div>`;
        if (sVal > 0.1) sellHtml += `
            <div class="tooltip-metric">
                <span><i style="display:inline-block;width:8px;height:8px;background:${c};margin-right:5px;border-radius:1px;"></i>${name}:</span>
                <span>${formatCurrency(sVal)}</span>
            </div>`;
    });

    tooltip.style("opacity", 1)
        .html(`
            <div style="font-weight:bold; border-bottom:1px solid #555; margin-bottom:5px;">${dateStr}</div>
            <div class="tooltip-row"><span>Cash Held:</span> <span>${formatCurrency(d.cashHeld)}</span></div>
            <div class="tooltip-row"><span>Daily Change:</span> <span style="color:${growth >= 0 ? '#2ecc71' : '#e74c3c'}">${growth.toFixed(2)}%</span></div>
            ${buyHtml ? `<div class="tooltip-block buy-block"><strong>Bought</strong>${buyHtml}</div>` : ''}
            ${sellHtml ? `<div class="tooltip-block sell-block"><strong>Sold</strong>${sellHtml}</div>` : ''}
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

// ============================================================================
// UI HELPER FUNCTIONS
// ============================================================================

/**
 * Attaches Event Listeners to UI elements (Tabs and Buttons)
 */
function setupEventListeners() {
    // 1. TOP-LEVEL NAVIGATION (Module Switching)
    topNav = document.getElementById('topNav');
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

            // Trigger Automatic Load and Solve
            loadModuleData(module);
        });
    }

    // 2. TOP-LEVEL NAVIGATION (Module Switching)
    // Manages switching between Inventory, Stocks, and Scheduling
    topNav = document.getElementById('topNav');
    if (topNav) {
        topNav.addEventListener('click', (e) => {
            const btn = e.target.closest('.top-tab-btn');
            if (!btn) return;

            // Toggle top buttons
            document.querySelectorAll('.top-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Toggle top panels
            document.querySelectorAll('.top-level-panel').forEach(p => p.classList.remove('active'));
            const targetPanel = document.getElementById(btn.dataset.topTab + '-panel');

            if (targetPanel) {
                targetPanel.classList.add('active');

                // Redraw visuals for the newly visible module if results exist
                const module = btn.dataset.topTab;
                if (module === 'inventory' && systemState.results) {
                    updateResultsUI(); // Redraws Inventory Charts
                } else if (module === 'stocks' && stockState.results) {
                    updateStockResultsUI(); // Redraws Stock Charts
                }
            }
        });
    }

    // 3. INVENTORY SUB-TAB NAVIGATION
    // Manages switching between "Production Schedule" and "Product Demands"
    const invTabs = document.getElementById('invTabs');
    if (invTabs) {
        invTabs.addEventListener('click', (e) => {
            const btn = e.target.closest('.tab-btn');
            if (!btn) return;

            // Only remove 'active' from buttons inside the Inventory module
            invTabs.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Only remove 'active' from panels inside the Inventory module
            const invContainer = document.getElementById('inventory-panel');
            invContainer.querySelectorAll('.vis-panel').forEach(p => p.classList.remove('active'));

            const targetId = btn.dataset.tab + '-panel';
            const targetPanel = document.getElementById(targetId);
            if (targetPanel) {
                targetPanel.classList.add('active');
                // If user clicks the chart tab, force D3 to re-calculate dimensions
                if (btn.dataset.tab === 'charts' && systemState.results) {
                    drawCharts();
                }
            }
        });
    }

    // 4. STOCK SUB-TAB NAVIGATION
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

    // 5. INVENTORY PARAMETER LISTENERS
    // Automatically trigger solve when global parameters change
    ['rawSteelCost', 'invCost', 'maxCapacity', 'backorderPenalty'].forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener('change', (e) => {
                handleInputChange(id, e.target.value);
            });
        }
    });

    // 6. STOCK PARAMETER LISTENERS
    // Automatically trigger stock solve when trading parameters change
    ['initialCash', 'buyFactor', 'sellFactor', 'dailyInterest', 'decayFactor', 'simulationMode', 'forecastNoise'].forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener('change', () => {
                requestStockSolve();
            });
        }
    });

    if (els.addProductBtn) {
        els.addProductBtn.addEventListener('click', addProductRow);
    }

    if (els.exportBtn) {
        els.exportBtn.addEventListener('click', function (e) {
            e.preventDefault();
            handleExport();
        });
    } else {
        const directBtn = document.getElementById('exportBtn');
        if (directBtn) {
            directBtn.onclick = handleExport;
        } else {
            console.error("Export Button with ID 'exportBtn' not found in DOM");
        }
    }

    // Attach global update functions to window for HTML onchange attributes
    window.updateProductData = updateProductData;
    window.updateDemandData = updateDemandData;
    window.updateOperationalTime = updateOperationalTime;
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