/**==============================================================================
 * Inventory Module - Production Optimizer
 * ==============================================================================
 * Description:
 * Manages the production scheduling logic for steel manufacturing.
 * Handles data import from Excel, maintains production parameters, and initializes 
 * the MILP Worker (inventoryWorker.js). Results are then visualized using D3 to
 * render stacked production charts and inventory line graphs.
 * @author Joel Wood
 */

window.InventoryModule = {
    /**This function binds the following inputs to the global window.liveState object:
     * - rawSteelCost: The cost per ton of raw steel.
     * - invCost: The cost per ton of inventory.
     * - maxCapacity: The maximum capacity of the factory per day.
     * - backorderPenalty: The penalty rate for backordered items as a percentage.
     * Each of these values is updated in the global window.liveState object when the
     * corresponding input is changed by the user.
     */
    init() {
        ['rawSteelCost', 'invCost', 'maxCapacity', 'backorderPenalty'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                // Map the input element to the global window.liveState object
                el.value = window.liveState[id];
                // When the input changes, update the global window.liveState object
                el.addEventListener('change', (e) => {
                    window.liveState[id] = parseFloat(e.target.value) || 0;
                    this.requestSolve();
                });
            }
        });
        
        // Adding an Event Listener to the Add Product Button above the Product Table
        document.getElementById('addProductBtn')?.addEventListener('click', () => this.addProductRow());

        /**Expose handlers to global scope for HTML 'onchange' compatibility
         * These handlers are called when a product or demand cell is edited in the
         * corresponding table in the HTML user interface.  The handler functions use the
         * global window.liveState object to update the internal state of the simulation.
         * @param {number} idx - The index of the row being edited.
         * @param {string} field - The name of the field being edited.
         * @param {string|number} val - The new value for the field.
         */
        window.updateProductData = (idx, field, val) => this.updateProductData(idx, field, val);
        window.updateDemandData = (pIdx, dIdx, val) => this.updateDemandData(pIdx, dIdx, val);
        window.updateOperationalTime = (dIdx, val) => this.updateOperationalTime(dIdx, val);
    },

    /**Debounced solver request. Prevents worker flooding during rapid UI adjustments
     * by introducing a 150ms cooldown period. This means that if the user makes multiple
     * changes to the input parameters (such as changing the cost of steel, or the demand
     * for a product), the solver is only actually called after the user has stopped making
     * changes for 150ms. This prevents the solver from being bombarded with requests,
     * which could slow down the UI and make it unresponsive.
     */
    requestSolve() {
        if (this.solveTimer) clearTimeout(this.solveTimer); // Cancel previous timer if it's running
        updateStatus("Changes Pending...", "waiting"); // Update UI status to show pending changes
        this.solveTimer = setTimeout(() => this.executeSolve(), 150); // Start a new timer to call executeSolve()
    },

    /**Executes the MILP solve via a background worker, with optional heuristic
     * adjustments to modify the feasible region. Features a two-pass logic:
     * 1. Attempt solve with user parameters.
     * 2. If infeasible, attempt a second pass with tightened capacity
     * @param {number} attempt - The current attempt number (default 1).
     * @param {Object|null} adjustedParams - Overridden parameters for recursive attempts.
     * @type {'result' | 'solve'} e.data.type - The type of message returned from the worker.
     * @type {string} e.data.status - The status of the solution ('Optimal' or 'Infeasible').
     * @type {Object} e.data.result - The results of the solution, if optimal.
     * @type {boolean|null} e.data.slackUsed - The amount of slack used in the solution.
     */
    executeSolve(attempt = 1, adjustedParams = null) {
        // Create a copy of current parameters to pass to the worker
        const currentParams = adjustedParams || {
            products: JSON.parse(JSON.stringify(window.systemState.products)),
            operationalTime: [...window.systemState.operationalTime],
            ...window.liveState
        };

        // Feasibility check to prevent calling the solver on mathematically impossible states
        const floors = this.calculateTheoreticalFloor(currentParams);
        const avgOpTime = currentParams.operationalTime.reduce((a, b) => a + (parseFloat(b) || 0), 0) / 7;
        if (currentParams.maxCapacity < floors.floorCap || avgOpTime < floors.floorTime) {
            // The parameters are outside the feasible region
            updateStatus("Impossible Logic", "error");
            return;
        }

        // Terminate any existing worker, if one exists
        if (window.currentWorker) window.currentWorker.terminate();

        // Create a new worker and set up the message handler
        if (attempt === 1) updateStatus("Solving...", "solving");
        window.currentWorker = new Worker('scripts/inventoryWorker.js');
        window.currentWorker.onmessage = (e) => {
            // Deconstruct the message to access the relevant data
            const { type, status, result, slackUsed } = e.data;

            // Check if the solution is optimal (and didn't use slack)
            const isOptimal = (status === 'Optimal' && (!slackUsed || slackUsed < 0.01));
            if (type === 'result' && isOptimal) {
                // If the solution's optimal, update the global state with the results
                window.systemState.results = result;
                this.updateUI();
                updateStatus("Optimal Solution", "optimal");
            } else if (attempt === 1) {
                // If not optimal, tighten the feasible region.
                // Sometimes this will be easier to resolve computationally, and a more
                // constrained solution is optimal for a less constrained solution.
                const tightenedParams = {
                    ...currentParams,
                    //Calculate the midpoint of max and floor capacity
                    maxCapacity: (currentParams.maxCapacity + floors.floorCap) / 2
                };
                // Try to solve the problem again with the tightened parameters
                this.executeSolve(2, tightenedParams);
            } else {
                // If not optimal after second attempt, return infeasible
                updateStatus("Infeasible", "error");
            }
        };
        // Send the parameters to the worker to start the solving process
        window.currentWorker.postMessage({ type: 'solve', data: currentParams });
    },

    /**Calculates the "Floor Capacity" (average daily demand) and "Floor Time"
     * (sum of processing and changeover times) given the production parameters and
     * product list. This is a heuristic baseline calculation to determine if a
     * physical solution exists.
     * - "Floor Capacity" is calculated as the average demand per day, across all
     * products. This is a measure of the aggregate capacity required to meet demand.
     * - "Floor Time" is calculated as the sum of processing time and changeover
     * time per day, across all products. This is a measure of the total minimal 
     * time required to meet demand.
     * @param {Object} params - The production parameters and product list.
     * @property {Array} params.products - The list of products to be produced.
     * @property {number} params.maxCapacity - The maximum capacity of the factory,
     * in tons per day.
     * @property {number} [params.cycleTime] - The processing time per ton, in
     * minutes. This is the time to produce one ton of a given product.
     * @property {number} [params.changeOverTime] - The changeover time, in minutes.
     * This is the time to switch from one product to another.
     * @returns {Object} An object containing floorCap and floorTime.
     */
    calculateTheoreticalFloor(params) {
        let totalDemand = 0, totalProcTime = 0;
        params.products.forEach(p => {
            // Calculate the daily demand for each product
            const d = p.demand.reduce((a, b) => a + (parseFloat(b) || 0), 0);
            totalDemand += d;
            // Calculate the processing time per day for each product
            totalProcTime += d * (parseFloat(p.cycleTime) || 0);
            if (d > 0) {
                // If there is product demand, calculate the total changeover time per day
                const minSetups = Math.max(1, Math.ceil(d / params.maxCapacity));
                totalProcTime += (minSetups * (parseFloat(p.changeOverTime) || 0) * 60);
            }
        });
        // Calculate the floor capacity and floor time
        const floorCap = totalDemand / 7;
        const floorTime = totalProcTime / (7 * 3600);
        return { floorCap, floorTime };
    },

    /**Parses uploaded workbook data into the global inventory state.
     * Specifically looks for "products", "operational hours", and "demand in days" headers.
     * This is to be both compatible with the base and modified spreadsheets.
     * * @param {Object} workbook - The XLSX workbook object.
     */
    processWorkbook(workbook) {
        // Get the first sheet of the workbook
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        // Convert the data into a JSON object, with the first row as the header
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

        // Helper Anonymous functions to clean the data
        const cleanStr = (val) => String(val || "").trim();
        const cleanNum = (val) => parseFloat(val) || 0;

        // Track the indexes of the header rows
        let prodIdx = -1, opIdx = -1, demIdx = -1;

        // Loop over each row, looking for the header rows
        for (let i = 0; i < rows.length; i++) {
            // Get the value of the first cell in the row
            const firstCell = cleanStr(rows[i][0]).toLowerCase();
            // Check if the header row is present
            if (firstCell === "products") prodIdx = i;
            else if (firstCell === "operational hours") opIdx = i;
            else if (firstCell === "demand in days") demIdx = i;
        }

        let newProducts = [];
        // If the products row is present, loop over each row after the products row
        if (prodIdx !== -1) {
            for (let i = prodIdx + 1; i < rows.length; i++) {
                const name = cleanStr(rows[i][0]); // Get the name of the product
                if (!name) break;
                // Create a new product object
                const newProduct = {
                    id: newProducts.length, // The ID of the product
                    name: cleanStr(rows[i][0]), // The name of the product
                    sell: cleanNum(rows[i][1]), // The sell price of the product
                    cost: cleanNum(rows[i][2]), // The cost of the product
                    changeOverCost: cleanNum(rows[i][3]), // The change over cost of the product
                    changeOverTime: cleanNum(rows[i][4]), // The change over time of the product
                    cycleTime: cleanNum(rows[i][5]), // The cycle time of the product
                    demand: [0, 0, 0, 0, 0, 0, 0] // The demand of the product for each day of the week
                };
                newProducts.push(newProduct); // Add the product to the new products array
            }
        }

        // If the operational hours row is present, loop over the headers for the operational hours
        if (opIdx !== -1) {
            for (let j = 0; j < 7; j++) {
                const val = cleanNum(rows[opIdx][j + 1]); // Get the value of the header
                window.systemState.operationalTime[j] = val; // Add the value to the global state
            }
        }

        // If the demand in days row is present, loop over the headers for the demand in days
        if (demIdx !== -1) {
            for (let i = demIdx + 1; i < rows.length; i++) {
                const name = cleanStr(rows[i][0]); // Get the name of the product
                if (!name) break;
                // Find the product in the new products array
                const p = newProducts.find(prod => prod.name.toLowerCase() === name.toLowerCase());
                if (p) {
                    for (let j = 0; j < 7; j++) { // Loop over the headers for the demand in days
                        const val = cleanNum(rows[i][j + 1]); // Get the value of the header
                        p.demand[j] = val; // Set the value in the product's demand array
                    }
                }
            }
        }

        // Display the Product Table and Trigger the Solver
        if (newProducts.length > 0) {
            window.systemState.products = newProducts;
            this.renderTable();
            this.requestSolve();
        }
    },

    /**Exports the optimized results into a multi-row formatted XLSX file.
     * The function creates a new workbook and appends a worksheet with the results.
     * The worksheet contains the following information:
     * - The total profit from the solution
     * - A row per product with the following columns:
     *   - The product name
     *   - The labels for each day of the week for the following metrics:
     *     - Produced: The amount of each product that was produced
     *     - Sold: The amount of each product that was sold
     *     - Ending Inv: The amount of each product left in inventory at the end of the week
     *     - Backorder: The amount of each product that was ordered but not produced
     */
    exportResults() {
        if (!window.systemState.results) {
            alert("No production results found. Please ensure the solver has finished.");
            return;
        }

        const wb = XLSX.utils.book_new(); // Create a new workbook
        const res = window.systemState.results; // Get the results from global state

        const wsData = [
            ["Optimized Production Schedule"],
            ["Total Profit", res.objectiveValue], // Total profit from the solution
            []
        ];

        res.details.forEach(p => { // For each product in the solution
            wsData.push([p.product]); // Add the product name to the worksheet
            wsData.push(["Metric", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]); // Add the labels for each day of the week
            wsData.push(["Produced", ...p.produced]); // Add the produced amount for each day of the week
            wsData.push(["Sold", ...p.sold]); // Add the sold amount for each day of the week
            wsData.push(["Ending Inv", ...p.inventory]); // Add the ending inventory amount for each day of the week
            wsData.push(["Backorder", ...p.backorder]); // Add the backordered amount for each day of the week
            wsData.push([]); // Add a blank row between products
        });

        const ws = XLSX.utils.aoa_to_sheet(wsData); // Convert the data to a sheet
        XLSX.utils.book_append_sheet(wb, ws, "Production Solution"); // Add the sheet to the workbook
        XLSX.writeFile(wb, "Production_Results.xlsx"); // Write the workbook to a file
    },

    /**Renders the table with the current product state from the HTML input table.
     * This function populates the table with the current product data, as well as the
     * total operational time row. The function iterates over each product and adds a
     * row to the table, with input fields for each product attribute. The function also
     * populates the demand (inventory) for each product, with input fields for each day
     * of the week. The function then updates the HTML table with the new data.
     */
    renderTable() {
        const body = document.getElementById('tableBody');
        if (!body) return;
        body.innerHTML = '';

        // Render the total operational time row
        let opRow = `<tr style="background-color: #f0f4f8; font-weight: bold;">
            <td colspan="6" style="text-align: right; padding-right: 15px;">Total Operational Time (Hours):</td>`;
        window.systemState.operationalTime.forEach((t, i) => {
            // Render the input field for each operational time
            opRow += `<td><input type="number" style="width: 100%; font-weight: bold; color: #333;" value="${t}" onchange="updateOperationalTime(${i}, this.value)"></td>`;
        });
        body.innerHTML = opRow + `</tr>`;

        // Render each product row
        window.systemState.products.forEach((p, idx) => {
            let row = `<tr>
                <td><input type="text" value="${p.name}" onchange="updateProductData(${idx}, 'name', this.value)"></td>
                <td><input type="number" value="${p.sell}" onchange="updateProductData(${idx}, 'sell', this.value)"></td>
                <td><input type="number" value="${p.cost}" onchange="updateProductData(${idx}, 'cost', this.value)"></td>
                <td><input type="number" value="${p.changeOverCost}" onchange="updateProductData(${idx}, 'changeOverCost', this.value)"></td>
                <td><input type="number" value="${p.changeOverTime}" onchange="updateProductData(${idx}, 'changeOverTime', this.value)"></td>
                <td><input type="number" value="${p.cycleTime}" onchange="updateProductData(${idx}, 'cycleTime', this.value)"></td>`;
            // Render the demand (inventory) for each day of the week
            p.demand.forEach((d, dayIdx) => {
                row += `<td><input type="number" value="${d}" onchange="updateDemandData(${idx}, ${dayIdx}, this.value)"></td>`;
            });
            body.innerHTML += row + `</tr>`;
        });
    },

    /**Handles updating a product's data in the simulation from the HTML table.
     * This function is called when the user edits a cell in the 'Products' table in
     * the UI. The function receives the index of the row (product) being edited, the
     * name of the field being edited (column), and the new value. The function
     * performs the following steps:
     * 1. If the field is 'name', updates the name of the product.
     * 2. Otherwise, updates the corresponding numeric field of the product. If the
     *    value cannot be parsed as a number, it defaults to 0.
     * 3. Calls the 'requestSolve' function to trigger a re-solution of the
     *    simulation with the new data.
     * @param {number} idx - The index of the product in the 'Products' table.
     * @param {string} field - The name of the field being edited.
     * @param {string|number} val - The new value for the field.
     */
    updateProductData(idx, field, val) {
        if (field === 'name') window.systemState.products[idx].name = val;
        else window.systemState.products[idx][field] = parseFloat(val) || 0;
        this.requestSolve();
    },
    updateDemandData(pIdx, dIdx, val) { window.systemState.products[pIdx].demand[dIdx] = parseFloat(val) || 0; this.requestSolve(); },
    updateOperationalTime(dIdx, val) { window.systemState.operationalTime[dIdx] = parseFloat(val) || 0; this.requestSolve(); },

    /**Appends a blank product row to the simulation.
     * This function is called when the user clicks the 'Add Product' button in the
     * UI. The function performs the following steps:
     * 1. Gets the current number of products in the simulation.
     * 2. Creates a new product object with default values for each field.
     * 3. Adds the new product object to the global products array.
     * 4. Calls the function 'renderTable' to update the product table in the UI.
     * 5. Calls the function 'requestSolve' to trigger a re-solve of the simulation
     *    with the new product.
     */
    addProductRow() {
        // Get the current number of products in the simulation
        const newId = window.systemState.products.length;

        // Create a new product object with default values for each field
        const newProduct = {
            id: newId, // New ID for the product
            name: `New Product ${newId + 1}`, // Default name for the product
            sell: 0, // Default sell price for the product
            cost: 0, // Default cost for the product
            changeOverCost: 0, // Default changeover cost for the product
            changeOverTime: 0, // Default changeover time for the product
            cycleTime: 0, // Default cycle time for the product
            demand: [0, 0, 0, 0, 0, 0, 0] // Default demand per day for the product
        };

        // Add the new product object to the global products array
        window.systemState.products.push(newProduct);

        this.renderTable(); // Update the product table in the UI
        this.requestSolve(); // Re-solve the simulation with the new product.
    },

    /**Refreshes the Objective KPI Scorecard and triggers a chart redraw.
     * This function is called when the global objective function value changes, or
     * when the user clicks the refresh button in the UI. The function performs the
     * following steps:
     * 1. Checks if the results from the solver are available.
     * 2. Gets the DOM object which displays the global objective function, and 
     *    animates the value change by calling the 'animateValue' function.
     * 3. Calls the 'drawCharts' function to redraw all the charts in the inventory
     *    module. The function refreshes the production and inventory charts.
     */
    updateUI() {
        if (!window.systemState.results) return;
        const display = document.getElementById('globalObjDisplay');
        if (display) {
            // Animate the change in the global objective function value
            animateValue(display, window.systemState.results.objectiveValue, 200, (v) => formatCurrency(v));
        }
        // Redraw all the charts in the inventory module
        this.drawCharts();
    },

    /**Initiates D3 visualization updates.
     * This function is responsible for updating all the visualizations in the inventory module.
     */
    drawCharts() {
        this.drawSharedLegend(); // Update the shared legend
        this.drawProductionChart(); // Update the production stacked bar chart
        this.drawInventoryChart(); // Update the inventory multi-linechart
    },

    /**Renders a synchronized color legend using CSS classes from style.css.
     * The legend shows the color associated with each product, and is used to help identify
     * the products in the production and inventory charts.
     * The legend is implemented using a set of div elements, each containing a colored box
     * and a label showing the product name.
     */
    drawSharedLegend() {
        const container = document.getElementById('sharedLegend');
        if (!container || !window.systemState.results) return; // Return early if container or data is missing
        container.innerHTML = ''; // Clear the container
        container.className = 'legend-container'; // Set the class to 'legend-container'
        // Get the list of products from the simulation results
        const products = window.systemState.results.details.map(d => d.product);
        // Create a color scale that maps each product to a color from the d3.schemeCategory10 color scheme
        const color = d3.scaleOrdinal().domain(products).range(d3.schemeCategory10);

        // For each product, create a div element representing the color legend
        products.forEach(product => {
            const item = document.createElement('div');
            item.className = 'legend-item'; // Set the class name to 'legend-item'
            item.innerHTML = `
                <div class="legend-box" style="background-color:${color(product)};"></div>
                <span class="legend-label">${product}</span>`; // Add the product color box and name label
            container.appendChild(item); // Add the legend item to the container
        });
    },

    /**Renders a stacked bar chart representing daily production vs capacity limits.
     * The chart shows the volume of each product produced per day, aggregated by product.
     * The stacked bars are colored by product, using the d3.schemeCategory10 color scheme.
     * The x-axis represents the days of the week, and the y-axis represents the quantity produced.
     * The chart also displays a dotted horizontal line representing the total capacity of the factory.
     */
    drawProductionChart() {
        const container = document.getElementById('productionChartContainer'); // Clear the main container element
        if (!container || !window.systemState.results) return; // Abort if container is not available or data is missing
        container.innerHTML = '';

        // Set the dimensions of the chart based on the container size
        const rect = container.getBoundingClientRect();
        const margin = { top: 10, right: 30, bottom: 30, left: 50 };
        const width = rect.width - margin.left - margin.right;
        const height = rect.height - margin.top - margin.bottom;

        // Create a D3 SVG element inside the container, with the specified viewBox
        const svg = d3.select(container).append("svg")
            .attr("width", "100%").attr("height", "100%")
            .attr("viewBox", `0 0 ${rect.width} ${rect.height}`)
            .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

        // Prepare and map the aggregated data for the stacked bar chart

        const stackData = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day, i) => {
            // For each day, create an object with the day name as the key
            const obj = { day };
            // For each product, get the quantity produced and add it to the object
            window.systemState.results.details.forEach(p => { obj[p.product] = p.produced[i]; });
            return obj;
        });

        const subgroups = window.systemState.results.details.map(d => d.product); // Identify the subgroups (the products)
        const color = d3.scaleOrdinal().domain(subgroups).range(d3.schemeCategory10); // Create a color scale for the subgroups
        // Create the scales for the axes
        const x = d3.scaleBand().domain(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]).range([0, width]).padding(0.2);
        const y = d3.scaleLinear().domain([0, window.liveState.maxCapacity * 1.1]).range([height, 0]);

        // Add the axes to the chart
        svg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x));
        svg.append("g").call(d3.axisLeft(y));

        // Add the stacked bars to the chart; for each stack layer (product), create a group element
        svg.append("g").selectAll("g").data(d3.stack().keys(subgroups)(stackData)).enter().append("g")
            .attr("fill", d => color(d.key))
            // For each bar within the layer, create a rectangle element
            .selectAll("rect").data(d => d).enter().append("rect")
            .attr("x", d => x(d.data.day)).attr("y", d => y(d[1]))
            .attr("height", d => Math.max(0, y(d[0]) - y(d[1]))).attr("width", x.bandwidth())
            .on("mouseover", function (event, d) {
                // When the mouse is over a bar, show a tooltip with the quantity produced
                const product = d3.select(this.parentNode).datum().key;
                const c = color(product);
                showTooltip(`
                    <div class="tooltip-header">
                        <i style="display:inline-block;width:8px;height:8px;background:${c};margin-right:5px;border-radius:1px;"></i>${product}
                    </div>
                    <div class="tooltip-row">
                        <span>Produced:</span> <span>${(d[1] - d[0]).toFixed(0)} tons</span>
                    </div>`, event);
            })
            .on("mouseout", () => hideTooltip());

        // Add the dotted horizontal Max Capacity line
        svg.append("line").attr("x1", 0).attr("x2", width).attr("y1", y(window.liveState.maxCapacity)).attr("y2", y(window.liveState.maxCapacity)).attr("class", "capacity-line");
    },

    /**Renders a multi-line chart depicting ending inventory levels and backorder penalties across days of the week.
     */
    drawInventoryChart() {
        const container = document.getElementById('inventoryChartContainer'); // Clear the main container element
        if (!container || !window.systemState.results) return; // Abort if container is not available or data is missing
        container.innerHTML = '';

        // Calculate the size of the SVG chart
        const rect = container.getBoundingClientRect();
        const margin = { top: 10, right: 30, bottom: 30, left: 50 };
        const width = rect.width - margin.left - margin.right;
        const height = rect.height - margin.top - margin.bottom;

        // Create the main SVG element and append it to the container
        const svg = d3.select(container).append("svg")
            .attr("width", "100%").attr("height", "100%")
            .attr("viewBox", `0 0 ${rect.width} ${rect.height}`)
            .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

        // Define the axes
        const daysArr = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
        const x = d3.scalePoint().domain(daysArr).range([0, width]);
        let maxVal = 100, minVal = 0;
        // Create a helper array to hold the data and calculate the y-axis range
        const netData = window.systemState.results.details.map(p => ({
            product: p.product,
            values: p.inventory.map((inv, i) => {
                // Calculate net inventory (inventory - backorder)
                const net = inv - p.backorder[i];
                // Update the range of the y-axis
                maxVal = Math.max(maxVal, net); minVal = Math.min(minVal, net);
                return net;
            }),
            rawInv: p.inventory, rawBack: p.backorder
        }));

        // Create the y-axis
        const y = d3.scaleLinear().domain([minVal * 1.1, maxVal * 1.1]).range([height, 0]).nice();
        // Define the colors for each product based on the d3.schemeCategory10 color scheme
        const color = d3.scaleOrdinal().domain(netData.map(d => d.product)).range(d3.schemeCategory10);

        // Append the axes and baseline
        svg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x));
        svg.append("g").call(d3.axisLeft(y));
        svg.append("line").attr("x1", 0).attr("x2", width).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", "#666").style("opacity", 0.8);

        // Create a line generator
        const line = d3.line().x((d, i) => x(daysArr[i])).y(d => y(d));
        // For each product, add a line and dots to the chart
        netData.forEach(p => {
            const c = color(p.product); // Get the color for this product
            // Add the line and dots
            svg.append("path").datum(p.values).attr("class", "chart-line").attr("stroke", c).attr("d", line);
            svg.selectAll(`.dot-${p.product.replace(/\s/g, '')}`).data(p.values).enter().append("circle")
                .attr("cx", (d, i) => x(daysArr[i])).attr("cy", d => y(d)).attr("r", 5)
                .attr("fill", c).attr("stroke", "white")
                // Add mouseover and mouseout handlers
                .on("mouseover", (event, d) => {
                    const idx = daysArr.findIndex(day => Math.abs(x(day) - parseFloat(d3.select(event.target).attr('cx'))) < 1);
                    showTooltip(`
                        <div class="tooltip-header">
                            <i style="display:inline-block;width:8px;height:8px;background:${c};margin-right:5px;border-radius:1px;"></i>${p.product} (${daysArr[idx]})
                        </div>
                        <div class="tooltip-row">
                            <span>Inventory:</span> <span>${p.rawInv[idx]} tons</span>
                        </div>
                        <div class="tooltip-row">
                            <span>Backorder:</span> <span <span class="${p.rawBack[idx] > 0 ? 'tooltip-value-bad' : ''}">${p.rawBack[idx]} tons</span>
                        </div>`, event);
                })
                .on("mouseout", () => hideTooltip());
        });
    }
};

// Export the module for use in other scripts
window.InventoryModule = InventoryModule;