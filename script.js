/**
 * script.js - Main Orchestrator (Baseline Fixed)
 */

// --- 1. GLOBAL STATE ---
window.systemState = { operationalTime: [0, 0, 0, 0, 0, 0, 0], products: [], results: null };
window.liveState = { rawSteelCost: 2000, invCost: 20, maxCapacity: 500, backorderPenalty: 2 };
window.stockState = { prices: [], stocks: [], results: null };
window.schedState = { employees: [], demands: [], selectedEmpId: null, results: null, solverTimeLeft: 0 };
window.currentWorker = null;
const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const monthNames = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// --- 2. INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    const chartPanel = document.getElementById('charts-panel');
    if (chartPanel && !document.getElementById('sharedLegend')) {
        const legendDiv = document.createElement('div');
        legendDiv.id = 'sharedLegend';
        if (chartPanel.children.length >= 2) chartPanel.insertBefore(legendDiv, chartPanel.children[1]);
    }

    if (window.InventoryModule) window.InventoryModule.init();
    if (window.StocksModule) window.StocksModule.init();
    if (window.ScheduleModule) window.ScheduleModule.init();

    setupGlobalNavigation();
    setupTooltip();

    const activeTab = document.querySelector('.top-tab-btn.active');
    if (activeTab) loadModuleData(activeTab.dataset.topTab);
});

// --- 3. SHARED UI UTILITIES ---
function updateStatus(text, className) {
    const indicator = document.getElementById('statusIndicator');
    if (indicator) {
        indicator.textContent = text;
        indicator.className = "status-badge " + className;
    }
}
function resetGlobalKPI() {
    const display = document.getElementById('globalObjDisplay');
    const indicator = document.getElementById('statusIndicator');
    if (display) display.textContent = "$ ---";
    if (indicator) {
        indicator.textContent = "Calculating...";
        indicator.className = "status-badge waiting";
    }
}

function animateValue(element, end, duration, formatter) {
    let start = parseFloat(element.textContent.replace(/[^0-9.-]+/g, "")) || 0;
    const startTime = performance.now();
    function step(now) {
        const progress = Math.min((now - startTime) / duration, 1);
        const val = start + (end - start) * (1 - Math.pow(1 - progress, 3));
        element.textContent = formatter(val);
        if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

function updateResultsUI() {
    const activeTab = document.querySelector('.top-tab-btn.active')?.dataset.topTab;
    const display = document.getElementById('globalObjDisplay');
    const label = document.getElementById('kpiLabel');

    if (activeTab === 'inventory' && window.systemState.results) {
        if (label) label.textContent = "Total Profit";
        animateValue(display, window.systemState.results.objectiveValue, 200, (v) =>
            v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));
        window.InventoryModule.drawCharts();
    } else if (activeTab === 'stocks' && window.stockState.results) {
        if (label) label.textContent = "Final Portfolio Value";
        animateValue(display, Math.round(window.stockState.results.finalPortfolioValue), 400, (v) =>
            Math.round(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));
        window.StocksModule.drawCharts();
    } else if (activeTab === 'scheduling' && window.schedState.results) {
        if (label) label.textContent = "Labor Cost";
        // Convert solver score to labor cost (removing penalty weights if necessary)
        const cost = window.schedState.results.actualLaborCost || window.schedState.results.objective;
        animateValue(display, cost, 400, (v) =>
            v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));

        // FIXED: Call the master drawCharts instead of just the roster
        window.ScheduleModule.drawCharts();
    }
}

function formatCurrency(val) {
    return val.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

// --- 4. TOOLTIP LOGIC ---
function setupTooltip() {
    if (!document.getElementById('d3-tooltip')) {
        const t = document.createElement('div');
        t.id = 'd3-tooltip';
        t.className = 'd3-tooltip';
        document.body.appendChild(t);
    }
}
function showTooltip(html, event) {
    const t = document.getElementById('d3-tooltip');
    if (!t) return;
    t.innerHTML = html;
    t.style.opacity = 0.9;
    let x = event.pageX + 15, y = event.pageY - 15;
    if (x + 280 > window.innerWidth) x = event.pageX - 300;
    t.style.left = x + 'px'; t.style.top = y + 'px';
}
function hideTooltip() {
    const t = document.getElementById('d3-tooltip');
    if (t) t.style.opacity = 0;
}

// --- 5. NAVIGATION ---
function setupGlobalNavigation() {
    document.getElementById('topNav')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.top-tab-btn');
        if (!btn || btn.classList.contains('active')) return;
        resetGlobalKPI();

        document.querySelectorAll('.top-tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.top-level-panel').forEach(p => p.classList.remove('active'));

        btn.classList.add('active');
        document.getElementById(btn.dataset.topTab + '-panel')?.classList.add('active');
        const module = btn.dataset.topTab;
        const label = document.getElementById('kpiLabel');
        if (label) {
            if (module === 'inventory') label.textContent = "Total Profit";
            else if (module === 'stocks') label.textContent = "Portfolio Value";
            else if (module === 'scheduling') label.textContent = "Labor Cost";
        }
        loadModuleData(module);
    });

    ['invTabs', 'stockTabs', 'schedTabs'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', (e) => {
            const btn = e.target.closest('.tab-btn');
            if (!btn) return;
            document.querySelectorAll(`#${id} .tab-btn`).forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const panelPrefix = id === 'stockTabs' ? 'stocks' : id === 'invTabs' ? 'inventory' : 'scheduling';
            document.querySelectorAll(`#${panelPrefix}-panel .vis-panel`).forEach(p => p.classList.remove('active'));

            const targetId = (panelPrefix === 'scheduling' && btn.dataset.tab === 'scheduling') ? 'scheduling-panel-sub' : btn.dataset.tab + '-panel';
            const target = document.getElementById(targetId);
            if (target) {
                target.classList.add('active');
                if (panelPrefix === 'inventory') window.InventoryModule.drawCharts();
                if (panelPrefix === 'stocks') window.StocksModule.drawCharts();
                if (panelPrefix === 'scheduling') window.ScheduleModule.drawCharts();
            }
        });
    });

    document.getElementById('universalExcelInput')?.addEventListener('change', (e) => {
        const activeTab = document.querySelector('.top-tab-btn.active')?.dataset.topTab;
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            const workbook = XLSX.read(evt.target.result, { type: 'binary' });
            if (activeTab === 'inventory') window.InventoryModule.processWorkbook(workbook);
            else if (activeTab === 'stocks') window.StocksModule.processWorkbook(workbook);
            else if (activeTab === 'scheduling') window.ScheduleModule.processWorkbook(workbook);
        };
        reader.readAsBinaryString(file);
    });

    document.getElementById('exportBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        const activeTab = document.querySelector('.top-tab-btn.active')?.dataset.topTab;

        if (activeTab === 'inventory') {
            if (window.InventoryModule && window.InventoryModule.exportResults) {
                window.InventoryModule.exportResults();
            }
        } else if (activeTab === 'stocks') {
            if (window.StocksModule && window.StocksModule.exportResults) {
                window.StocksModule.exportResults();
            }
        } else if (activeTab === 'scheduling') {
            if (window.ScheduleModule && window.ScheduleModule.exportResults) {
                window.ScheduleModule.exportResults();
            }
        } else {
            console.warn("No active module found for export.");
        }
    });
}

async function loadModuleData(moduleType) {
    const fileMap = { 'inventory': 'data/Inventory.xlsx', 'stocks': 'data/Stocks.xlsx', 'scheduling': 'data/Scheduling.xlsx' };
    const filePath = fileMap[moduleType];
    if (!filePath) return;
    try {
        updateStatus(`Loading ${moduleType} data...`, "solving");
        const response = await fetch(filePath);
        const buffer = await response.arrayBuffer();
        const workbook = XLSX.read(buffer);
        if (moduleType === 'inventory') window.InventoryModule.processWorkbook(workbook);
        else if (moduleType === 'stocks') window.StocksModule.processWorkbook(workbook);
        else if (moduleType === 'scheduling') window.ScheduleModule.processWorkbook(workbook);
    } catch (err) { updateStatus("Load Error", "error"); }
}

window.addEventListener('resize', () => {
    const activeTab = document.querySelector('.top-tab-btn.active')?.dataset.topTab;
    if (activeTab === 'inventory') window.InventoryModule.drawCharts();
    else if (activeTab === 'stocks') window.StocksModule.drawCharts();
    else if (activeTab === 'scheduling') window.ScheduleModule.drawCharts();
});