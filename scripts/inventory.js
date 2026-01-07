/**
 * scripts/inventory.js
 * Inventory Module - Logic for production optimization visualizations and parsing.
 */

window.InventoryModule = {
    /**
     * Binds UI inputs and ensures handlers update the orchestrator's liveState.
     */
    init() {
        ['rawSteelCost', 'invCost', 'maxCapacity', 'backorderPenalty'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.value = window.liveState[id];
                el.addEventListener('change', (e) => {
                    window.liveState[id] = parseFloat(e.target.value) || 0;
                    this.requestSolve();
                });
            }
        });

        document.getElementById('addProductBtn')?.addEventListener('click', () => this.addProductRow());

        // Expose handlers to global scope for HTML 'onchange' compatibility
        window.updateProductData = (idx, field, val) => this.updateProductData(idx, field, val);
        window.updateDemandData = (pIdx, dIdx, val) => this.updateDemandData(pIdx, dIdx, val);
        window.updateOperationalTime = (dIdx, val) => this.updateOperationalTime(dIdx, val);
    },

    requestSolve() {
        if (this.solveTimer) clearTimeout(this.solveTimer);
        updateStatus("Changes Pending...", "waiting");
        this.solveTimer = setTimeout(() => this.executeSolve(), 150);
    },

    executeSolve(attempt = 1, adjustedParams = null) {
        const currentParams = adjustedParams || {
            products: JSON.parse(JSON.stringify(window.systemState.products)),
            operationalTime: [...window.systemState.operationalTime],
            ...window.liveState
        };

        // Heuristic check
        const floors = this.calculateTheoreticalFloor(currentParams);
        const avgOpTime = currentParams.operationalTime.reduce((a, b) => a + (parseFloat(b) || 0), 0) / 7;

        if (currentParams.maxCapacity < floors.floorCap || avgOpTime < floors.floorTime) {
            updateStatus("Impossible Logic", "error");
            return;
        }

        if (window.currentWorker) window.currentWorker.terminate();
        if (attempt === 1) updateStatus("Solving...", "solving");

        window.currentWorker = new Worker('scripts/inventoryWorker.js');
        window.currentWorker.onmessage = (e) => {
            const { type, status, result, slackUsed } = e.data;
            const isOptimal = (status === 'Optimal' && (!slackUsed || slackUsed < 0.01));

            if (type === 'result' && isOptimal) {
                window.systemState.results = result;
                this.updateUI();
                updateStatus("Optimal Solution", "optimal");
            } else if (attempt === 1) {
                const tightenedParams = { ...currentParams, maxCapacity: (currentParams.maxCapacity + floors.floorCap) / 2 };
                this.executeSolve(2, tightenedParams);
            } else {
                updateStatus("Infeasible", "error");
            }
        };
        window.currentWorker.postMessage({ type: 'solve', data: currentParams });
    },

    calculateTheoreticalFloor(params) {
        let totalDemand = 0, totalProcTime = 0;
        params.products.forEach(p => {
            const d = p.demand.reduce((a, b) => a + (parseFloat(b) || 0), 0);
            totalDemand += d;
            totalProcTime += d * (parseFloat(p.cycleTime) || 0);
            if (d > 0) {
                const minSetups = Math.max(1, Math.ceil(d / params.maxCapacity));
                totalProcTime += (minSetups * (parseFloat(p.changeOverTime) || 0) * 60);
            }
        });
        return { floorCap: totalDemand / 7, floorTime: totalProcTime / (7 * 3600) };
    },

    processWorkbook(workbook) {
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

        const cleanStr = (val) => String(val || "").trim();
        const cleanNum = (val) => parseFloat(val) || 0;

        let prodIdx = -1, opIdx = -1, demIdx = -1;
        for (let i = 0; i < rows.length; i++) {
            const firstCell = cleanStr(rows[i][0]).toLowerCase();
            if (firstCell === "products") prodIdx = i;
            else if (firstCell === "operational hours") opIdx = i;
            else if (firstCell === "demand in days") demIdx = i;
        }

        let newProducts = [];
        if (prodIdx !== -1) {
            for (let i = prodIdx + 1; i < rows.length; i++) {
                if (!cleanStr(rows[i][0])) break;
                newProducts.push({
                    id: newProducts.length, name: cleanStr(rows[i][0]),
                    sell: cleanNum(rows[i][1]), cost: cleanNum(rows[i][2]),
                    changeOverCost: cleanNum(rows[i][3]), changeOverTime: cleanNum(rows[i][4]),
                    cycleTime: cleanNum(rows[i][5]), demand: [0, 0, 0, 0, 0, 0, 0]
                });
            }
        }

        if (opIdx !== -1) {
            for (let j = 0; j < 7; j++) window.systemState.operationalTime[j] = cleanNum(rows[opIdx][j + 1]);
        }

        if (demIdx !== -1) {
            for (let i = demIdx + 1; i < rows.length; i++) {
                const name = cleanStr(rows[i][0]);
                if (!name) break;
                const p = newProducts.find(prod => prod.name.toLowerCase() === name.toLowerCase());
                if (p) for (let j = 0; j < 7; j++) p.demand[j] = cleanNum(rows[i][j + 1]);
            }
        }

        if (newProducts.length > 0) {
            window.systemState.products = newProducts;
            this.renderTable();
            this.requestSolve();
        }
    },

    exportResults() {
        if (!window.systemState.results) {
            alert("No production results found. Please ensure the solver has finished.");
            return;
        }

        const wb = XLSX.utils.book_new();
        const res = window.systemState.results;

        // Exact mapping from your original code: details -> produced, sold, inventory, backorder
        const wsData = [
            ["Optimized Production Schedule"],
            ["Total Profit", res.objectiveValue],
            []
        ];

        res.details.forEach(p => {
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
    },

    renderTable() {
        const body = document.getElementById('tableBody');
        if (!body) return;
        body.innerHTML = '';

        let opRow = `<tr style="background-color: #f0f4f8; font-weight: bold;">
            <td colspan="6" style="text-align: right; padding-right: 15px;">Total Operational Time (Hours):</td>`;
        window.systemState.operationalTime.forEach((t, i) => {
            opRow += `<td><input type="number" style="width: 100%; font-weight: bold; color: #333;" value="${t}" onchange="updateOperationalTime(${i}, this.value)"></td>`;
        });
        body.innerHTML = opRow + `</tr>`;

        window.systemState.products.forEach((p, idx) => {
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
            body.innerHTML += row + `</tr>`;
        });
    },

    updateProductData(idx, field, val) {
        if (field === 'name') window.systemState.products[idx].name = val;
        else window.systemState.products[idx][field] = parseFloat(val) || 0;
        this.requestSolve();
    },
    updateDemandData(pIdx, dIdx, val) { window.systemState.products[pIdx].demand[dIdx] = parseFloat(val) || 0; this.requestSolve(); },
    updateOperationalTime(dIdx, val) { window.systemState.operationalTime[dIdx] = parseFloat(val) || 0; this.requestSolve(); },

    addProductRow() {
        const newId = window.systemState.products.length;
        window.systemState.products.push({
            id: newId, name: `New Product ${newId + 1}`,
            sell: 0, cost: 0, changeOverCost: 0, changeOverTime: 0, cycleTime: 0,
            demand: [0, 0, 0, 0, 0, 0, 0]
        });
        this.renderTable();
        this.requestSolve();
    },

    updateUI() {
        if (!window.systemState.results) return;
        const display = document.getElementById('globalObjDisplay');
        if (display) {
            animateValue(display, window.systemState.results.objectiveValue, 200, (v) =>
                v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }));
        }
        this.drawCharts();
    },

    drawCharts() {
        this.drawSharedLegend();
        this.drawProductionChart();
        this.drawInventoryChart();
    },

    drawSharedLegend() {
        const container = document.getElementById('sharedLegend');
        if (!container || !window.systemState.results) return;
        container.innerHTML = '';
        const products = window.systemState.results.details.map(d => d.product);
        const color = d3.scaleOrdinal().domain(products).range(d3.schemeCategory10);

        products.forEach(product => {
            const item = document.createElement('div');
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.innerHTML = `
                <div style="width:12px; height:12px; background-color:${color(product)}; margin-right:6px; border-radius:2px;"></div>
                <span style="font-size:0.85rem; color:#333; font-weight:500;">${product}</span>`;
            container.appendChild(item);
        });
    },

    drawProductionChart() {
        const container = document.getElementById('productionChartContainer');
        if (!container || !window.systemState.results) return;
        container.innerHTML = '';

        const rect = container.getBoundingClientRect();
        const margin = { top: 10, right: 30, bottom: 30, left: 50 };
        const width = rect.width - margin.left - margin.right;
        const height = rect.height - margin.top - margin.bottom;

        const svg = d3.select(container).append("svg")
            .attr("width", "100%").attr("height", "100%")
            .attr("viewBox", `0 0 ${rect.width} ${rect.height}`)
            .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

        const stackData = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day, i) => {
            const obj = { day };
            window.systemState.results.details.forEach(p => { obj[p.product] = p.produced[i]; });
            return obj;
        });

        const subgroups = window.systemState.results.details.map(d => d.product);
        const color = d3.scaleOrdinal().domain(subgroups).range(d3.schemeCategory10);
        const x = d3.scaleBand().domain(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]).range([0, width]).padding(0.2);
        const y = d3.scaleLinear().domain([0, window.liveState.maxCapacity * 1.1]).range([height, 0]);

        svg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x));
        svg.append("g").call(d3.axisLeft(y));

        svg.append("g").selectAll("g").data(d3.stack().keys(subgroups)(stackData)).enter().append("g")
            .attr("fill", d => color(d.key))
            .selectAll("rect").data(d => d).enter().append("rect")
            .attr("x", d => x(d.data.day)).attr("y", d => y(d[1]))
            .attr("height", d => Math.max(0, y(d[0]) - y(d[1]))).attr("width", x.bandwidth())
            .on("mouseover", function (event, d) {
                const product = d3.select(this.parentNode).datum().key;
                const c = color(product);
                showTooltip(`
                    <div style="text-align:left;">
                        <strong style="border-bottom: 1px solid #555; margin-bottom: 5px; display: block;">
                            <i style="display:inline-block;width:8px;height:8px;background:${c};margin-right:5px;border-radius:1px;"></i>${product}
                        </strong>
                        Produced: ${(d[1] - d[0]).toFixed(0)} tons
                    </div>`, event);
            })
            .on("mouseout", () => hideTooltip());

        svg.append("line").attr("x1", 0).attr("x2", width).attr("y1", y(window.liveState.maxCapacity)).attr("y2", y(window.liveState.maxCapacity)).attr("class", "capacity-line");
    },

    drawInventoryChart() {
        const container = document.getElementById('inventoryChartContainer');
        if (!container || !window.systemState.results) return;
        container.innerHTML = '';

        const rect = container.getBoundingClientRect();
        const margin = { top: 10, right: 30, bottom: 30, left: 50 };
        const width = rect.width - margin.left - margin.right;
        const height = rect.height - margin.top - margin.bottom;

        const svg = d3.select(container).append("svg")
            .attr("width", "100%").attr("height", "100%")
            .attr("viewBox", `0 0 ${rect.width} ${rect.height}`)
            .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

        const daysArr = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
        const x = d3.scalePoint().domain(daysArr).range([0, width]);

        let maxVal = 100, minVal = 0;
        const netData = window.systemState.results.details.map(p => ({
            product: p.product,
            values: p.inventory.map((inv, i) => {
                const net = inv - p.backorder[i];
                maxVal = Math.max(maxVal, net); minVal = Math.min(minVal, net);
                return net;
            }),
            rawInv: p.inventory, rawBack: p.backorder
        }));

        const y = d3.scaleLinear().domain([minVal * 1.1, maxVal * 1.1]).range([height, 0]).nice();
        const color = d3.scaleOrdinal().domain(netData.map(d => d.product)).range(d3.schemeCategory10);

        svg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x));
        svg.append("g").call(d3.axisLeft(y));
        svg.append("line").attr("x1", 0).attr("x2", width).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", "#666").style("opacity", 0.8);

        const line = d3.line().x((d, i) => x(daysArr[i])).y(d => y(d));
        netData.forEach(p => {
            const c = color(p.product);
            svg.append("path").datum(p.values).attr("class", "chart-line").attr("stroke", c).attr("d", line);
            svg.selectAll(`.dot-${p.product.replace(/\s/g, '')}`).data(p.values).enter().append("circle")
                .attr("cx", (d, i) => x(daysArr[i])).attr("cy", d => y(d)).attr("r", 5)
                .attr("fill", c).attr("stroke", "white")
                .on("mouseover", (event, d) => {
                    const idx = daysArr.findIndex(day => Math.abs(x(day) - parseFloat(d3.select(event.target).attr('cx'))) < 1);
                    showTooltip(`
                        <div style="text-align:left;">
                            <strong style="border-bottom: 1px solid #555; margin-bottom: 5px; display: block;">
                                <i style="display:inline-block;width:8px;height:8px;background:${c};margin-right:5px;border-radius:1px;"></i>${p.product} (${daysArr[idx]})
                            </strong>
                            Inventory: ${p.rawInv[idx]} tons<br>
                            Backorder: <span class="${p.rawBack[idx] > 0 ? 'tooltip-value-bad' : ''}">${p.rawBack[idx]} tons</span>
                        </div>`, event);
                })
                .on("mouseout", () => hideTooltip());
        });
    }
};

window.InventoryModule = InventoryModule;