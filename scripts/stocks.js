/**
 * scripts/stocks.js
 * Stock Trading Module - Logic for portfolio optimization and D3 visualizations.
 */

window.StocksModule = {
    /**
     * Initializes module event listeners for trading parameters.
     */
    init() {
        const params = ['initialCash', 'dailyInterest', 'marginalSlippage', 'decayFactor', 'minTrade'];
        params.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', () => this.requestSolve());
            }
        });
    },

    /**
     * Triggers the stock worker to find the optimal trading path.
     */
    requestSolve() {
        if (!window.stockState.prices || window.stockState.prices.length === 0) return;
        updateStatus("Solving Optimal Path...", "solving");

        const params = {
            prices: window.stockState.prices,
            initialCash: parseFloat(document.getElementById('initialCash').value) || 10000000,
            dailyInterest: (parseFloat(document.getElementById('dailyInterest').value) || 0) / 100,
            marginalChangeParam: (parseFloat(document.getElementById('marginalSlippage').value) || 0) / 100,
            decayFactor: parseFloat(document.getElementById('decayFactor').value) || 0,
            minTrade: parseFloat(document.getElementById('minTrade').value) || 1000
        };

        if (window.currentWorker) window.currentWorker.terminate();
        window.currentWorker = new Worker('scripts/stocksWorker.js');

        window.currentWorker.onmessage = (e) => {
            if (e.data.type === 'result' && e.data.status === 'Optimal') {
                window.stockState.results = e.data.result;
                updateResultsUI();
                updateStatus("Optimal Path Found", "optimal");
            } else {
                updateStatus("Infeasible Logic", "error");
            }
        };
        window.currentWorker.postMessage({ type: 'solve', data: params });
    },

    /**
     * Parses workbook data into prices and identifies stock symbols.
     */
    processWorkbook(workbook) {
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(sheet);
        if (json.length > 0) {
            window.stockState.prices = json;
            window.stockState.stocks = Object.keys(json[0]).filter(k => k !== 'Month' && k !== 'Day');
            this.renderTable();
            this.requestSolve();
        }
    },

    exportResults() {
        if (!window.stockState.results) {
            alert("No stock results found. Please ensure the market analysis has finished.");
            return;
        }

        const logs = window.stockState.results.dailyLogs;
        const stockNames = window.stockState.stocks;
        const wb = XLSX.utils.book_new();

        /**
         * Helper function restored from original code to map indices 
         * to "Month Day" strings using the stockState.prices source.
         */
        const getFormattedDate = (dayIdx) => {
            const row = window.stockState.prices[dayIdx];
            if (!row) return `Day ${dayIdx}`;
            const monthNames = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
            const month = monthNames[parseInt(row.Month)] || row.Month;
            return `${month} ${row.Day}`;
        };

        // --- TAB 1: DAILY ACTIVITY LEDGER ---
        const ledgerHeader = ["Date", "Cash Reserves", ...stockNames.map(s => `${s} Change`)];
        const ledgerData = logs.map((d, i) => {
            const row = [getFormattedDate(i), d.cashHeld];
            stockNames.forEach(s => {
                // Calculates net trade (Buys - Sells) for each stock
                const change = (d.buys[s] || 0) - (d.sells[s] || 0);
                row.push(change);
            });
            return row;
        });
        const wsLedger = XLSX.utils.aoa_to_sheet([ledgerHeader, ...ledgerData]);
        XLSX.utils.book_append_sheet(wb, wsLedger, "Daily Activity");

        // --- TAB 2: CUMULATIVE HOLDINGS ---
        const accumulationHeader = ["Date", "Total Portfolio Value", "Cash Position", ...stockNames];
        const accumulationData = logs.map((d, i) => {
            const row = [getFormattedDate(i), d.totalValue, d.cashHeld];
            stockNames.forEach(s => row.push(d.stockValues[s] || 0));
            return row;
        });
        const wsAccumulation = XLSX.utils.aoa_to_sheet([accumulationHeader, ...accumulationData]);
        XLSX.utils.book_append_sheet(wb, wsAccumulation, "Cumulative Holdings");

        // --- SAVE FILE ---
        const dateTag = new Date().toISOString().slice(0, 10);
        XLSX.writeFile(wb, `Portfolio_Analysis_${dateTag}.xlsx`);
    },

    /**
     * Renders the scrollable Price History table.
     */
    renderTable() {
        const head = document.getElementById('stockTableHead');
        const body = document.getElementById('stockTableBody');
        if (!head || !body) return;

        head.innerHTML = `<tr><th>Month</th><th>Day</th>${window.stockState.stocks.map(s => `<th>${s}</th>`).join('')}</tr>`;
        body.innerHTML = window.stockState.prices.slice(0, 365).map(row => `
            <tr>
                <td>${row.Month || ''}</td>
                <td>${row.Day || ''}</td>
                ${window.stockState.stocks.map(s => `<td>$${(parseFloat(row[s]) || 0).toFixed(2)}</td>`).join('')}
            </tr>`).join('');
    },

    /**
     * D3 Orchestration
     */
    drawCharts() {
        if (!window.stockState.results) return;
        this.drawActivityChart();
        this.drawCompositionChart();
        this.drawLegend();
    },

    drawActivityChart() {
        const container = document.getElementById('portfolioChartContainer');
        if (!container || !stockState.results) return;

        const rect = container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        container.innerHTML = '';
        const margin = { top: 20, right: 30, bottom: 40, left: 70 };
        const width = rect.width - margin.left - margin.right;
        const height = rect.height - margin.top - margin.bottom;

        // Safety check for calculated dimensions
        if (width <= 0 || height <= 0) return;

        const svg = d3.select(container).append("svg")
            .attr("width", rect.width).attr("height", rect.height)
            .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

        const data = window.stockState.results.dailyLogs;
        const N = data.length;
        const color = d3.scaleOrdinal().domain(window.stockState.stocks).range(d3.schemeCategory10);

        const stackData = data.map(d => {
            const row = { dayIdx: d.dayIdx };
            window.stockState.stocks.forEach(s => row[s] = (d.buys[s] || 0) - (d.sells[s] || 0));
            return row;
        });

        const stackedSeries = d3.stack().keys(window.stockState.stocks).offset(d3.stackOffsetDiverging)(stackData);
        const y = d3.scaleLinear().domain([
            d3.min(stackedSeries, s => d3.min(s, d => d[0])) * 1.1,
            d3.max(stackedSeries, s => d3.max(s, d => d[1])) * 1.1
        ]).range([height, 0]);

        svg.append("line").attr("x1", 0).attr("x2", width).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", "#666").style("opacity", 0.8);

        const layers = svg.selectAll(".layer").data(stackedSeries).enter().append("g").attr("fill", d => color(d.key));
        const bars = layers.selectAll("rect").data(d => d).enter().append("rect")
            .attr("stroke", "#fff").attr("stroke-width", "1px")
            .attr("y", d => y(d[1])).attr("height", d => Math.abs(y(d[0]) - y(d[1])));

        const updateGeometry = (hoverIndex, mx) => {
            const positions = new Float32Array(N + 1);
            if (hoverIndex === null) {
                for (let i = 0; i <= N; i++) positions[i] = (i / N) * width;
            } else {
                const strength = 6.0, radius = 30, weights = new Float32Array(N);
                for (let i = 0; i < N; i++) weights[i] = 1 + strength * Math.exp(-(Math.pow(i - hoverIndex, 2)) / (2 * radius * radius));
                let lT = 0; for (let i = 0; i < hoverIndex; i++) lT += weights[i]; lT += weights[hoverIndex] * 0.5;
                let rT = weights[hoverIndex] * 0.5; for (let i = hoverIndex + 1; i < N; i++) rT += weights[i];
                const sL = mx / lT, sR = (width - mx) / rT;
                positions[0] = 0;
                for (let i = 0; i < N; i++) {
                    if (i < hoverIndex) positions[i + 1] = positions[i] + weights[i] * sL;
                    else if (i > hoverIndex) positions[i + 1] = positions[i] + weights[i] * sR;
                    else positions[i + 1] = mx + (weights[i] * 0.5 * sR);
                }
            }
            bars.attr("x", (d, i) => positions[i]).attr("width", (d, i) => Math.max(0, positions[i + 1] - positions[i] - 0.2));
        };

        svg.append("rect").attr("width", width).attr("height", height).attr("fill", "transparent")
            .on("mousemove", (event) => {
                const [mx] = d3.pointer(event);
                const idx = Math.max(0, Math.min(N - 1, Math.round((mx / width) * (N - 1))));
                updateGeometry(idx, mx);
                this.showActivityTooltip(data[idx], idx > 0 ? data[idx - 1] : null, event, color);
            })
            .on("mouseleave", () => { updateGeometry(null); hideTooltip(); });

        svg.append("g").call(d3.axisLeft(y).tickFormat(d3.format("$.2s")));
        updateGeometry(null, 0);
    },

    drawCompositionChart() {
        const container = document.getElementById('allocationChartContainer');
        if (!container || !stockState.results) return;

        const rect = container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        container.innerHTML = '';
        const margin = { top: 20, right: 30, bottom: 40, left: 70 };
        const width = rect.width - margin.left - margin.right;
        const height = rect.height - margin.top - margin.bottom;

        if (width <= 0 || height <= 0) return;

        const svg = d3.select(container).append("svg")
            .attr("width", rect.width).attr("height", rect.height)
            .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

        const data = window.stockState.results.dailyLogs;
        const keys = [...window.stockState.stocks, "Cash"];
        const color = d3.scaleOrdinal().domain(keys).range([...d3.schemeCategory10, "#95a5a6"]);

        const stackData = data.map(d => {
            const row = { Cash: d.cashHeld };
            Object.entries(d.stockValues).forEach(([s, v]) => row[s] = v);
            return row;
        });

        const stackedSeries = d3.stack().keys(keys)(stackData);
        const y = d3.scaleLinear().domain([0, d3.max(data, d => d.totalValue) * 1.05]).range([height, 0]);

        const layers = svg.selectAll(".layer").data(stackedSeries).enter().append("g")
            .attr("fill", d => color(d.key)).attr("fill-opacity", d => d.key === "Cash" ? 0.3 : 1);

        const areas = layers.selectAll("rect").data(d => d).enter().append("rect")
            .attr("stroke", "rgba(255,255,255,0.3)").attr("stroke-width", "1px").attr("y", d => y(d[1])).attr("height", d => Math.abs(y(d[0]) - y(d[1])));

        const updateGeometry = (hoverIndex, mx) => {
            const positions = new Float32Array(data.length + 1);
            if (hoverIndex === null) {
                for (let i = 0; i <= data.length; i++) positions[i] = (i / data.length) * width;
            } else {
                const strength = 6.0, radius = 30, weights = new Float32Array(data.length);
                for (let i = 0; i < data.length; i++) weights[i] = 1 + strength * Math.exp(-(Math.pow(i - hoverIndex, 2)) / (2 * radius * radius));
                let lT = 0; for (let i = 0; i < hoverIndex; i++) lT += weights[i]; lT += weights[hoverIndex] * 0.5;
                let rT = weights[hoverIndex] * 0.5; for (let i = hoverIndex + 1; i < data.length; i++) rT += weights[i];
                const sL = mx / lT, sR = (width - mx) / rT;
                positions[0] = 0;
                for (let i = 0; i < data.length; i++) {
                    if (i < hoverIndex) positions[i + 1] = positions[i] + weights[i] * sL;
                    else if (i > hoverIndex) positions[i + 1] = positions[i] + weights[i] * sR;
                    else positions[i + 1] = mx + (weights[i] * 0.5 * sR);
                }
            }
            areas.attr("x", (d, i) => positions[i]).attr("width", (d, i) => Math.max(0, positions[i + 1] - positions[i]));
        };

        svg.append("rect").attr("width", width).attr("height", height).attr("fill", "transparent")
            .on("mousemove", (event) => {
                const [mx] = d3.pointer(event);
                const idx = Math.max(0, Math.min(data.length - 1, Math.round((mx / width) * (data.length - 1))));
                updateGeometry(idx, mx);
                this.showCompositionTooltip(data[idx], event, color);
            })
            .on("mouseleave", () => { updateGeometry(null); hideTooltip(); });

        svg.append("g").call(d3.axisLeft(y).tickFormat(d3.format("$.2s")));
        updateGeometry(null, 0);
    },

    showActivityTooltip(d, prevD, event, colorScale) {
        const dateRow = window.stockState.prices[d.dayIdx];
        const dateStr = `${monthNames[parseInt(dateRow.Month)]} ${dateRow.Day}`;
        const growth = prevD ? ((d.totalValue - prevD.totalValue) / prevD.totalValue) * 100 : 0;

        let buyHtml = '', sellHtml = '';
        window.stockState.stocks.forEach(name => {
            const sharesBought = d.buys[name] || 0, sharesSold = d.sells[name] || 0;
            const price = parseFloat(dateRow[name]) || 0, c = colorScale(name);
            if (sharesBought > 0) buyHtml += `<div class="tooltip-metric"><span><i style="display:inline-block;width:8px;height:8px;background:${c};margin-right:5px;border-radius:1px;"></i>${name}: </span><span>${formatCurrency(sharesBought * price)} (${sharesBought.toFixed(1)} shares)</span></div>`;
            if (sharesSold > 0) sellHtml += `<div class="tooltip-metric"><span><i style="display:inline-block;width:8px;height:8px;background:${c};margin-right:5px;border-radius:1px;"></i>${name}: </span><span>${formatCurrency(sharesSold * price)} (${sharesSold.toFixed(1)} shares)</span></div>`;
        });

        showTooltip(`
            <div style="font-weight:bold; border-bottom:1px solid #555; margin-bottom:5px;">${dateStr}</div>
            <div class="tooltip-row"><span>Cash Held:</span> <span>${formatCurrency(d.cashHeld)}</span></div>
            <div class="tooltip-row"><span>Daily Change:</span> <span style="color:${growth >= 0 ? '#2ecc71' : '#e74c3c'}">${growth.toFixed(2)}%</span></div>
            ${buyHtml ? `<div class="tooltip-block buy-block"><strong>Total Bought</strong>${buyHtml}</div>` : ''}
            ${sellHtml ? `<div class="tooltip-block sell-block"><strong>Total Sold</strong>${sellHtml}</div>` : ''}
        `, event);
    },

    showCompositionTooltip(d, event, colorScale) {
        const dateRow = window.stockState.prices[d.dayIdx];
        const dateStr = `${monthNames[parseInt(dateRow.Month)]} ${dateRow.Day}`;
        let holdingsHtml = `<div class="tooltip-row"><span><i style="display:inline-block;width:8px;height:8px;background:${colorScale('Cash')};margin-right:5px;border-radius:1px;"></i>Cash: </span><span>${formatCurrency(d.cashHeld)}</span></div>`;

        Object.entries(d.stockValues).sort((a, b) => b[1] - a[1]).forEach(([name, val]) => {
            if (val > 1) holdingsHtml += `<div class="tooltip-row"><span><i style="display:inline-block;width:8px;height:8px;background:${colorScale(name)};margin-right:5px;border-radius:1px;"></i>${name}: </span><span>${formatCurrency(val)}</span></div>`;
        });

        showTooltip(`
            <div style="font-weight:bold; border-bottom:1px solid #555; margin-bottom:5px;">Portfolio State</div>
            <strong>${dateStr}</strong>
            <div class="tooltip-row"><span>Total Worth:</span> <strong>${formatCurrency(d.totalValue)}</strong></div>
            <hr style="margin:5px 0; border-top:1px solid #444"><div style="font-size:0.75rem;"><strong>Allocation:</strong>${holdingsHtml}</div>
        `, event);
    },

    drawLegend() {
        const container = document.getElementById('sharedStockLegend');
        if (!container) return;
        container.innerHTML = '';
        const items = [...window.stockState.stocks, "Cash"];
        const color = d3.scaleOrdinal().domain(items).range([...d3.schemeCategory10, "#95a5a6"]);
        container.style.display = 'flex'; container.style.justifyContent = 'center'; container.style.flexWrap = 'wrap';

        items.forEach(item => {
            const div = document.createElement('div');
            div.style.display = 'inline-flex'; div.style.alignItems = 'center'; div.style.margin = '5px 15px';
            div.innerHTML = `<div style="width:12px;height:12px;background:${color(item)};margin-right:8px;border-radius:2px;${item === 'Cash' ? 'opacity:0.5;' : ''}"></div><span style="font-size:0.8rem;color:#555;font-weight:500;">${item}</span>`;
            container.appendChild(div);
        });
    }
};