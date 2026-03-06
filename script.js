/**
 * script.js - Main script for the Operations Research application.
 * @author: Joel Wood
 */

// --- GLOBAL STATE ---
window.systemState = { operationalTime: [0, 0, 0, 0, 0, 0, 0], products: [], results: null };
window.liveState = { rawSteelCost: 2000, invCost: 20, maxCapacity: 500, backorderPenalty: 2 };
window.stockState = { prices: [], stocks: [], results: null };
window.schedState = { employees: [], demands: [], selectedEmpId: null, results: null, solverTimeLeft: 0 };
window.currentWorker = null;
window.days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
window.monthNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];

// --- MODULE REGISTRY ---
const moduleRegistry = {
    inventory: {
        label: "Total Profit",
        getResult: () => window.systemState.results?.objectiveValue,
        draw: () => window.InventoryModule.drawCharts()
    },
    stocks: {
        label: "Final Portfolio Value",
        getResult: () => window.stockState.results?.finalPortfolioValue,
        draw: () => window.StocksModule.drawCharts()
    },
    scheduling: {
        label: "Labor Cost",
        getResult: () => window.schedState.results?.actualLaborCost || window.schedState.results?.objective,
        draw: () => window.ScheduleModule.drawCharts()
    },
    ordering: {
        label: "Weekly Profit",
        getResult: () => window.orderState.results?.optimalPolicy.totalProfit,
        draw: () => window.OrdersModule.drawCharts()
    }
};

// --- INITIALIZATION ---
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
    if (window.OrdersModule) window.OrdersModule.init();

    setupGlobalNavigation();
    setupTooltip();

    const activeTab = document.querySelector('.top-tab-btn.active');
    if (activeTab) loadModuleData(activeTab.dataset.topTab);
});

/**This function is used to update the global status indicator.
 * The global status indicator is the element with id "statusIndicator"
 * It displays a text message indicating the current state of the application.
 * The text message is passed as the first argument to the function.
 * The text message is displayed in the element and the element's class is updated
 * to reflect the current state of the application.
 * The second argument is an optional argument that can be used to set the class 
 * of the element to reflect the state of the application. 
 * This argument is passed in as a string that represents the class name.
 */
function updateStatus(text, className) {
    // Get the global status indicator element
    const indicator = document.getElementById('statusIndicator');
    // If the element exists
    if (indicator) {
        // Update the text content of the element to the passed in text message
        indicator.textContent = text;
        // Update the class of the element to the passed in class name or waiting
        indicator.className = "status-badge " + (className || "waiting");
    }
}

/**This function is used to reset the global KPI display and the global status indicator
 * to their initial state.
 * The global KPI display (the element with id "globalObjDisplay") is cleared of its
 * previous value and set to "$ ---".
 * The global status indicator (the element with id "statusIndicator") is cleared of its
 * previous text and set to the text "Calculating...". Its class is also set to "status-
 * badge waiting" to signal that the calculation is still in progress.
 */
function resetGlobalKPI() {
    const display = document.getElementById('globalObjDisplay');
    const indicator = document.getElementById('statusIndicator');
    if (display) display.textContent = "$ ---";
    if (indicator) {
        indicator.textContent = "Calculating...";
        indicator.className = "status-badge waiting";
    }
}

/**
 * Animate a value from its current value to a target value over a given duration.
 * The animation uses a "cubic" easing function for a more natural look.
 * @param {HTMLElement|Text} element The element whose text content will be updated with the animated value.
 * @param {number|string} end The target value to animate to. If a string is provided, it will be formatted using the
 *     provided formatter before the animation starts.
 * @param {number} duration The duration of the animation in milliseconds.
 */
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

/**Updates the UI of the results based on the currently active tab in the global navigation.
 * This function first determines the active tab and then updates the appropriate labels,
 * value displays, and charts for that tab.
 */
function updateResultsUI() {
    const activeTab = document.querySelector('.top-tab-btn.active')?.dataset.topTab;
    const config = moduleRegistry[activeTab];
    const display = document.getElementById('globalObjDisplay');
    const label = document.getElementById('kpiLabel');

    if (config && config.getResult()) {
        if (label) label.textContent = config.label;
        animateValue(display, config.getResult(), 400, formatCurrency);
        config.draw();
    }
}

/**Formats a number into a string with a currency symbol using the specified options.
 * @param {number|string} val The number to format.
 * @returns {string} The formatted number with currency symbol.
 */
function formatCurrency(val) {
    // Use the toLocaleString method to format the number as a currency string of just Dollars
    return val.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

/**The function checks if there is a tooltip element in the document and creates one if necessary.
 * The tooltip element is a div with the id 'd3-tooltip' and the class 'd3-tooltip'.
 * This tooltip will be used to display information when the user hovers over certain elements in the charts.
 */
function setupTooltip() {
    // Check if there is an element with the id 'd3-tooltip' in the document, and create if not
    if (!document.getElementById('d3-tooltip')) {
        const t = document.createElement('div');
        // Set the id and class of the new div to 'd3-tooltip' and 'd3-tooltip' respectively
        t.id = 'd3-tooltip';
        t.className = 'd3-tooltip';
        document.body.appendChild(t); // Append the new div to the body of the document
    }
}

/**Shows the tooltip with the provided HTML content at the specified event location.
 * @param {string} html The HTML content to display in the tooltip.
 * @param {MouseEvent} event The event that triggered the tooltip display, used to calculate the tooltip's
 *                           position.
 */
function showTooltip(html, event) {
    const t = document.getElementById('d3-tooltip'); // Get the tooltip element from the document
    if (!t) return;
    t.innerHTML = html; // Set the tooltip's innerHTML to the specified HTML content
    t.style.opacity = 0.9; // Set the tooltip's opacity to 0.9, making it visible

    // Calculate the tooltip's position based on the event's page coordinates
    let x = event.pageX + 15; // Position the tooltip 15px to the right of the event
    let y = event.pageY - 15; // Position the tooltip 15px above the event
    // If the tooltip would be outside the window, adjust its position
    if (x + 280 > window.innerWidth) // If the tooltip would be to far to the right
        x = event.pageX - 300; // Move the tooltip 300px to the left
    t.style.left = x + 'px'; // Set the tooltip's horizontal position
    t.style.top = y + 'px'; // Set the tooltip's vertical position
}

// Function to hide the tooltip by setting its opacity to 0
function hideTooltip() {
    const t = document.getElementById('d3-tooltip'); // Get the tooltip element from the document
    if (!t) return;
    t.style.opacity = 0; // Set the tooltip invisible
}

/**Setup the global navigation components of the application.
 * These components are the top navigation bar and the sub-navigation bars.
 * The top navigation bar has one button for each module: Inventory, Stocks, and Scheduling.
 * Each sub-navigation bar has one button for each sub-module of its module.
 * When a button is clicked, the corresponding module data is loaded and the component's state is updated.
 * When a sub-module button is clicked, the corresponding sub-module data is loaded and the component's state is updated.
 * When the export button is clicked, the corresponding module data is exported to Excel.
 */
function setupGlobalNavigation() {
    /**Event listener for the top navigation bar.
     * @param {MouseEvent} e The click event that triggered the function.
     */
    document.getElementById('topNav')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.top-tab-btn');
        if (!btn || btn.classList.contains('active')) return;
        if (window.ScheduleModule && window.ScheduleModule.abortActiveOptimization) {
            window.ScheduleModule.abortActiveOptimization();
        }
        resetGlobalKPI(); // Reset global KPI label

        // Remove 'active' class from all buttons and panels
        document.querySelectorAll('.top-tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.top-level-panel').forEach(p => p.classList.remove('active'));

        // Add 'active' class to the clicked button and panel
        btn.classList.add('active');
        document.getElementById(btn.dataset.topTab + '-panel')?.classList.add('active');
        const module = btn.dataset.topTab;
        const label = document.getElementById('kpiLabel');
        if (label) {
            if (module === 'inventory') label.textContent = "Total Profit";
            else if (module === 'stocks') label.textContent = "Portfolio Value";
            else if (module === 'scheduling') label.textContent = "Labor Cost";
            else if (module === 'ordering') label.textContent = "Weekly Profit";
        }

        loadModuleData(module); // Load module data
    });

    /**Event listener for the sub-navigation bars.
     * @param {MouseEvent} e The click event that triggered the function.
     */
    ['invTabs', 'stockTabs', 'schedTabs'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', (e) => {
            const btn = e.target.closest('.tab-btn');
            if (!btn) return;

            // Remove 'active' class from all buttons in the bar
            document.querySelectorAll(`#${id} .tab-btn`).forEach(b => b.classList.remove('active'));

            // Add 'active' class to the clicked button and panel
            btn.classList.add('active');

            const panelPrefix = id === 'stockTabs' ? 'stocks' : id === 'invTabs' ? 'inventory' : 'scheduling';
            document.querySelectorAll(`#${panelPrefix}-panel .vis-panel`).forEach(p => p.classList.remove('active'));

            // Load sub-module data and draw corresponding charts
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

    /**Global Chart Utility
     * Used for getting container dimenstions and initializing the SVG within each tab
     */
    window.initChart = function (containerId, marginOverride = {}, useViewBox = true) {
        const container = document.getElementById(containerId);
        if (!container) return null;
        container.innerHTML = '';

        const rect = container.getBoundingClientRect();
        const margin = { top: 10, right: 30, bottom: 30, left: 50, ...marginOverride };
        const width = rect.width - margin.left - margin.right;
        const height = rect.height - margin.top - margin.bottom;
        if (width <= 0 || height <= 0) return null;

        container.innerHTML = '';
        container.innerHTML = '';
        const svgEl = d3.select(container).append("svg")
            .style("display", "block") // Fixes orientation/text-align issues
            .attr("width", rect.width)
            .attr("height", rect.height);

        // For charts that grow vertically, we skip the height-constrained viewBox
        if (useViewBox) {
            svgEl.attr("viewBox", `0 0 ${rect.width} ${rect.height}`);
        }

        const svg = svgEl.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

        return { svg, width, height, margin };
    };

    /**Event listener for the import file button.
     * @param {MouseEvent} e The click event that triggered the function.
     */
    document.getElementById('universalExcelInput')?.addEventListener('change', (e) => {
        const activeTab = document.querySelector('.top-tab-btn.active')?.dataset.topTab;
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            const workbook = XLSX.read(evt.target.result);
            if (activeTab === 'inventory') window.InventoryModule.processWorkbook(workbook);
            else if (activeTab === 'stocks') window.StocksModule.processWorkbook(workbook);
            else if (activeTab === 'scheduling') window.ScheduleModule.processWorkbook(workbook);
            else if (activeTab === 'ordering') window.OrdersModule.processWorkbook(workbook);
        };
        reader.readAsArrayBuffer(file);
    });

    /**Event listener for the export button.
     * @param {MouseEvent} e The click event that triggered the function.
     */
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
        } else if (activeTab === 'ordering') {
            if (window.OrdersModule && window.OrdersModule.exportResults) {
                window.OrdersModule.exportResults();
            }
        } else {
            console.warn("No active module found for export.");
        }
    });
}

/**Load module data from a file and process it.
 * @param {string} moduleType The type of module to load data for.
 * @returns {Promise<void>} A promise that resolves when the data is loaded and processed.
 */
async function loadModuleData(moduleType) {
    if (moduleType === 'ordering') {
        if(window.OrdersModule) {
            if (!window.orderState.results) {
                window.OrdersModule.requestSolve();
            } else {
                window.OrdersModule.updateUI();
            }
        }
        return;
    }
    
    // Map of module types to file paths.
    const fileMap = { 'inventory': 'data/Inventory.xlsx', 'stocks': 'data/Stocks.xlsx', 'scheduling': 'data/Scheduling.xlsx' };
    const filePath = fileMap[moduleType]; // Get the file path for the requested module type.
    if (!filePath) return;
    try {
        updateStatus(`Loading ${moduleType} data...`, "solving"); // Show Loading Message
        const response = await fetch(filePath); // Fetch the file contents.
        const buffer = await response.arrayBuffer(); // Read the file into an array buffer.
        const workbook = XLSX.read(buffer); // Read the array buffer into a workbook.
        // Process Workbooks different depending on the module.
        if (moduleType === 'inventory') window.InventoryModule.processWorkbook(workbook);
        else if (moduleType === 'stocks') window.StocksModule.processWorkbook(workbook);
        else if (moduleType === 'scheduling') window.ScheduleModule.processWorkbook(workbook);
    } catch (err) {
        // If an error occurs, update the status message to indicate the load failed.
        updateStatus("Load Error", "error");
    }
}

/**
 * Draw charts when the window is resized.
 */
window.addEventListener('resize', () => {
    const activeTab = document.querySelector('.top-tab-btn.active')?.dataset.topTab;
    if (activeTab === 'inventory') window.InventoryModule.drawCharts();
    else if (activeTab === 'stocks') window.StocksModule.drawCharts();
    else if (activeTab === 'scheduling') window.ScheduleModule.drawCharts();
    else if (activeTab === 'ordering') window.OrdersModule.drawCharts();
});