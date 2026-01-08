/**==============================================================================
 * Stock Trading Module - Portfolio Optimizer
 * ==============================================================================
 * Description:
 * Implements a multi-period financial control model for portfolio optimization.
 * Orchestrates the relationship between historical price data and a MILP
 * (Mixed-Integer Linear Program) solver to find the optimal sequence of
 * stock trades. Features D3.js "fisheye" visualizations for inspecting 
 * high-density daily trade activity and asset allocation over a year.
 * @author Joel Wood
 */

window.StocksModule = {
    /**This function initializes the Stock Trading Module by binding
     * input change events to the HiGHs WASM LP Solver.
     * Uses a set of parameters that control the trading behavior, each
     * associated with an HTML input element which the user can change.
     */
    init() {
        const params = ['initialCash', 'dailyInterest', 'marginalSlippage', 'decayFactor', 'minTrade'];
        params.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                /**Binds a change event to the input element, which triggers requestSolve; 
                 * to re-runs the solver with these new parameters.
                 */
                el.addEventListener('change', () => this.requestSolve());
            }
        });
    },

    /**
     * This function is the entry point for the solver to find the optimal trading path.
     * The function collects the current state and parameters in a solve request object: 
     */
    requestSolve() {
        if (!window.stockState.prices || window.stockState.prices.length === 0) return;
        updateStatus("Solving Optimal Path...", "solving");
    
        /**prices - historical price data from the price table. 
         * initialCash - initial cash available for investment. 
         * dailyInterest - return rate which free-cash will have when not traded. 
         * marginalChangeParam - marginal penalty for each additional share traded. 
         * decayFactor - market ripple effect of marginal slippage over time. 
         * minTrade - minimum economical trade size. (to be trimmed)
         */ 
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

        // When the worker returns a message, check if it's an optimal solution.
        window.currentWorker.onmessage = (e) => {
            if (e.data.type === 'result' && e.data.status === 'Optimal') {
                // Set the results to the global state 'stockState.results'
                window.stockState.results = e.data.result;
                // Update the user interface with the new data
                updateResultsUI();
                // Update the status to indicate a successful solve
                updateStatus("Optimal Path Found", "optimal");
            } else {
                // If the solution is not optimal, update the status to indicate failure
                updateStatus("Infeasible Logic", "error");
            }
        };
        window.currentWorker.postMessage({ type: 'solve', data: params });
    },

    /**Parses workbook data into prices and identifies stock groups.
     * This function accepts an XLSX workbook object and performs the following steps:
     * 1. Retrieves the first sheet of the workbook.
     * 2. Converts the sheet to a JSON object, with the first row as the header.
     * 3. Checks if the JSON object has at least one row of data.
     * 4. If there is data, it sets the global state's prices property to the JSON object.
     * 5. Determines the list of stock groups by filtering the keys of the first row.
     * 6. Calls the renderTable function to render the price history table.
     * 7. Calls the requestSolve function to solve for the optimal trading strategy.
     * @param {Object} workbook The XLSX workbook object to parse.
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

    /**Exports trading results into a multi-tab Excel report.
     * Generates a "Daily Activity" ledger and a "Cumulative Holdings" snapshot.
     * This function creates a new Excel workbook and appends two worksheets to it:
     * 1. "Daily Activity": A ledger of daily trades, showing for each day the cash
     *    reserves, and the change in each stock position from the previous day.
     * 2. "Cumulative Holdings": The portfolio at the end of each day, showing the 
     *    total portfolio value, the cash position, and the holdings for each stock.
     */
    exportResults() {
        if (!window.stockState.results) {
            alert("No stock results found. Please ensure the market analysis has finished.");
            return;
        }

        const logs = window.stockState.results.dailyLogs;
        const stockNames = window.stockState.stocks;
        const wb = XLSX.utils.book_new();

        /**Returns the formatted date for the given day index.
         * If the row for the date is not available, returns a string with the day index.
         * Otherwise, returns the formatted date string.
         * @param {number} dayIdx The day index (zero-based).
         * @returns {string} The formatted date string, or the day index as a string.
         */
        const getFormattedDate = (dayIdx) => {
            const row = window.stockState.prices[dayIdx];
            if (!row) return `Day ${dayIdx}`;
            const mNames = window.monthNames || ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            const month = mNames[parseInt(row.Month)] || row.Month;
            return `${month} ${row.Day}`;
        };

        /**Generates the header for the "Daily Activity" ledger.
         * @returns {Array<string>} The header row.
         */
        const ledgerHeader = ["Date", "Cash Reserves", ...stockNames.map(s => `${s} Change`)];
        
        /**Generates the data for the "Daily Activity" ledger.
         * @returns {Array<Array<string|number>>} The ledger data.
         */
        const ledgerData = logs.map((d, i) => {
            const row = [getFormattedDate(i), d.cashHeld];
            stockNames.forEach(s => {
                const change = (d.buys[s] || 0) - (d.sells[s] || 0);
                row.push(change);
            });
            return row;
        });

        // Append the "Daily Activity" ledger to the workbook.
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([ledgerHeader, ...ledgerData]), "Daily Activity");

        /**Generates the header for the "Cumulative Holdings" snapshot.
         * @returns {Array<string>} The header row.
         */
        const accumulationHeader = ["Date", "Total Portfolio Value", "Cash Position", ...stockNames];
        
        /**Generates the data for the "Cumulative Holdings" snapshot.
         * @returns {Array<Array<string|number>>} The accumulation data.
         */
        const accumulationData = logs.map((d, i) => {
            const row = [getFormattedDate(i), d.totalValue, d.cashHeld];
            stockNames.forEach(s => row.push(d.stockValues[s] || 0));
            return row;
        });

        // Append the "Cumulative Holdings" snapshot to the workbook.
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([accumulationHeader, ...accumulationData]), "Cumulative Holdings");

        // Write the workbook to a file and download it.
        const dateTag = new Date().toISOString().slice(0, 10);
        XLSX.writeFile(wb, `Portfolio_Analysis_${dateTag}.xlsx`);
    },

    /**Renders the Price History table--only displayed and not editable due to size.
     * This function populates the table head with the column names for each stock
     * and each day of the year. It then populates the table body with the price
     * data for each stock and each day of the year.
     */
    renderTable() {
        const head = document.getElementById('stockTableHead'); // Get the table head element
        const body = document.getElementById('stockTableBody'); // Get the table body element
        if (!head || !body) return; // If either element is not found, return early

        // Populate the table head
        head.innerHTML = `<tr><th>Month</th><th>Day</th>${window.stockState.stocks.map(s => `<th>${s}</th>`).join('')}</tr>`;

        // Populate the table body
        body.innerHTML = window.stockState.prices.slice(0, 365).map(row => `
            <tr>
                <td>${row.Month || ''}</td> // Add the month column
                <td>${row.Day || ''}</td> // Add the day column
                ${window.stockState.stocks.map(s => `<td>$${(parseFloat(row[s]) || 0).toFixed(2)}</td>`).join('')} // Add the stock price columns
            </tr>`).join('');
    },

    /**Handles the rendering of the D3 charts in the stocks module.
     * This function is called when the global state for the stocks module
     * changes. It checks if the necessary data is available in the global
     * state, and if so, it renders the activity chart, the composition
     * chart, and the shared legend.
     */
    drawCharts() {
        // Check if the necessary data is available
        if (!window.stockState.results) return; 

        // Render each chart and the shared legend
        this.drawActivityChart(); // Renders the activity chart
        this.drawCompositionChart(); // Renders the composition chart
        this.drawLegend(); // Renders the shared legend
    },

    /**
     * Renders a divergent stacked bar chart representing net trade activity.
     * The chart shows the net activity (buys - sells) of each stock in the
     * portfolio over time. The bars are colored by stock name, and cash.
     * The chart includes a zero baseline line and a month label for each day.
     * The x-axis labels are positioned in the center of each bar. When the mouse
     * hovers over the chart, the bars move to show the label under the mouse
     * pointer, and a tooltip appears with details of the activity for that day.
     */
    drawActivityChart() {
        const container = document.getElementById('portfolioChartContainer');
        if (!container || !window.stockState.results) return;

        const rect = container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        // Calculating and Declaring the chart dimensions
        container.innerHTML = '';
        const margin = { top: 20, right: 30, bottom: 40, left: 70 };
        const width = rect.width - margin.left - margin.right;
        const height = rect.height - margin.top - margin.bottom;

        // Create the container for the chart
        const svg = d3.select(container).append("svg")
            .attr("width", rect.width).attr("height", rect.height)
            .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

        // Prepare the data
        const data = window.stockState.results.dailyLogs;
        const N = data.length;

        // Defining the Stock Color Scale
        const color = d3.scaleOrdinal().domain(window.stockState.stocks).range(d3.schemeCategory10);

        // Prepare the stack data: Each row of the data is a stack of bars, one for each stock
        const stackData = data.map(d => {
            const row = { dayIdx: d.dayIdx };
            window.stockState.stocks.forEach(s => row[s] = (d.buys[s] || 0) - (d.sells[s] || 0));
            return row;
        });

        // Compute the stack series: The stack series takes each row and computes the area under each stack
        const stackedSeries = d3.stack().keys(window.stockState.stocks).offset(d3.stackOffsetDiverging)(stackData);

        // Prepare the y-axis: The y-axis range goes from the lowest value to the highest value in the stack
        const y = d3.scaleLinear().domain([
            d3.min(stackedSeries, s => d3.min(s, d => d[0])) * 1.1,
            d3.max(stackedSeries, s => d3.max(s, d => d[1])) * 1.1
        ]).range([height, 0]);

        // Bars layer: Each bar in the stack is a rectangle with a fill color matching the stock name
        const layers = svg.selectAll(".layer").data(stackedSeries).enter().append("g").attr("fill", d => color(d.key));
        const bars = layers.selectAll("rect").data(d => d).enter().append("rect")
            .attr("stroke", "#fff").attr("stroke-width", "1px")
            .attr("y", d => y(d[1])).attr("height", d => Math.max(0, Math.abs(y(d[0]) - y(d[1]))));

        // Month labels data preparation: Computes the x position for each month label
        const monthPositions = [];
        let lastMonth = -1;
        window.stockState.prices.forEach((row, i) => {
            if (row.Month !== lastMonth && i < N) {
                const mNames = window.monthNames || ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                monthPositions.push({ index: i, name: mNames[parseInt(row.Month)] || row.Month });
                lastMonth = row.Month;
            }
        });

        // Create the x-axis labels (months)
        const xLabels = svg.append("g").attr("class", "x-axis")
            .selectAll(".month-label").data(monthPositions).enter().append("text")
            .attr("class", "month-label").attr("y", height + 25).attr("text-anchor", "middle")
            .style("font-size", "1.0rem").style("fill", "#888").text(d => d.name);

        /**Function to compute the x positions of the bars and labels to highlight the hovered area.
         * If hoverIndex is null, the bars and labels are evenly distributed in the chart.
         * If hoverIndex is not null, a fisheye effect is applied to the chart, with the hovered area
         * being enlarged.  This is to enable a detailed view of the 365 days within the chart.
         * @param {?number} hoverIndex - The index of the hovered bar
         * @param {number} mx - The mouse x position
         */
        const updateGeometry = (hoverIndex, mx) => {
            const positions = new Float32Array(N + 1);
            // If hoverIndex is null, the bars and labels are evenly distributed in the chart
            if (hoverIndex === null) {
                // Fill the positions array with the positions of the bars and labels
                for (let i = 0; i <= N; i++) {
                    positions[i] = (i / N) * width;
                }
            } else { // Apply the fisheye effect to the chart
                // Initialize the array of weights to all 1s
                const weights = new Float32Array(N);
                // Compute the weights as a function of the distance to the hovered bar
                const strength = 6.0, radius = 13;
                for (let i = 0; i < N; i++) {
                    weights[i] = 1 + strength * Math.exp(-(Math.pow(i - hoverIndex + 2, 2)) / (2 * radius * radius));
                }
                // Compute the total weight of the bars to the left of the hovered bar
                let lT = 0;
                for (let i = 0; i < hoverIndex; i++) {
                    lT += weights[i];
                }
                // Add half the weight of the hovered bar to lT
                lT += weights[hoverIndex] * 0.5;
                // Compute the total weight of the bars to the right of the hovered bar
                let rT = weights[hoverIndex] * 0.5;
                for (let i = hoverIndex + 1; i < N; i++) {
                    rT += weights[i];
                }
                // Compute the scale factors for the left and right of the hovered bar
                const sL = mx / lT, sR = (width - mx) / rT;
                
                // Fill the positions array with the positions of the bars and labels
                positions[0] = 0;
                for (let i = 0; i < N; i++) {
                    if (i < hoverIndex) {
                        // The bar is to the left of the hovered bar
                        positions[i + 1] = positions[i] + weights[i] * sL;
                    } else if (i > hoverIndex) {
                        // The bar is to the right of the hovered bar
                        positions[i + 1] = positions[i] + weights[i] * sR;
                    } else {
                        // The bar is the hovered bar
                        positions[i + 1] = mx + (weights[i] * 0.5 * sR);
                    }
                }
            }
            // Update the x position and width of the bars
            bars.attr("x", (d, i) => positions[i]).attr("width", (d, i) =>
                Math.max(0, positions[i + 1] - positions[i] - 0.2));
            
            // Update the x position of the labels
            xLabels.attr("x", d => positions[d.index] + (positions[d.index + 1] - positions[d.index]) / 2)
                .style("opacity", (d) => (positions[d.index + 1] - positions[d.index] > 3) ? 1 : 0);
        };

        // Fisheye Overlay
        svg.append("rect").attr("width", width).attr("height", height).attr("fill", "transparent")
            .on("mousemove", (event) => {
                const [mx] = d3.pointer(event);
                const idx = Math.max(0, Math.min(N - 1, Math.round((mx / width) * (N - 1))));
                updateGeometry(idx, mx);
                this.showActivityTooltip(data[idx], idx > 0 ? data[idx - 1] : null, event, color);
            })
            .on("mouseleave", () => { updateGeometry(null); hideTooltip(); });

        // Zero baseline line
        svg.append("line").attr("x1", 0).attr("x2", width).attr("y1", y(0)).attr("y2", y(0)).attr("class", "zero-line");
        svg.append("g").call(d3.axisLeft(y).tickFormat(d3.format("$.2s")));
        updateGeometry(null, 0);
    },

    /**Renders an area-style stacked chart showing portfolio composition.
     * Updated to include month labels and a visible x-axis baseline.
     */
    drawCompositionChart() {
        // Clear the container element and get its size
        const container = document.getElementById('allocationChartContainer');
        if (!container || !window.stockState.results) return;
        const rect = container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        // Calculate the chart dimensions
        container.innerHTML = '';
        const margin = { top: 20, right: 30, bottom: 40, left: 70 };
        const width = rect.width - margin.left - margin.right;
        const height = rect.height - margin.top - margin.bottom;

        // Set up the SVG element
        if (width <= 0 || height <= 0) return;
        const svg = d3.select(container).append("svg")
            .attr("width", rect.width).attr("height", rect.height)
            .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

        // Get the data for the chart
        const data = window.stockState.results.dailyLogs;
        const N = data.length;
        const keys = [...window.stockState.stocks, "Cash"];
        // Create a color scale for the different stocks, and cash
        const color = d3.scaleOrdinal().domain(keys).range([...d3.schemeCategory10, "#95a5a6"]);

        // Prepare the stacked series data
        const stackData = data.map(d => {
            const row = { Cash: d.cashHeld };
            Object.entries(d.stockValues).forEach(([s, v]) => row[s] = v);
            return row;
        });
        const stackedSeries = d3.stack().keys(keys)(stackData);

        // Set up the y-scale for the chart
        const y = d3.scaleLinear().domain([0, d3.max(data, d => d.totalValue) * 1.05]).range([height, 0]);

        // Add the areas to the chart
        const layers = svg.selectAll(".layer").data(stackedSeries).enter().append("g")
            .attr("fill", d => color(d.key)).attr("fill-opacity", d => d.key === "Cash" ? 0.3 : 1);
        const areas = layers.selectAll("rect").data(d => d).enter().append("rect")
            .attr("stroke", "rgba(255,255,255,0.3)").attr("stroke-width", "1px").attr("y", d => y(d[1])).attr("height", d => Math.abs(y(d[0]) - y(d[1])));

        // Month labels data preparation (Fisheye Dynamic Placement)
        const monthPositions = [];
        let lastMonth = -1;
        window.stockState.prices.forEach((row, i) => {

            // Add a new month label if the month has changed and we're not at the end of the data
            if (row.Month !== lastMonth && i < N) {
                const mNames = window.monthNames || ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                monthPositions.push({ index: i, name: mNames[parseInt(row.Month)] || row.Month });
                lastMonth = row.Month;
            }
        });

        // Add the labels for the months
        const xLabels = svg.append("g").attr("class", "x-axis")
            .selectAll(".month-label").data(monthPositions).enter().append("text")
            .attr("class", "month-label").attr("y", height + 25).attr("text-anchor", "middle")
            .style("font-size", "1.0rem").style("fill", "#888").text(d => d.name); // Matched style

        /**Function to compute the x positions of the bars and labels to highlight the hovered area.
         * If hoverIndex is null, the bars and labels are evenly distributed in the chart.
         * If hoverIndex is not null, a fisheye effect is applied to the chart, with the hovered area
         * being enlarged.
         *
         * @param {?number} hoverIndex - The index of the hovered bar
         * @param {number} mx - The mouse x position
         */
        const updateGeometry = (hoverIndex, mx) => {
            // Initialize the array of positions to all 0s
            const positions = new Float32Array(data.length + 1);
            // If hoverIndex is null, the bars and labels are evenly distributed in the chart
            if (hoverIndex === null) {
                // Fill the positions array with the positions of the bars and labels
                for (let i = 0; i <= data.length; i++) positions[i] = (i / data.length) * width;
            } else {
                // Apply the fisheye effect to the chart
                // Initialize the array of weights to all 1s
                const weights = new Float32Array(data.length);
                // Compute the weights as a function of the distance to the hovered bar
                const strength = 6.0, radius = 13;
                for (let i = 0; i < data.length; i++) {
                    weights[i] = 1 + strength * Math.exp(-(Math.pow(i - hoverIndex, 2)) / (2 * radius * radius));
                }
                // Compute the total weight of the bars to the left of the hovered bar
                let lT = 0;
                for (let i = 0; i < hoverIndex; i++) lT += weights[i];
                // Add half the weight of the hovered bar to lT
                lT += weights[hoverIndex] * 0.5;
                // Compute the total weight of the bars to the right of the hovered bar
                let rT = weights[hoverIndex] * 0.5;
                for (let i = hoverIndex + 1; i < data.length; i++) rT += weights[i];
                // Compute the scale factors for the left and right of the hovered bar
                const sL = mx / lT, sR = (width - mx) / rT;
                // Fill the positions array with the positions of the bars and labels
                positions[0] = 0;
                for (let i = 0; i < data.length; i++) {
                    // If the bar is to the left of the hovered bar, add the weight * sL to the x position
                    if (i < hoverIndex) positions[i + 1] = positions[i] + weights[i] * sL;
                    // If the bar is to the right of the hovered bar, add the weight * sR to the x position
                    else if (i > hoverIndex) positions[i + 1] = positions[i] + weights[i] * sR;
                    // The hovered bar is a special case, it gets half the sR and half the sL
                    else positions[i + 1] = mx + (weights[i] * 0.5 * sR);
                }
            }
            // Update the x positions of the bars and labels
            areas.attr("x", (d, i) => positions[i]).attr("width", (d, i) => Math.max(0, positions[i + 1] - positions[i]));
            xLabels.attr("x", d => positions[d.index] + (positions[d.index + 1] - positions[d.index]) / 2)
                // Show the labels that are in the enlarged area and hide the others
                .style("opacity", (d) => (positions[d.index + 1] - positions[d.index] > 3) ? 1 : 0);
        };

        svg.append("rect").attr("width", width).attr("height", height).attr("fill", "transparent")
            .on("mousemove", (event) => {
                const [mx] = d3.pointer(event);
                const idx = Math.max(0, Math.min(data.length - 1, Math.round((mx / width) * (data.length - 1))));
                updateGeometry(idx, mx);
                this.showCompositionTooltip(data[idx], event, color);
            })
            .on("mouseleave", () => { updateGeometry(null); hideTooltip(); });

        // Zero baseline line
        svg.append("line").attr("x1", 0).attr("x2", width).attr("y1", height).attr("y2", height).attr("class", "zero-line");

        svg.append("g").call(d3.axisLeft(y).tickFormat(d3.format("$.2s")));
        updateGeometry(null, 0);
    },

    /**
     * Renders the activity breakdown tooltip.
     * The tooltip shows the breakdown of the daily activity into individual stock trades.
     * @param {Object} d The daily activity log entry for the current day.
     * @param {Object} [prevD] The daily activity log entry for the previous day.
     * @param {MouseEvent} event The mouse event that triggered the tooltip.
     * @param {d3.ScaleOrdinal<string>} colorScale The D3 color scale used to color the tooltip elements.
     */
    showActivityTooltip(d, prevD, event, colorScale) {
        // Get the date row for the current day
        const dateRow = window.stockState.prices[d.dayIdx];
        if (!dateRow) return;

        // Get the month names from the global object, or initialize with an empty string and format the date string
        const mNames = window.monthNames || ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const dateStr = `${mNames[parseInt(dateRow.Month)] || dateRow.Month} ${dateRow.Day}`;

        // Calculate the daily change in total value, if the previous day is available
        const growth = prevD ? ((d.totalValue - prevD.totalValue) / prevD.totalValue) * 100 : 0;

        let buyHtml = '', sellHtml = '';
        // Iterate over each stock in the portfolio
        window.stockState.stocks.forEach(name => {
            // Get the number of shares bought and sold for the current stock
            const sharesBought = d.buys[name] || 0, sharesSold = d.sells[name] || 0;
            // Get the price of the current stock for the current day
            const price = parseFloat(dateRow[name]) || 0, c = colorScale(name);
            // Append the HTML string with the buy or sell element
            if (sharesBought > 0) buyHtml += `<div class="tooltip-metric"><span><i style="display:inline-block;width:8px;height:8px;background:${c};margin-right:5px;border-radius:1px;"></i>${name}: </span><span>${formatCurrency(sharesBought * price)} (${sharesBought.toFixed(1)} shares)</span></div>`;
            if (sharesSold > 0) sellHtml += `<div class="tooltip-metric"><span><i style="display:inline-block;width:8px;height:8px;background:${c};margin-right:5px;border-radius:1px;"></i>${name}: </span><span>${formatCurrency(sharesSold * price)} (${sharesSold.toFixed(1)} shares)</span></div>`;
        });

        // Show the tooltip with the formatted HTML
        showTooltip(`
            <div class="tooltip-header">${dateStr}</div>
            <div class="tooltip-row"><span>Cash Held:</span> <span>${formatCurrency(d.cashHeld)}</span></div>
            <div class="tooltip-row"><span>Daily Change:</span> <span style="color:${growth >= 0 ? '#2ecc71' : '#e74c3c'}">${growth.toFixed(2)}%</span></div>
            ${buyHtml ? `<div class="tooltip-block buy-block"><strong>Total Bought</strong>${buyHtml}</div>` : ''}
            ${sellHtml ? `<div class="tooltip-block sell-block"><strong>Total Sold</strong>${sellHtml}</div>` : ''}
        `, event);
    },

    /**Renders the portfolio allocation breakdown tooltip.
     * The tooltip shows the breakdown of the portfolio's holdings by stock at a given point in time.
     * The holdings are sorted by value in descending order, and each holding is displayed with its
     * name and value. The cash held is also shown as a separate item.
     * @param {Object} d - The data object containing the holdings and cash, as well as the date.
     * @param {MouseEvent} event - The event object that triggered the tooltip.
     * @param {d3.scale.Ordinal} colorScale - The color scale to use for the holding icons in the tooltip.
     */
    showCompositionTooltip(d, event, colorScale) {
        // Get the date row for the current day
        const dateRow = window.stockState.prices[d.dayIdx];
        if (!dateRow) return;
        // Get the month names for formatting the date
        const mNames = window.monthNames || ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const dateStr = `${mNames[parseInt(dateRow.Month)] || dateRow.Month} ${dateRow.Day}`; // Format the date string
        // Initialize the HTML string for the holdings
        let holdingsHtml = `<div class="tooltip-row"><span><i style="display:inline-block;width:8px;height:8px;background:${colorScale('Cash')};margin-right:5px;border-radius:1px;"></i>Cash: </span><span>${formatCurrency(d.cashHeld)}</span></div>`;

        // For each stock holding, add it to the holdings HTML, sort the holdings by value in descending order
        Object.entries(d.stockValues).sort((a, b) => b[1] - a[1]).forEach(([name, val]) => {
            // If the holding has a value greater than 1, add it to the HTML
            if (val > 1) holdingsHtml += `<div class="tooltip-row"><span><i style="display:inline-block;width:8px;height:8px;background:${colorScale(name)};margin-right:5px;border-radius:1px;"></i>${name}: </span><span>${formatCurrency(val)}</span></div>`;
        });

        // Show the tooltip with the formatted HTML
        showTooltip(`
            <div class="tooltip-header">Portfolio State</div><strong>${dateStr}</strong>
            <div class="tooltip-row"><span>Total Worth:</span> <strong>${formatCurrency(d.totalValue)}</strong></div>
            <div class="tooltip-block"><strong>Allocation:</strong>${holdingsHtml}</div>
        `, event);
    },

    /**Renders the shared chart legend using static CSS classes.
     * The legend is implemented using a set of div elements, each containing a colored box
     * and a label showing the stock name. The legend is synchronized with the chart, meaning
     * that clicking on a stock name in the legend will select that stock in the chart, and
     * vice versa.
     */
    drawLegend() {
        // Clear the contents of the container, and set the class to 'legend-container'
        const container = document.getElementById('sharedStockLegend');
        if (!container) return;
        container.innerHTML = '';
        container.className = 'legend-container';

        // Get the list of stocks from the global state object
        const items = [...window.stockState.stocks, "Cash"];
        // Create a color scale for the different stocks, and cash
        const color = d3.scaleOrdinal().domain(items).range([...d3.schemeCategory10, "#95a5a6"]);

        // For each stock, add a legend item to the container
        items.forEach(item => {
            // Create a new div of class 'legend-item' to hold the legend item
            const div = document.createElement('div');
            div.className = 'legend-item';
            // Set the HTML content of the div to a colored box and a label
            div.innerHTML = `<div class="legend-box" style="background:${color(item)}; ${item === 'Cash' ? 'opacity:0.5;' : ''}"></div><span class="legend-label">${item}</span>`;
            container.appendChild(div); // Add the div to the container
        });
    }
};