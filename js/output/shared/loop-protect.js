/**
 * Creates a new LoopProtector object.
 *
 * @param callback: called whenever a loop takes more than <timeout>ms to complete.
 * @param mainTimeout: threshold time used while executing main program body
 * @param asyncTimeout: treshold time used during draw() and other callbacks
 * @constructor
 */
window.LoopProtector = function(callback, mainTimeout, asyncTimeout, reportLocation) {
    this.callback = callback || function () { };
    this.timeout = 200;
    this.branchStartTime = 0;
    this.loopCounts = {};
    this.reportLocation = reportLocation;

    this.loopBreak = esprima.parse("KAInfiniteLoopProtect()").body[0];

    // cache ASTs for function calls to KAInfiniteLoopSetTimeout
    if (mainTimeout) {
        this.setMainTimeout =
            esprima.parse(`KAInfiniteLoopSetTimeout(${mainTimeout})`).body[0];   
    }
    if (asyncTimeout) {
        this.setAsyncTimeout =
            esprima.parse(`KAInfiniteLoopSetTimeout(${asyncTimeout})`).body[0];   
    }

    this.KAInfiniteLoopProtect = this._KAInfiniteLoopProtect.bind(this);
    this.KAInfiniteLoopSetTimeout = this._KAInfiniteLoopSetTimeout.bind(this);
    
    visibly.onVisible(function () {
        this.visible = true;
        this.branchStartTime = 0;
    }.bind(this));

    visibly.onHidden(function () {
        this.visible = false;
    }.bind(this));

    this.visible = !visibly.hidden();
};

window.LoopProtector.prototype = {
    /**
     * Throws 'KA_INFINITE_LOOP' if the difference between the current time
     * and this.brancStartTime is greater than this.timeout.
     * 
     * The difference grows as long as this method is called synchronously.  As
     * soon as the current execution stack completes and the browser grabs the
     * next task off the event queue this.branchStartTime will be reset by the
     * timeout.
     * 
     * In order to use this correctly, you must add a reference to this function
     * to the global scope where the user code is being run.  See the exec()
     * method in pjs-output.js for an example of how to do this.
     * 
     * @private
     */
    // TODO(kevinb) add parameter for location information from the AST
    // TODO(kevinb) count how many times each this is called for each location from the AST
    _KAInfiniteLoopProtect: function (location) {
        if (location) {
            if (!this.loopCounts[location]) {
                this.loopCounts[location] = 0;
            }
            this.loopCounts[location] += 1;
        }
        let now = new Date().getTime();
        if (!this.branchStartTime) {
            this.branchStartTime = now;
            setTimeout(function () {
                this.branchStartTime = 0;
            }.bind(this), 0);
        } else if (now - this.branchStartTime > this.timeout) {
            if (this.visible) {
                // Determine which of KAInfiniteLoopProtect's callsites has 
                // the most calls.
                let max = 0;            // current max count
                let hotLocation = null; // callsite with most calls
                Object.keys(this.loopCounts).forEach(location => {
                    if (this.loopCounts[location] > max) {
                        max = this.loopCounts[location];
                        hotLocation = location;
                    }
                });
                if (hotLocation) {
                    hotLocation = JSON.parse(hotLocation);
                }
                this.callback(hotLocation);
                
                // TODO(kevinb): if we call the callback do we still need to throw?
                let error = new Error("KA_INFINITE_LOOP");
                if (this.reportLocation) {
                    error.location = hotLocation;
                }
                throw error;
            }
        }
    },
    
    _KAInfiniteLoopSetTimeout: function (timeout) {
        this.timeout = timeout;
        this.branchStartTime = 0;
    },

    riskyStatements: [
        "DoWhileStatement",
        "WhileStatement",
        "ForStatement",
        "FunctionExpression",
        "FunctionDeclaration"
    ],

    protectAst: function(ast) {
        if (this.riskyStatements.indexOf(ast.type) !== -1) {
            if (this.reportLocation) {
                let location = {
                    type: ast.type,
                    loc: ast.loc
                };
                ast.body.body.unshift({
                    "type": "ExpressionStatement",
                    "expression": {
                        "type": "CallExpression",
                        "callee": {
                            "type": "Identifier",
                            "name": "KAInfiniteLoopProtect"
                        },
                        "arguments": [
                            {
                                "type": "Literal",
                                "value": JSON.stringify(location)
                            }
                        ]
                    }
                });
            } else {
                ast.body.body.unshift(this.loopBreak);
            }
        }
        for (let prop in ast) {
            if (ast.hasOwnProperty(prop) && _.isObject(ast[prop])) {
                if (_.isArray(ast[prop])) {
                    _.each(ast[prop], this.protectAst.bind(this));
                } else {
                    this.protectAst(ast[prop]);
                }
            }
        }
    },
    
    protect: function (code) {
        let ast = esprima.parse(code, { loc: true });
        this.protectAst(ast);

        // Many pjs programs take a while to start up because they're generating
        // terrain or textures or whatever.  Instead of complaining about all of
        // those programs taking too long, we allow the main program body to take
        // a little longer to run.  We call KAInfiniteLoopSetTimeout and set
        // the timeout to mainTimeout just to reset the value when the program
        // is re-run.
        if (this.setMainTimeout) {
            ast.body.unshift(this.setMainTimeout);
        }
        
        // Any asynchronous calls such as mouseClicked() or calls to draw() 
        // should take much less time so that the app (and the browser) remain
        // responsive as the app is running so we call KAInfiniteLoopSetTimeout
        // at the end of main and set timeout to be asyncTimeout
        if (this.setAsyncTimeout) {
            ast.body.push(this.setAsyncTimeout);
        }
        return escodegen.generate(ast);
    }
};
