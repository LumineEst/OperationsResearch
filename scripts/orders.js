/**==============================================================================
 * Orders Module - Q/R Policy Optimizer
 * ==============================================================================
 * Description:
 * This module manages the User Interface, Data Visualization, and Worker Communication
 * for the Markov Chain Inventory Optimization problem.
 * * IT PERFORMS THE FOLLOWING:
 * 1. Manages State: Syncs inputs (Costs, Capacities, Demand) with `window.orderState`.
 * 2. Data Validation: Ensures Demand Probabilities sum to 1.0 before solving.
 * 3. Worker Interface: Sends simulation parameters to `ordersWorker.js` and handles results.
 * 4. Visualization: Uses D3.js to render:
 * - A Scorecard of key financial KPIs.
 * - A Scatter Plot of Policy Profitability (Q vs Profit).
 * - A Sensitivity Heatmap (Q vs R).
 * - A Steady State Probability Chart (Inventory Levels).
 * * @author Joel Wood
 */
window.OrdersModule = {
    // ------------------------------------------------------------------------
    // DEFAULT CONFIGURATION
    // ------------------------------------------------------------------------
    defaults: {
        pricePerItem: 30000,    // Revenue per Truck Sold
        costPerItem: 20000,     // Cost per Truck Ordered
        fixedOrderCost: 2000,   // Cost to place an order
        holdingCost: 200,       // Weekly holding cost per unit ending inventory
        penaltyCost: 1000,      // Goodwill penalty for lost sales
        specialOrderCost: 3000, // Cost to expedite a unit if stockout occurs
        maxCapacity: 15,        // Physical constraints of the lot
        demandDist: [           // Default Demand Distribution (Qty vs Probability)
            { qty: 0, prob: 0.10 },
            { qty: 1, prob: 0.20 },
            { qty: 2, prob: 0.40 },
            { qty: 3, prob: 0.25 },
            { qty: 6, prob: 0.05 }
        ]
    },

    // ------------------------------------------------------------------------
    // INITIALIZATION & EVENT BINDING
    // ------------------------------------------------------------------------

    /**
     * Initializes the Orders Module.
     * Sets up the global state object, binds DOM inputs to that state,
     * and prepares the UI for the first render.
     */
    init() {
        // Initialize Global State if it doesn't exist
        if (!window.orderState) {
            window.orderState = {
                params: { ...this.defaults },   // Copy defaults
                results: null,                  // Stores the worker output
                selectedPolicy: null,           // The specific policy (Q,R) user clicked on
                hiddenRs: new Set()             // Filter state for the Scatter Plot Legend
            };
        }

        /**Bind Sidebar Input Fields to State
         * This function attaches 'change' listeners to the sidebar input fields.
         * It expects an ID (which maps to an input field in the HTML) and a key (which maps to a state parameter).
         * For each input field, it retrieves the corresponding state parameter from the global state object and sets the
         * input field's value to that parameter.
         * It then attaches a 'change' event listener to the input field. When the user changes the input field's value,
         * the event listener updates the global state object with the new value and triggers a re-solve of the simulation.
         */
        const bindInput = (id, key) => {
            // Retrieve the input element by its ID
            const el = document.getElementById(id);
            // If the input element exists
            if (el) {
                // Set the input element's value to the corresponding state parameter
                el.value = window.orderState.params[key];
                // Add a 'change' event listener to the input element
                el.addEventListener('change', (e) => {
                    // Update the global state object with the new value
                    window.orderState.params[key] = parseFloat(e.target.value) || 0;
                    // Trigger a re-solve of the simulation
                    this.requestSolve();
                });
            }
        };

        // Map DOM IDs to State Keys
        ['ord_price', 'ord_cost', 'ord_fixed', 'ord_holding', 'ord_penalty', 'ord_special', 'ord_capacity']
            .forEach((id, i) => bindInput(id, Object.keys(this.defaults)[i]));

        // Render the Probability Input Table
        this.renderDemandTable();

        /**Expose Global Helper for Table Inputs (updateOrderDemand)
         * This function is a helper that allows the HTML table for editing Weekly
         * Demand Probabilities to call back into this module. It receives an index
         * (idx) into the global orderState.params.demandDist array, a field name
         * (field), and a new value (val). The function performs the following steps:
         * a) If the index is valid and refers to an element in the demandDist
         * array, the function updates that element's field with the new value.
         * b) If the new value is an empty string, the element's field is set to
         * null. This allows the user to clear the field.
         * c) If the new value is not an empty string, the element's field is set
         * to the parsed float value of the new value.
         * d) Finally, the function calls this.requestSolve() to trigger a re-solve
         * of the simulation with the updated demand distribution.
         */
        window.updateOrderDemand = (idx, field, val) => {
            const dist = window.orderState.params.demandDist;
            if (dist[idx]) {
                // Allow empty strings for UI typing, parse numbers for logic
                if (val === '') {
                    dist[idx][field] = null;
                } else {
                    dist[idx][field] = parseFloat(val);
                }
                this.requestSolve();
            }
        };
    },

    // ------------------------------------------------------------------------
    // DOM MANIPULATION: DEMAND TABLE
    // ------------------------------------------------------------------------

    /**
     * Renders the HTML table for editing Weekly Demand Probabilities.
     * This function populates the HTML table with rows for each element in the
     * global orderState.params.demandDist array. Each row contains:
     * - A text input for the quantity (qty) of the demand distribution.
     * - A number input for the probability (prob) of the demand distribution.
     * - A button to remove the row from the demand distribution.
     */
    renderDemandTable() {
        // Find the table body (tbody) for the demand distribution
        const tbody = document.getElementById('demandDistBody');
        // If the table body does not exist, exit function
        if (!tbody) return;

        // Clear any existing rows in the table body
        tbody.innerHTML = '';

        // For each demand distribution element, create a row in the table
        window.orderState.params.demandDist.forEach((d, i) => {
            // Handle nulls gracefully for display (show blank input)
            const qVal = (d.qty !== null && d.qty !== undefined) ? d.qty : '';
            const pVal = (d.prob !== null && d.prob !== undefined) ? d.prob : '';

            // Construct the HTML row for the demand distribution element
            tbody.innerHTML += `
                <tr>
                    <!-- Quantity (qty) input -->
                    <td>
                        <input
                            type="number"
                            value="${qVal}"
                            onchange="updateOrderDemand(${i}, 'qty', this.value)"
                            style="width:100%; text-align:center;"
                            placeholder="-"
                        >
                    </td>
                    <!-- Probability (prob) input -->
                    <td>
                        <input
                            type="number"
                            value="${pVal}"
                            onchange="updateOrderDemand(${i}, 'prob', this.value)"
                            step="0.01"
                            style="width:100%; text-align:center;"
                            placeholder="-"
                        >
                    </td>
                    <!-- Remove button -->
                    <td>
                        <button
                            class="btn btn-secondary"
                            style="padding:2px 8px;"
                            onclick="window.OrdersModule.removeDemandRow(${i})"
                        >
                            ×
                        </button>
                    </td>
                </tr>`;
        });
    },

    /**
     * Removes a row from the demand distribution and re-solves.
     * This function is called when the user clicks the 'Remove Row' button in the UI.
     * It removes the object at the specified index from the 'demandDist' array in the
     * global orderState.params object. The function then calls the renderDemandTable
     * function to update the HTML table for editing Weekly Demand Probabilities.
     * 
     * After updating the demand distribution, the function calls the requestSolve
     * function to trigger a re-solve of the simulation with the updated demand
     * distribution. Since the user has just removed a row, they must fill in the
     * demand for that row, so the simulation is not solved until after they make
     * that change.
     * @param {number} index - The index of the row to remove from the demand distribution.
     */
    removeDemandRow(index) {
        window.orderState.params.demandDist.splice(index, 1); // Remove the object at the index from the demandDist array
        this.renderDemandTable(); // Update the HTML table for editing Weekly Demand Probabilities
        this.requestSolve(); // Trigger a re-solve of the simulation with the updated demand distribution
    },

    /**
     * Adds a blank row to the demand distribution.
     * This function is called when the user clicks the 'Add Row' button in the UI.
     * It adds a new object with null values for 'qty' and 'prob' to the 'demandDist'
     * array in the global orderState.params object. The function then calls the
     * renderDemandTable function to update the HTML table for editing Weekly Demand
     * Probabilities.
     * Since this function does not trigger a solve, the user must fill in the new row
     * before a solve will be triggered.
     * @return {void}
     */
    addDemandRow() {
        // Add a new object with null values for 'qty' and 'prob' to the demandDist array
        window.orderState.params.demandDist.push({ qty: null, prob: null });

        // Update the HTML table for editing Weekly Demand Probabilities
        this.renderDemandTable();
    },

    // ------------------------------------------------------------------------
    // WORKER COMMUNICATION & SOLVER LOGIC
    // ------------------------------------------------------------------------

    /**
     * Debounced Solver Request.
     * Validates data integrity (Probability Sum = 1.0) before calling the worker.
     * This method is called when the user clicks the 'Solve' button or
     * when the data changes (via the debounced requestSolve() method).
     * It performs the following steps:
     * 1. Identify the rows of the demand distribution that are filled with data.
     * 2. Validate that the probabilities of these rows sum up to 1.0.
     * 3. Queue the solve if the data is valid.
     */
    requestSolve() {
        // Clear pending requests to prevent UI flickering
        if (this.solveTimer) clearTimeout(this.solveTimer); // Cancel the previous timer if it's running

        // Filter: Only consider rows that have a quantity and probability assigned.
        const activeRows = window.orderState.params.demandDist.filter(d =>
            d.qty !== null && !isNaN(d.qty) && // If the quantity is not null and is a number
            d.prob !== null && !isNaN(d.prob) // If the probability is not null and is a number
        );

        // If no valid rows, abort. No need to validate or queue a solve.
        if (activeRows.length === 0) return;

        // Validate: Probabilities must sum to 1.0
        const sum = activeRows.reduce((a, b) => a + (b.prob || 0), 0); // Calculate the sum of the probabilities
        const isValid = Math.abs(sum - 1.0) < 0.00005; // Check if the sum is within a tolerance of 1.0

        // If the data is not valid, show an error message and chart
        if (!isValid) {
            updateStatus("Probabilities ≠ 1.0", "error"); // Update the status to indicate an error
            this.showErrorChart(`Current Sum: ${sum.toFixed(2)}. Active rows must sum to 1.0.`); // Show an error message and chart
            return; // Exit the function without queuing a solve
        }

        // Queue the Solve
        updateStatus("Changes Pending...", "waiting"); // Update the status to indicate pending changes
        this.solveTimer = setTimeout(() => this.executeSolve(activeRows), 200); // Schedule the solve to happen after a delay
    },

    /**
     * Spawns/Resets the Web Worker and sends the payload.
     * This function is called when the user clicks the 'Solve' button or
     * when the data changes (via the debounced requestSolve() method).
     *
     * @param {Array} validDist - The cleaned demand distribution array.
     * This is the input to the solver, and must be a valid array of objects
     * with 'qty' (quantity) and 'prob' (probability) properties.
     */
    executeSolve(validDist) {
        if (window.currentWorker) window.currentWorker.terminate();

        // Update the status to show that the solver is running
        updateStatus("Solving...", "solving");

        // Create a new Worker instance and point it to the 'ordersWorker.js' script
        window.currentWorker = new Worker('scripts/ordersWorker.js');

        // Construct the payload for the worker.
        const payload = { ...window.orderState.params, demandDist: validDist };
        window.currentWorker.postMessage(payload);

        // Define the message handler for the worker.
        window.currentWorker.onmessage = (e) => {
            // Destructure the message to get the status, result, and error.
            const { status, result, error } = e.data;

            // If the status is 'Optimal', we have a result
            if (status === 'Optimal') {
                // Store the result in the global state object
                window.orderState.results = result;

                if (!window.orderState.selectedPolicy) {
                    window.orderState.selectedPolicy = result.optimalPolicy;
                }

                // Update the UI to reflect the new global state object
                this.updateUI();

                // Update the status to show that the optimal policy was found
                updateStatus("Optimal Policy Found", "optimal");
            } else {
                // If there is an error, log it to the console
                console.error(error);

                // Update the status to show that there was an error
                updateStatus("Error", "error");
            }
        };
    },

    /**
     * Displays an error message inside the chart area. This is typically used to
     * show a user that there is an issue with the input, and that they should try
     * again. The message is styled to be easily visible to the user.
     *
     * @param {string} msg - The error message to display
     */
    showErrorChart(msg) {
        // Get the container element where the chart should be displayed
        const container = document.getElementById('steadyStateChart');
        // If the container exists, then update its contents to display the error message
        if (container) {
            // Create a single div that will hold the error message
            const errorDiv = document.createElement('div');
            // Set the contents of the div to display the error message in a styled way
            errorDiv.textContent = msg;
            // Set the CSS styles for the div to center the text and make it visible
            errorDiv.style.height = '100%';
            errorDiv.style.display = 'flex';
            errorDiv.style.alignItems = 'center';
            errorDiv.style.justifyContent = 'center';
            errorDiv.style.color = '#e74c3c'; // Use a bright, bold red
            errorDiv.style.fontWeight = 'bold'; // Make the text stand out
            errorDiv.style.textAlign = 'center'; // Center the text
            errorDiv.style.padding = '20px'; // Add some space around the text
            // Replace the chart with the error message
            container.innerHTML = '';
            container.appendChild(errorDiv);
        }
    },

    // ------------------------------------------------------------------------
    // VISUALIZATION CONTROLLER
    // ------------------------------------------------------------------------

    /**
     * The main method to refresh all visual elements based on current results.
     * This method calls the 'drawCharts' method which performs the following tasks:
     * 1. Redraws the Global Policy Analysis chart
     * 2. Redraws the Specific Policy Detail chart
     * This is useful when the results of the MILP optimization problem changes, such as
     * when the user clicks the refresh button or modifies a parameter.
     */
    updateUI() {
        // Performs the following tasks:
        // 1. Redraws the Global Policy Analysis chart
        // 2. Redraws the Specific Policy Detail chart
        this.drawCharts();
    },

    /**
     * Orchestrates the drawing of all D3 charts and the Scorecard.
     * 1. Render text-based metrics (such as total profit, expected revenue, etc.)
     * 2. Render Global Policy Analysis (using all evaluated policies)
     *    - The scatter plot visualizes the profitability of all policies
     *    - The heat map visualizes the profitability of all policies in a color grid
     * 3. Render Specific Policy Detail (Steady State Vector)
     *    - This chart visualizes the long-run probability of having 'x' items in stock for a specific policy
     */
    drawCharts() {
        // Get the results of the optimization run
        const res = window.orderState.results;

        // Determine which policy to visualize (User Selected vs Global Optimal)
        // If a policy was selected by the user, use it. Otherwise, fall back to the global optimal policy.
        const policy = window.orderState.selectedPolicy || res?.optimalPolicy;

        // If there are no results or no policy, we can't do anything, so exit.
        if (!res || !policy) return;

        // Render the text-based metrics (such as total profit, expected revenue, etc.)
        this.renderScorecard(policy);

        // Render the global policy analysis (using all evaluated policies)
        // The scatter plot visualizes the profitability of all policies
        this.drawScatterPlot(res.allPolicies, policy);


        // The heat map visualizes the profitability of all policies in a color grid
        this.drawHeatMap(res.allPolicies, policy);

        // Render the specific policy detail (Steady State Vector)
        const vec = policy.steadyState || res.optimalPolicy.steadyState;
        this.drawSteadyStateChart(vec);
    },

    /**
     * Updates the HTML text for Key Performance Indicators (KPIs)
     * based on a given policy.  The KPIs being updated are:
     * - Total Profit (sc_profit)
     * - Expected Revenue (sc_rev)
     * - Expected Holding Cost (sc_hold)
     * - Expected Order Cost (sc_ord)
     * - Expected Shortage Cost (sc_short)
     * - Policy Configuration (sc_config)
     * @param {Object} policy - The policy whose KPIs should be displayed
     */
    renderScorecard(policy) {
        // Format the currency for display
        const fmt = (v) => formatCurrency(v || 0);

        // Update Local Scorecard
        // Total Profit
        document.getElementById('sc_profit').textContent = fmt(policy.totalProfit);
        // Expected Revenue
        document.getElementById('sc_rev').textContent = fmt(policy.details?.expectedRevenue);
        // Expected Holding Cost
        document.getElementById('sc_hold').textContent = fmt(policy.details?.expectedHoldingCost);
        // Expected Order Cost
        document.getElementById('sc_ord').textContent = fmt(policy.details?.expectedOrderCost);
        // Expected Shortage Cost
        document.getElementById('sc_short').textContent = fmt(policy.details?.expectedShortageCost);
        // Policy Configuration
        document.getElementById('sc_config').textContent = `Q=${policy.Q}, R=${policy.R}`;

        // Update App-wide KPI display (if exists)
        const globalDisp = document.getElementById('globalObjDisplay');
        if (globalDisp) globalDisp.textContent = fmt(policy.totalProfit);
    },

    // ------------------------------------------------------------------------
    // D3 CHART: STEADY STATE INVENTORY
    // ------------------------------------------------------------------------

    /**
     * Renders a Bar Chart showing the long-run probability of having 'x' items in stock.
     * Features: Trims zero-probability tails, tooltips, and axis labels.
     *
     * @param {Array<number>} vec - Probability vector (index = inventory level)
     */
    drawSteadyStateChart(vec) {
        // Find the HTML container for the chart
        const container = document.getElementById('steadyStateChart');
        // If the container is not found, exit function
        if (!container) return;

        // Clear any previous content of the container
        container.innerHTML = '';

        // Set the margins for the chart
        const margin = { top: 20, right: 30, bottom: 60, left: 70 };
        // Calculate the available width and height for the chart
        const width = container.clientWidth - margin.left - margin.right;
        const height = container.clientHeight - margin.top - margin.bottom;

        // Create a new SVG element within the container
        const svg = d3.select(container).append("svg")
            // Set the SVG to fill the entire container
            .attr("width", container.clientWidth)
            .attr("height", container.clientHeight)
            // Add a group element for the chart content
            .append("g")
            // Set the position of the group element according to the margins
            .attr("transform", `translate(${margin.left},${margin.top})`);

        // Process the probability vector by adding an 'inv' (inventory level) property to each element
        const data = vec.map((p, i) => ({ inv: i, prob: p }));
        // Find the first and last non-zero probability elements
        const startIdx = data.findIndex(d => d.prob > 0.001);
        const endIdx = data.findLastIndex(d => d.prob > 0.001);
        // Calculate the start and end indices for the filtered data
        const safeStart = startIdx === -1 ? 0 : startIdx;
        const safeEnd = endIdx === -1 ? data.length - 1 : endIdx;
        // Filter the data to include only the elements within the safe range
        const filteredData = data.slice(safeStart, safeEnd + 1);

        // Calculate the maximum probability value
        const maxVal = d3.max(filteredData, d => d.prob) || 0;
        // Set the domain and range of the y-axis
        const yDomain = maxVal > 0 ? [0, maxVal * 1.1] : [0, 1];

        // Create a band scale for the x-axis
        const x = d3.scaleBand().range([0, width]).padding(0.1)
            .domain(filteredData.map(d => d.inv));
        // Create a linear scale for the y-axis
        const y = d3.scaleLinear().domain(yDomain).range([height, 0]);

        // Add the x-axis to the chart
        svg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x));
        // Add the y-axis to the chart
        svg.append("g").call(d3.axisLeft(y).ticks(5).tickFormat(d => `${Math.round(d * 100)}%`));

        // Add the x-axis label
        svg.append("text")
            .attr("class", "axis-label")
            .attr("x", width / 2).attr("y", height + 40)
            .style("text-anchor", "middle")
            .text("Inventory Level");

        // Add the y-axis label
        svg.append("text")
            .attr("class", "axis-label")
            .attr("transform", "rotate(-90)")
            .attr("y", -50).attr("x", -height / 2)
            .style("text-anchor", "middle")
            .text("Probability");

        // Add the bars representing the probabilities to the chart
        svg.selectAll(".bar")
            .data(filteredData)
            .enter().append("rect")
            .attr("class", "bar")
            .attr("x", d => x(d.inv))
            .attr("width", x.bandwidth())
            .attr("y", d => y(d.prob))
            .attr("height", d => Math.max(0, height - y(d.prob)))
            .attr("fill", "#3498db")
            // Show a tooltip when the mouse is over a bar
            .on("mouseover", (event, d) => {
                showTooltip(`<b>Inventory: ${d.inv}</b><br>Prob: ${(d.prob * 100).toFixed(2)}% Trucks`, event);
            })
            // Hide the tooltip when the mouse is out of a bar
            .on("mouseout", hideTooltip);
    },


    /**
     * Renders a Scatter Plot comparing Target Level (Q) vs Expected Profit.
     * The Scatter Plot shows the profit achieved for each policy with different
     * combinations of Target Level (Q) and Reorder Point (R).
     * Features:
     * - Dynamic Legend filtering: Users can hide specific Reorder Points (R) from
     *   the graph to focus on specific policies.
     * - Color coding by R: Each Reorder Point (R) is mapped to a color, which is
     *   used to color code the scatter points in the graph.
     * - Highlight selected policy: The currently selected policy is highlighted
     *   with a larger radius and a different color.
     * @param {Array} allData - List of all evaluated policies
     * @param {Object} selected - The currently selected policy
     */
    drawScatterPlot(allData, selected) {
        const container = document.getElementById('scatterContainer');
        // Check if the container element exists before proceeding
        if (!container) return;
        container.innerHTML = ''; // Manual Clear (D3 standard practice)

        // Filter Data: Show only Profitable policies & exclude hidden R values
        const profitableData = allData.filter(d => d.totalProfit >= 0);
        const visibleData = profitableData.filter(d => !window.orderState.hiddenRs.has(d.R));

        // Setup Dimensions
        const margin = { top: 20, right: 100, bottom: 60, left: 70 };
        const width = container.clientWidth - margin.left - margin.right;
        const height = container.clientHeight - margin.top - margin.bottom;

        // Create a new SVG element inside the container, sized to the dimensions calculated above
        const svg = d3.select(container).append("svg")
            .attr("width", container.clientWidth)
            .attr("height", container.clientHeight)
            .append("g")
            .attr("transform", `translate(${margin.left},${margin.top})`);

        // Set up the scale for the x-axis (Q)
        const x = d3.scaleLinear().domain([0, d3.max(allData, d => d.Q)]).range([0, width]);
        // Set up the scale for the y-axis (profitability)
        const yExtent = d3.extent(visibleData, d => d.totalProfit);
        const y = d3.scaleLinear().domain(yExtent).range([height, 0]).nice();

        // Extract distinct R values for Color Scale and Legend
        const visibleRs = [...new Set(profitableData.map(d => d.R))].sort((a, b) => a - b);
        // Create a color scale using the viridis sequential scale
        const color = d3.scaleSequential(d3.interpolateViridis).domain([0, d3.max(visibleRs)]);

        // Add the x-axis to the SVG
        svg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x));
        // Add the y-axis to the SVG
        svg.append("g").call(d3.axisLeft(y).tickFormat(d => `$${d / 1000}k`));

        // Add labels to the axes
        svg.append("text")
            .attr("class", "axis-label")
            .attr("x", width / 2).attr("y", height + 40)
            .style("text-anchor", "middle")
            .text("Target Level (Q)");

        svg.append("text")
            .attr("class", "axis-label")
            .attr("transform", "rotate(-90)")
            .attr("y", -55).attr("x", -height / 2)
            .style("text-anchor", "middle")
            .text("Expected Profit ($)");

        // Draw each scatter point on the graph
        svg.selectAll("circle")
            .data(visibleData)
            .enter().append("circle")
            .attr("cx", d => x(d.Q))
            .attr("cy", d => y(d.totalProfit))
            // Highlight selected node with larger radius
            .attr("r", d => (d.Q === selected.Q && d.R === selected.R) ? 8 : 5)
            .style("fill", d => color(d.R))
            .style("stroke", d => (d.Q === selected.Q && d.R === selected.R) ? "#e74c3c" : "#333")
            .style("stroke-width", d => (d.Q === selected.Q && d.R === selected.R) ? 3 : 1)
            .style("opacity", 0.8)
            .style("cursor", "pointer")
            .on("click", (event, d) => {
                // When a scatter point is clicked, set it as the selected policy
                window.orderState.selectedPolicy = d;
                this.updateUI(); // Trigger refresh to update Scorecard/Steady State
            })
            .on("mouseover", (event, d) => {
                // Show a tooltip with the policy Q/R and expected profit
                showTooltip(`<b>Q:${d.Q}, R:${d.R}</b><br>Profit: ${formatCurrency(d.totalProfit)}`, event);
            })
            .on("mouseout", hideTooltip);

        // Create a legend to show which Reorder Points (R) are visible
        const legend = svg.append("g").attr("transform", `translate(${width + 20}, 0)`);
        legend.append("text").text("Filter R:").attr("y", -5).attr("class", "legend-title");

        visibleRs.forEach((rVal, i) => {
            const isHidden = window.orderState.hiddenRs.has(rVal);
            const grp = legend.append("g")
                .attr("transform", `translate(0, ${i * 22})`)
                .attr("class", "legend-box")
                .on("click", () => {
                    // Toggle visibility state for this R value
                    if (isHidden) window.orderState.hiddenRs.delete(rVal);
                    else window.orderState.hiddenRs.add(rVal);
                    this.drawScatterPlot(allData, selected);
                });

            grp.append("rect").attr("width", 14).attr("height", 14)
                .attr("fill", isHidden ? "#ccc" : color(rVal))
                .attr("stroke", isHidden ? "#999" : "none");

            grp.append("text").attr("x", 20).attr("y", 12)
                .text(`R = ${rVal}`)
                .attr("class", "legend-label")
                .style("fill", isHidden ? "#999" : "#333");
        });
    },

    /**
     * Renders a Heat Map Grid (Q vs R).
     * The Heat Map Grid shows the profit achieved for each combination of Target Level (Q) and Reorder Point (R).
     * Features: Polylinear Color Scale to emphasize differences near optimality.
     * @param {Array} allData - List of all evaluated policies (each policy is an object with Q, R and totalProfit properties)
     * @param {Object} selected - The currently selected policy (an object with Q and R properties)
     */
    drawHeatMap(allData, selected) {
        const container = document.getElementById('heatMapContainer');
        if (!container) return; // If the container is not found, exit function
        container.innerHTML = '';

        // Define the space to be used for axes and labels
        const margin = { top: 20, right: 20, bottom: 60, left: 70 };

        // Calculate the space available for the chart
        const width = container.clientWidth - margin.left - margin.right;
        const height = container.clientHeight - margin.top - margin.bottom;

        // Create an SVG element that fills the available space
        const svg = d3.select(container).append("svg")
            .attr("width", container.clientWidth)
            .attr("height", container.clientHeight)
            .append("g")
            .attr("transform", `translate(${margin.left},${margin.top})`);

        // Calculate the mapping between data values and visual values
        const profitValues = allData.map(d => d.totalProfit);
        const maxP = d3.max(profitValues); // Maximum profit achieved
        const minP = d3.min(profitValues); // Minimum profit achieved

        // Create a color scale (a function that maps a value to a color)
        const color = d3.scaleLinear()
            .domain([minP, 0, maxP * 0.85, maxP]) // Define the mapping between values and colors
            .range(["#4a4a4a", "#f7f7f7", "#5dc9b6", "#1e3799"]) // Define the colors for each value
            .interpolate(d3.interpolateHcl); // Use a specific interpolation method

        // Calculate the unique Target Levels and Reorder Points used in allData
        const xDomain = Array.from(new Set(allData.map(d => d.Q))).sort((a, b) => a - b); // Target Levels
        const yDomain = Array.from(new Set(allData.map(d => d.R))).sort((a, b) => a - b); // Reorder Points

        // Create a scale for the X axis (Target Levels)
        const x = d3.scaleBand().range([0, width]).domain(xDomain).padding(0.05);
        // Create a scale for the Y axis (Reorder Points)
        const y = d3.scaleBand().range([height, 0]).domain(yDomain).padding(0.05);

        // Add the X axis to the chart
        svg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x));
        // Add the Y axis to the chart
        svg.append("g").call(d3.axisLeft(y));

        // Add labels to the axes
        svg.append("text")
            .attr("class", "axis-label")
            .attr("x", width / 2).attr("y", height + 40)
            .style("text-anchor", "middle")
            .text("Target Level (Q)");

        svg.append("text")
            .attr("class", "axis-label")
            .attr("transform", "rotate(-90)")
            .attr("y", -45).attr("x", -height / 2)
            .style("text-anchor", "middle")
            .text("Reorder Point (R)");

        // Create a cell for each policy
        svg.selectAll("rect").data(allData).enter().append("rect")
            .attr("x", d => x(d.Q)).attr("y", d => y(d.R))
            .attr("width", x.bandwidth()).attr("height", y.bandwidth())
            .style("fill", d => color(d.totalProfit)) // Color the cells based on profit
            .style("stroke", d => (d.Q === selected.Q && d.R === selected.R) ? "#e74c3c" : "none") // Highlight the selected cell
            .style("stroke-width", 3)
            .style("cursor", "pointer")
            .on("click", (event, d) => {
                window.orderState.selectedPolicy = d;
                this.updateUI();
            })
            .on("mouseover", (event, d) => {
                showTooltip(`<b>Q:${d.Q} | R:${d.R}</b><br>Profit: ${formatCurrency(d.totalProfit)}`, event);
            })
            .on("mouseout", hideTooltip);
    }
};
