/**
 * --------------------------------------------------------------------
 * Production Scheduler - Main Script
 * --------------------------------------------------------------------
 */

// --- GLOBAL CONSTANTS & STATE ---

// Product Parameters
let systemState = {
    products: [
        { id: 0, name: "Nails", sell: 0, cost: 0, demand: [0, 0, 0, 0, 0, 0, 0] },
        { id: 1, name: "Screws", sell: 0, cost: 0, demand: [0, 0, 0, 0, 0, 0, 0] },
        { id: 2, name: "Pipe", sell: 0, cost: 0, demand: [0, 0, 0, 0, 0, 0, 0] },
        { id: 3, name: "Flashing", sell: 0, cost: 0, demand: [0, 0, 0, 0, 0, 0, 0] },
        { id: 4, name: "Rebar", sell: 0, cost: 0, demand: [0, 0, 0, 0, 0, 0, 0] },
        { id: 5, name: "Conduit", sell: 0, cost: 0, demand: [0, 0, 0, 0, 0, 0, 0] }
    ],
    results: null
};

// Operational Parameters
let liveState = {
    rawSteelCost: 2000,
    invCost: 20,
    maxCapacity: 500,
    backorderPenalty: 2
};

// DOM Elements
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
    chartPanel: document.getElementById('charts-panel')
};

let worker;
const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// --- INITIALIZION ---
document.addEventListener('DOMContentLoaded', main);

function main() {
    syncLiveStateToInputs();
    renderInputTable();
    initWorker();
    setupEventListeners();
    setupResizeObserver();
    setupTooltip();

    if (!document.getElementById('sharedLegend')) {
        const legendDiv = document.createElement('div');
        legendDiv.id = 'sharedLegend';
        if (els.chartPanel && els.chartPanel.children.length >= 2) {
            els.chartPanel.insertBefore(legendDiv, els.chartPanel.children[1]);
        }
    }
}

// --- STATE MANAGEMENT ---

function syncLiveStateToInputs() {
    Object.keys(liveState).forEach(key => {
        if (els[key]) els[key].value = liveState[key];
    });
}

function handleInputChange(key, value) {
    liveState[key] = parseFloat(value) || 0;
    els.statusIndicator.textContent = "Inputs Changed";
    els.statusIndicator.className = "status-badge ready";
}

function updateProductData(idx, field, val) {
    if (field === 'name') systemState.products[idx].name = val;
    else systemState.products[idx][field] = parseFloat(val);
}

function updateDemandData(pIdx, dIdx, val) {
    systemState.products[pIdx].demand[dIdx] = parseFloat(val);
}

// --- EXCEL FUNCTIONALITY ---

// Reading in Excel File to update Product Demands Table
async function handleExcelUpload() {
    const file = els.excelInput.files[0];
    if (!file) return;

    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    const newProducts = [];
    const numProducts = 6;

    for (let i = 0; i < numProducts; i++) {
        const rowIdx = 1 + i;
        const nameCell = sheet[XLSX.utils.encode_cell({ r: rowIdx, c: 0 })];
        const sellCell = sheet[XLSX.utils.encode_cell({ r: rowIdx, c: 1 })];
        const costCell = sheet[XLSX.utils.encode_cell({ r: rowIdx, c: 2 })];

        if (!nameCell) continue;

        const demandArr = [];
        const demandRowIdx = 10 + i;
        for (let j = 0; j < 7; j++) {
            const cell = sheet[XLSX.utils.encode_cell({ r: demandRowIdx, c: 1 + j })];
            demandArr.push(cell ? parseFloat(cell.v) : 0);
        }

        newProducts.push({
            id: i,
            name: nameCell.v,
            sell: parseFloat(sellCell.v),
            cost: parseFloat(costCell.v),
            demand: demandArr
        });
    }

    systemState.products = newProducts;
    renderInputTable();
    console.log("Production Demands Loaded Successfully");
}

// Product Demands Tab Rendering
function renderInputTable() {
    els.tableBody.innerHTML = '';
    systemState.products.forEach((p, idx) => {
        let row = `<tr>
            <td><input type="text" value="${p.name}" onchange="updateProductData(${idx}, 'name', this.value)"></td>
            <td><input type="number" value="${p.sell}" onchange="updateProductData(${idx}, 'sell', this.value)"></td>
            <td><input type="number" value="${p.cost}" onchange="updateProductData(${idx}, 'cost', this.value)"></td>`;

        p.demand.forEach((d, dayIdx) => {
            row += `<td><input type="number" value="${d}" onchange="updateDemandData(${idx}, ${dayIdx}, this.value)"></td>`;
        });
        row += `</tr>`;
        els.tableBody.innerHTML += row;
    });
}

// Exporting Schedule to Excel
function handleExport() {
    if (!systemState.results) return alert("Run optimization first.");
    const wb = XLSX.utils.book_new();
    const wsData = [["Optimized Schedule"], ["Total Profit", systemState.results.objectiveValue], []];

    systemState.results.details.forEach(p => {
        wsData.push([p.product]);
        wsData.push(["Metric", ...days]);
        wsData.push(["Produced", ...p.produced]);
        wsData.push(["Sold", ...p.sold]);
        wsData.push(["Ending Inv", ...p.inventory]);
        wsData.push(["Backorder", ...p.backorder]);
        wsData.push([]);
    });

    const ws = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(wb, ws, "Solution");
    XLSX.writeFile(wb, "OptimizationResults.xlsx");
}

// --- LP WORKER TRIGGERS ---

// LP Worker Function Initialization
function initWorker() {
    worker = new Worker('worker.js');
    worker.onmessage = function (e) {
        const { type, status, result, error } = e.data;
        if (type === 'result' && status === 'Optimal') {
            systemState.results = result;
            updateResultsUI();
        } else if (type === 'error') {
            els.statusIndicator.textContent = "Error";
            els.statusIndicator.className = "status-badge error";
            console.error(error);
        }
    };
}

// LP Optimization Caller
function runOptimization() {
    els.statusIndicator.textContent = "Solving...";
    els.statusIndicator.className = "status-badge solving";
    const payload = { products: systemState.products, ...liveState };
    worker.postMessage({ type: 'solve', data: payload });
}

// --- UI HELPER FUNCTIONS ---

// Detect Container Size Changes to Trigger Redraws
function setupResizeObserver() {
    const observer = new ResizeObserver(() => {
        if (systemState.results) window.requestAnimationFrame(drawCharts);
    });
    document.querySelectorAll('.chart-wrapper').forEach(el => observer.observe(el));
}

// UI Update for Optimal Solutions
function updateResultsUI() {
    const data = systemState.results;
    animateValue(els.objValueDisplay, data.objectiveValue, 200,
        val => val.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }));

    els.statusIndicator.textContent = "Optimal Solution Found";
    els.statusIndicator.className = "status-badge optimal";

    drawCharts();
}

// Animated Text for Changing UI Text (Profit Scorecard)
function animateValue(element, end, duration, formatter) {
    let start = 0;
    const startTime = performance.now();
    function step(now) {
        const progress = Math.min((now - startTime) / duration, 1);
        const val = start + (end - start) * (1 - Math.pow(1 - progress, 3));
        element.textContent = formatter(val);
        if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

// Tooltip Helper Functions
function setupTooltip() {
    if (document.getElementById('d3-tooltip')) return;
    const t = document.createElement('div');
    t.id = 'd3-tooltip';
    t.className = 'd3-tooltip';
    document.body.appendChild(t);
}
function showTooltip(html, event) {
    const t = document.getElementById('d3-tooltip');
    t.innerHTML = html;
    t.style.opacity = 1;
    t.style.left = (event.pageX + 15) + 'px';
    t.style.top = (event.pageY - 15) + 'px';
}
function hideTooltip() {
    document.getElementById('d3-tooltip').style.opacity = 0;
}

// Drawing Main SVG Elements
function drawCharts() {
    if (!systemState.results) return;
    drawSharedLegend();
    drawProductionChart();
    drawInventoryChart();
}

// --- D3 CHART DRAWING ---

// Drawing Product Legend
function drawSharedLegend() {
    const container = document.getElementById('sharedLegend');
    if (!container) return;
    container.innerHTML = '';

    // Setting Products and their Corresponding Colors
    const products = systemState.results.details.map(d => d.product);
    const color = d3.scaleOrdinal().domain(products).range(d3.schemeCategory10);

    // Setting Container Spacing
    const svg = d3.select(container).append("svg")
        .attr("width", "100%").attr("height", "100%");
    const legendGroup = svg.append("g").attr("transform", "translate(0, 10)");
    const itemWidth = 100;
    const totalWidth = products.length * itemWidth;
    const startX = Math.max(0, (container.clientWidth - totalWidth) / 2);

    // Drawing Legend Items and Text
    const items = legendGroup.selectAll("g")
        .data(products).enter().append("g")
        .attr("transform", (d, i) => `translate(${startX + i * itemWidth}, 0)`);
    items.append("rect")
        .attr("width", 15).attr("height", 15)
        .attr("fill", d => color(d));
    items.append("text")
        .attr("x", 20).attr("y", 12)
        .text(d => d)
        .style("font-size", "0.75rem");
}

function drawProductionChart() {

    // Setting Physical Container Space Constraints
    const container = document.getElementById('productionChartContainer');
    container.innerHTML = '';
    const rect = container.getBoundingClientRect();
    const margin = { top: 10, right: 30, bottom: 30, left: 50 };
    const width = rect.width - margin.left - margin.right;
    const height = rect.height - margin.top - margin.bottom;

    if (width <= 0 || height <= 0) return;
    const svg = d3.select(container).append("svg")
        .attr("width", "100%").attr("height", "100%")
        .attr("viewBox", `0 0 ${rect.width} ${rect.height}`)
        .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // Setting Stacked Production Quantities by Day
    const data = systemState.results;
    const stackData = days.map((day, i) => {
        const obj = { day: day };
        data.details.forEach(p => { obj[p.product] = p.produced[i]; });
        return obj;
    });
    const subgroups = data.details.map(d => d.product);
    const groups = days;
    
    // Setting Bar, Axis, and Color Scales
    const x = d3.scaleBand().domain(groups).range([0, width]).padding([0.2]);
    const y = d3.scaleLinear().domain([0, liveState.maxCapacity * 1.1]).range([height, 0]);
    const color = d3.scaleOrdinal().domain(subgroups).range(d3.schemeCategory10);

    svg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x));
    svg.append("g").call(d3.axisLeft(y));

    // Drawing Stacked Bar Chart
    const stackedData = d3.stack().keys(subgroups)(stackData);
    svg.append("g")
        .selectAll("g").data(stackedData).enter().append("g")
        .attr("fill", d => color(d.key))
        .selectAll("rect").data(d => d).enter().append("rect")
        .attr("x", d => x(d.data.day))
        .attr("y", d => y(d[1]))
        .attr("height", d => y(d[0]) - y(d[1]))
        .attr("width", x.bandwidth())
        
        // Setting Tooltip Functionality
        .on("mouseover", function (event, d) {
            const product = d3.select(this.parentNode).datum().key;
            const amount = d[1] - d[0];
            showTooltip(`<strong class="tooltip-header">${product}</strong>Produced: ${amount} tons`, event);
            d3.select(this).style("opacity", 0.8);
        })
        .on("mousemove", (event) => showTooltip(document.getElementById('d3-tooltip').innerHTML, event))
        .on("mouseout", function () { hideTooltip(); d3.select(this).style("opacity", 1); });
    
    // Drawing the Max Capacity Level
    svg.append("line")
        .attr("x1", 0).attr("x2", width)
        .attr("y1", y(liveState.maxCapacity)).attr("y2", y(liveState.maxCapacity))
        .attr("class", "capacity-line");
}

function drawInventoryChart() {

    // Setting Physical Container Space Constraints
    const container = document.getElementById('inventoryChartContainer');
    container.innerHTML = '';
    const rect = container.getBoundingClientRect();
    const margin = { top: 10, right: 30, bottom: 30, left: 50 };
    const width = rect.width - margin.left - margin.right;
    const height = rect.height - margin.top - margin.bottom;
    
    if (width <= 0 || height <= 0) return;
    const svg = d3.select(container).append("svg")
        .attr("width", "100%").attr("height", "100%")
        .attr("viewBox", `0 0 ${rect.width} ${rect.height}`)
        .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // Setting Day of the Week X-Axis Scale
    const x = d3.scalePoint().domain(days).range([0, width]);

    let maxVal = 100;
    let minVal = 0;

    // Create "Net Inventory" Arrays for Plotting
    const netInventoryData = systemState.results.details.map(p => {
        return {
            product: p.product,
            values: p.inventory.map((inv, i) => {
                const back = p.backorder[i];
                const net = inv - back; // Positive if Stock, Negative if Backorder

                maxVal = Math.max(maxVal, net);
                minVal = Math.min(minVal, net);
                return net;
            }),
            rawInv: p.inventory,
            rawBack: p.backorder
        };
    });

    // Set Y Axis value range
    const y = d3.scaleLinear()
        .domain([minVal * 1.1, maxVal * 1.1])
        .range([height, 0])
        .nice();

    // Set Color Scheme for Product Categories
    const color = d3.scaleOrdinal()
        .domain(systemState.results.details.map(d => d.product))
        .range(d3.schemeCategory10);

    // X Axis
    svg.append("g")
        .attr("transform", `translate(0,${height})`)
        .call(d3.axisBottom(x));

    // Y Axis
    svg.append("g").call(d3.axisLeft(y));

    // Zero Line (Where Inventory meets Backorder)
    svg.append("line")
        .attr("x1", 0).attr("x2", width)
        .attr("y1", y(0)).attr("y2", y(0))
        .attr("stroke", "#666")
        .attr("stroke-width", 1)
        .style("opacity", 0.5);

    const line = d3.line()
        .x((d, i) => x(days[i]))
        .y(d => y(d));

    // Draw Lines by Product
    netInventoryData.forEach(p => {
        svg.append("path")
            .datum(p.values)
            .attr("class", "chart-line")
            .attr("stroke", color(p.product))
            .attr("d", line);

        // Generating Line Chart Data Point Dots
        svg.selectAll(`.dot-${p.product.replace(/\s/g, '')}`)
            .data(p.values).enter().append("circle")
            .attr("cx", (d, i) => x(days[i]))
            .attr("cy", d => y(d))
            .attr("r", 5)
            .attr("fill", color(p.product))
            .attr("stroke", "white")
            .attr("stroke-width", 1)
            
            // Setting Mouse Behaviors
            .on("mouseover", (event, d, i) => {
                
                // Find index via X coordinate mapping
                const dayIndex = days.findIndex((day, idx) => Math.abs(x(day) - parseFloat(d3.select(event.target).attr('cx'))) < 1);

                // Generating Tooltip Text for Index
                const backorder = p.rawBack[dayIndex];
                const tooltipHtml = `
                    <div style="text-align:left;">
                        <strong class="tooltip-header">${p.product} (${days[dayIndex]})</strong>
                        Start Inv: ${dayIndex === 0 ? 0 : p.rawInv[dayIndex - 1]}<br>
                        End Inv: ${p.rawInv[dayIndex]}<br>
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

// --- EVENT SETUP ---
function setupEventListeners() {
    
    // Adding Event Listeners to Buttons
    Object.keys(els).forEach(key => {
        if (key === 'excelInput') els[key].addEventListener('change', handleExcelUpload);
        else if (els[key] && els[key].tagName === 'INPUT') {
            els[key].addEventListener('change', (e) => handleInputChange(key, e.target.value));
        }
    });
    document.getElementById('runSolverBtn').addEventListener('click', runOptimization);
    document.getElementById('exportBtn').addEventListener('click', handleExport);

    // Tab Switching Behaviors
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

    window.updateProductData = updateProductData;
    window.updateDemandData = updateDemandData;
}