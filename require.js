/** vim: et:ts=4:sw=4:sts=4
 * @license RequireJS 0.15.0+ Copyright (c) 2010, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/jrburke/requirejs for details
 */
/*jslint plusplus: false */
/*global window: false, navigator: false, document: false, importScripts: false,
  jQuery: false, clearInterval: false, setInterval: false, self: false,
  setTimeout: false */
"use strict";

/*
TODO: make sure 0.15 fixes are in this branch.
*/

var require, define;
(function () {
    //Change this version number for each release.
    var version = "0.15.0+",
        commentRegExp = /(\/\*([\s\S]*?)\*\/|\/\/(.*)$)/mg,
        cjsRequireRegExp = /require\(["']([\w\-_\.\/]+)["']\)/g,
        ostring = Object.prototype.toString,
        ap = Array.prototype,
        aps = ap.slice,
        isBrowser = !!(typeof window !== "undefined" && navigator && document),
        isWebWorker = !isBrowser && typeof importScripts !== "undefined",
        //PS3 indicates loaded and complete, but need to wait for complete
        //specifically. Sequence is "loading", "loaded", execution,
        // then "complete". The UA check is unfortunate, but not sure how
        //to feature test w/o causing perf issues.
        readyRegExp = isBrowser && navigator.platform === 'PLAYSTATION 3' ?
                      /^complete$/ : /^(complete|loaded)$/,
        defContextName = "_",
        empty = {},
        contexts = {},
        globalDefQueue = [],
        interactiveScript = null,
        isDone = false,
        useInteractive = false,
        req, cfg, currentlyAddingScript, s, head, baseElement, scripts, script,
        rePkg, src, m, dataMain, i, scrollIntervalId, setReadyState;

    function isFunction(it) {
        return ostring.call(it) === "[object Function]";
    }

    function isArray(it) {
        return ostring.call(it) === "[object Array]";
    }

    /**
     * Simple function to mix in properties from source into target,
     * but only if target does not already have a property of the same name.
     * This is not robust in IE for transferring methods that match
     * Object.prototype names, but the uses of mixin here seem unlikely to
     * trigger a problem related to that.
     */
    function mixin(target, source, force) {
        for (var prop in source) {
            if (!(prop in empty) && (!(prop in target) || force)) {
                target[prop] = source[prop];
            }
        }
        return req;
    }

    /**
     * Used to set up package paths from a packagePaths or packages config object.
     * @param {Object} packages the object to store the new package config
     * @param {Array} currentPackages an array of packages to configure
     * @param {String} [dir] a prefix dir to use.
     */
    function configurePackageDir(packages, currentPackages, dir) {
        var i, location, pkgObj;
        for (i = 0; (pkgObj = currentPackages[i]); i++) {
            pkgObj = typeof pkgObj === "string" ? { name: pkgObj } : pkgObj;
            location = pkgObj.location;

            //Add dir to the path, but avoid paths that start with a slash
            //or have a colon (indicates a protocol)
            if (dir && (!location || (location.indexOf("/") !== 0 && location.indexOf(":") === -1))) {
                pkgObj.location = dir + "/" + (pkgObj.location || pkgObj.name);
            }

            //Normalize package paths.
            pkgObj.location = pkgObj.location || pkgObj.name;
            pkgObj.lib = pkgObj.lib || "lib";
            pkgObj.main = pkgObj.main || "main";

            packages[pkgObj.name] = pkgObj;
        }
    }

    //Check for an existing version of require. If so, then exit out. Only allow
    //one version of require to be active in a page. However, allow for a require
    //config object, just exit quickly if require is an actual function.
    if (typeof require !== "undefined") {
        if (isFunction(require)) {
            return;
        } else {
            //assume it is a config object.
            cfg = require;
        }
    }

    /**
     * Creates a new context for use in require and define calls.
     * Handle most of the heavy lifting. Do not want to use an object
     * with prototype here to avoid using "this" in require, in case it
     * needs to be used in more super secure envs that do not want this.
     * Also there should not be that many contexts in the page. Usually just
     * one for the default context, but could be extra for multiversion cases
     * or if a package needs a special context for a dependency that conflicts
     * with the standard context.
     */
    function newContext(contextName) {
        var config = {}, context, defQueue = [], paused = [], load;

        /**
         * Given a relative module name, like ./something, normalize it to
         * a real name that can be mapped to a path.
         * @param {String} name the relative name
         * @param {String} baseName a real name that the name arg is relative
         * to.
         * @returns {String} normalized name
         */
        function normalizeName(name, baseName) {
            //Adjust any relative paths.
            var part, i;
            if (name.charAt(0) === ".") {
                //If have a base name, try to normalize against it,
                //otherwise, assume it is a top-level require that will
                //be relative to baseUrl in the end.
                if (baseName) {
                    if (context.config.packages[baseName]) {
                        //If the baseName is a package name, then just treat it as one
                        //name to concat the name with.
                        baseName = [baseName];
                    } else {
                        //Convert baseName to array, and lop off the last part,
                        //so that . matches that "directory" and not name of the baseName's
                        //module. For instance, baseName of "one/two/three", maps to
                        //"one/two/three.js", but we want the directory, "one/two" for
                        //this normalization.
                        baseName = baseName.split("/");
                        baseName = baseName.slice(0, baseName.length - 1);
                    }

                    name = baseName.concat(name.split("/"));
                    for (i = 0; (part = name[i]); i++) {
                        if (part === ".") {
                            name.splice(i, 1);
                            i -= 1;
                        } else if (part === "..") {
                            name.splice(i - 1, 2);
                            i -= 2;
                        }
                    }
                    name = name.join("/");
                }
            }
            return name;
        }

        /**
         * Splits a name into a possible plugin prefix and
         * the module name. If baseName is provided it will
         * also normalize the name via require.normalizeName()
         * 
         * @param {String} name the module name
         * @param {String} [baseName] base name that name is
         * relative to.
         *
         * @returns {Object} with properties, 'prefix' (which
         * may be null), 'name' and 'fullName', which is a combination
         * of the prefix (if it exists) and the name.
         */
        function splitPrefix(name, baseName) {
            var index = name.indexOf("!"), prefix = null;
            if (index !== -1) {
                prefix = name.substring(0, index);
                name = name.substring(index + 1, name.length);
            }
    
            //Account for relative paths if there is a base name.
            name = normalizeName(name, baseName);
    
            return {
                prefix: prefix,
                name: name,
                fullName: prefix ? prefix + "!" + name : name
            };
        }

        /**
         * Determine if priority loading is done. If so clear the priorityWait
         */
        function isPriorityDone() {
            var priorityDone = true,
                priorityWait = config.priorityWait,
                priorityName, i;
            if (priorityWait) {
                for (i = 0; (priorityName = priorityWait[i]); i++) {
                    if (!context.loaded[priorityName]) {
                        priorityDone = false;
                        break;
                    }
                }
                if (priorityDone) {
                    delete config.priorityWait;
                }
            }
            return priorityDone;
        }

        /**
         * As of jQuery 1.4.3, it supports a readyWait property that will hold off
         * calling jQuery ready callbacks until all scripts are loaded. Be sure
         * to track it if readyWait is available. Also, since jQuery 1.4.3 does
         * not register as a module, need to do some global inference checking.
         * Even if it does register as a module, not guaranteed to be the precise
         * name of the global. If a jQuery is tracked for this context, then go
         * ahead and register it as a module too, if not already in process.
         */
        function jQueryCheck(jqCandidate) {
            if (!context.jQuery) {
                var $ = jqCandidate || (typeof jQuery !== "undefined" ? jQuery : null);
                if ($ && "readyWait" in $) {
                    context.jQuery = $;
    
                    //Manually create a "jquery" module entry if not one already
                    //or in process.
                    if (!context.defined.jquery && !context.jQueryDef) {
                        context.defined.jquery = $;
                    }
    
                    //Increment jQuery readyWait if ncecessary.
                    if (context.scriptCount) {
                        $.readyWait += 1;
                        context.jQueryIncremented = true;
                    }
                }
            }
        }

        function main(name, deps, callback, relModuleName) {
            //Grab the context, or create a new one for the given context name.
            var loaded, pluginPrefix,
                canSetContext, prop, newLength, outDeps, mods, paths, index, i,
                deferMods, deferModArgs, lastModArg, waitingName, packages,
                packagePaths;

            if (name) {
                //>>excludeStart("requireExcludePlugin", pragmas.requireExcludePlugin);
                // Pull off any plugin prefix.
                index = name.indexOf("!");
                if (index !== -1) {
                    pluginPrefix = name.substring(0, index);
                    name = name.substring(index + 1, name.length);
                } else {
                    //Could be that the plugin name should be auto-applied.
                    //Used by i18n plugin to enable anonymous i18n modules, but
                    //still associating the auto-generated name with the i18n plugin.
                    pluginPrefix = context.defPlugin[name];
                }
                //>>excludeEnd("requireExcludePlugin");
    
                //If module already defined for context, or already waiting to be
                //evaluated, leave.
                waitingName = context.waiting[name];
                if (context.defined[name] || (waitingName && waitingName !== ap[name])) {
                    return;
                }
            }
    
            //Normalize dependency strings: need to determine if they have
            //prefixes and to also normalize any relative paths. Replace the deps
            //array of strings with an array of objects.
            if (deps) {
                outDeps = deps;
                deps = [];
                for (i = 0; i < outDeps.length; i++) {
                    deps[i] = splitPrefix(outDeps[i], (name || relModuleName));
                }
            }

            //Store the module for later evaluation
            newLength = context.waiting.push({
                name: name,
                deps: deps,
                callback: callback
            });

            if (name) {
                //Store index of insertion for quick lookup
                context.waiting[name] = newLength - 1;
    
                //Mark the module as specified so no need to fetch it again.
                //Important to set specified here for the
                //pause/resume case where there are multiple modules in a file.
                context.specified[name] = true;
    
                //TODO: some modifier work here?
            }

            //If the callback is not an actual function, it means it already
            //has the definition of the module as a literal value.
            if (name && callback && !isFunction(callback)) {
                context.defined[name] = callback;
            }
    
            //If a pluginPrefix is available, call the plugin, or load it.
            //>>excludeStart("requireExcludePlugin", pragmas.requireExcludePlugin);
            if (pluginPrefix) {
                callPlugin(pluginPrefix, context, {
                    name: "require",
                    args: [name, deps, callback, context]
                });
            }
            //>>excludeEnd("requireExcludePlugin");
    
            //Hold on to the module until a script load or other adapter has finished
            //evaluating the whole file. This helps when a file has more than one
            //module in it -- dependencies are not traced and fetched until the whole
            //file is processed.
            paused.push([pluginPrefix, name, deps, context]);
    
            //Set loaded here for modules that are also loaded
            //as part of a layer, where onScriptLoad is not fired
            //for those cases. Do this after the inline define and
            //dependency tracing is done.
            //Also check if auto-registry of jQuery needs to be skipped.
            if (name) {
                context.loaded[name] = true;
                context.jQueryDef = (name === "jquery");
            }
        }

        /**
         * Convenience method to call main for a require.def call that was put on
         * hold in the defQueue.
         */
        function callDefMain(args) {
            main.apply(null, args);
            //Mark the module loaded. Must do it here in addition
            //to doing it in require.def in case a script does
            //not call require.def
            context.loaded[args[0]] = true;
        }

        /**
         * Trace down the dependencies to see if they are loaded. If not, trigger
         * the load.
         * @param {String} pluginPrefix the plugin prefix, if any associated with the name.
         * @param {String} name: the name of the module that has the dependencies.
         * @param {Array} deps array of dependencies.
         */
        function checkDeps(pluginPrefix, name, deps) {
            //Figure out if all the modules are loaded. If the module is not
            //being loaded or already loaded, add it to the "to load" list,
            //and request it to be loaded.
            var i, dep;

            if (pluginPrefix) {
                //>>excludeStart("requireExcludePlugin", pragmas.requireExcludePlugin);
                callPlugin(pluginPrefix, {
                    name: "checkDeps",
                    args: [name, deps]
                });
                //>>excludeEnd("requireExcludePlugin");
            } else {
                for (i = 0; (dep = deps[i]); i++) {
                    if (!context.specified[dep.fullName]) {
                        context.specified[dep.fullName] = true;

                        //Reset the start time to use for timeouts
                        context.startTime = (new Date()).getTime();

                        //If a plugin, call its load method.
                        if (dep.prefix) {
                            //>>excludeStart("requireExcludePlugin", pragmas.requireExcludePlugin);
                            callPlugin(dep.prefix, {
                                name: "load",
                                args: [dep.name]
                            });
                            //>>excludeEnd("requireExcludePlugin");
                        } else {
                            load(dep.name);
                        }
                    }
                }
            }
        }

        /**
         * Resumes tracing of dependencies and then checks if everything is loaded.
         */
        function resume() {
            var args, i;
            if (context.scriptCount <= 0) {
                //Synchronous envs will push the number below zero with the
                //decrement above, be sure to set it back to zero for good measure.
                //require() calls that also do not end up loading scripts could
                //push the number negative too.
                context.scriptCount = 0;

                //Make sure any remaining defQueue items get properly processed.
                while (defQueue.length) {
                    args = defQueue.shift();
                    if (args[0] === null) {
                        return req.onError(new Error('Mismatched anonymous require.def modules'));
                    } else {
                        callDefMain(args);
                    }
                }

                //Skip the resume if current context is in priority wait.
                if (config.priorityWait && !isPriorityDone()) {
                    return undefined;
                }

                if (paused.length) {
                    for (i = 0; (args = paused[i]); i++) {
                        checkDeps.apply(null, args);
                    }
                }

                checkLoaded();
            }
            return undefined;
        }

        //Define the context object.
        context = {
            contextName: contextName,
            config: config,
            defQueue: defQueue,
            waiting: [],
            specified: {
                "require": true,
                "exports": true,
                "module": true
            },
            loaded: {},
            scriptCount: 0,
            urlFetched: {},
            defPlugin: {},
            defined: {},
            //>>excludeStart("requireExcludePlugin", pragmas.requireExcludePlugin);
            plugins: {
                defined: {},
                callbacks: {},
                waiting: {}
            },
            //>>excludeEnd("requireExcludePlugin");
            modifiers: {},
            /**
             * Set a configuration for the context.
             * @param {Object} cfg config object to integrate.
             */
            configure: function (cfg) {
                var paths, packages, prop, packagePaths;

                //Make sure the baseUrl ends in a slash.
                if (cfg.baseUrl) {
                    if (cfg.baseUrl.charAt(cfg.baseUrl.length - 1) !== "/") {
                        cfg.baseUrl += "/";
                    }
                }
    
                //Save off the paths and packages since they require special processing,
                //they are additive.
                paths = config.paths;
                packages = config.packages;
    
                //Mix in the config values, favoring the new values over
                //existing ones in context.config.
                mixin(config, cfg, true);
    
                //Adjust paths if necessary.
                if (cfg.paths) {
                    for (prop in cfg.paths) {
                        if (!(prop in empty)) {
                            paths[prop] = cfg.paths[prop];
                        }
                    }
                    config.paths = paths;
                }
    
                packagePaths = cfg.packagePaths;
                if (packagePaths || cfg.packages) {
                    //Convert packagePaths into a packages config.
                    if (packagePaths) {
                        for (prop in packagePaths) {
                            if (!(prop in empty)) {
                                configurePackageDir(packages, packagePaths[prop], prop);
                            }
                        }
                    }
    
                    //Adjust packages if necessary.
                    if (cfg.packages) {
                        configurePackageDir(packages, cfg.packages);
                    }
    
                    //Done with modifications, assing packages back to context config
                    config.packages = packages;
                }

                //If priority loading is in effect, trigger the loads now
                if (cfg.priority) {
                    //Create a separate config property that can be
                    //easily tested for config priority completion.
                    //Do this instead of wiping out the config.priority
                    //in case it needs to be inspected for debug purposes later.
                    context.require(cfg.priority);
                    config.priorityWait = cfg.priority;
                }

                //If a deps array or a config callback is specified, then call
                //require with those args. This is useful when require is defined as a
                //config object before require.js is loaded.
                if (cfg.deps || cfg.callback) {
                    context.require(cfg.deps || [], cfg.callback);
                }

                //Set up ready callback, if asked. Useful when require is defined as a
                //config object before require.js is loaded.
                if (cfg.ready) {
                    req.ready(cfg.ready);
                }
            },

            require: function (deps, callback, relModuleName) {
                var moduleName, ret;
                if (typeof deps === "string") {
                    //Just return the module wanted. In this scenario, the
                    //second arg (if passed) is just the relModuleName.
                    relModuleName = callback;
                    if (moduleName === "require" ||
                        moduleName === "exports" || moduleName === "module") {
                        return req.onError(new Error("Explicit require of " +
                                           moduleName + " is not allowed."));
                    }
           
                    //Normalize module name, if it contains . or ..
                    moduleName = normalizeName(moduleName, relModuleName);

                    ret = context.defined[moduleName];
                    if (ret === undefined) {
                        return req.onError(new Error("require: module name '" +
                                    moduleName +
                                    "' has not been loaded yet for context: " +
                                    contextName));
                    }
                    return ret;
                }

                main(null, deps, callback, relModuleName);

                //If the require call does not trigger anything new to load,
                //then resume the dependency processing.
                if (!context.scriptCount) {
                    resume();
                }
                return undefined;
            },

            /**
             * Internal method used by environment adapters to complete a load event.
             * A load event could be a script load or just a load pass from a synchronous
             * load call.
             * @param {String} moduleName the name of the module to potentially complete.
             */
            completeLoad: function (moduleName) {
                //If there is a waiting require.def call
                var args;
                while (defQueue.length) {
                    args = defQueue.shift();
                    if (args[0] === null) {
                        args[0] = moduleName;
                        break;
                    } else if (args[0] === moduleName) {
                        //Found matching require.def call for this script!
                        break;
                    } else {
                        //Some other named require.def call, most likely the result
                        //of a build layer that included many require.def calls.
                        callDefMain(args);
                    }
                }
                if (args) {
                    callDefMain(args);
                }
        
                //Mark the script as loaded. Note that this can be different from a
                //moduleName that maps to a require.def call. This line is important
                //for traditional browser scripts.
                context.loaded[moduleName] = true;
        
                //If a global jQuery is defined, check for it. Need to do it here
                //instead of main() since stock jQuery does not register as
                //a module via define.
                jQueryCheck();
        
                context.scriptCount -= 1;
                resume();
            },

            /**
             * Converts a module name to a file path.
             */
            nameToUrl: function (moduleName, ext, relModuleName) {
                var paths, packages, pkg, pkgPath, syms, i, parentModule, url,
                    config = context.config;

                //Normalize module name if have a base relative module name to work from.
                moduleName = normalizeName(moduleName, relModuleName);

                //If a colon is in the URL, it indicates a protocol is used and it is just
                //an URL to a file, or if it starts with a slash or ends with .js, it is just a plain file.
                //The slash is important for protocol-less URLs as well as full paths.
                if (moduleName.indexOf(":") !== -1 || moduleName.charAt(0) === '/' || req.jsExtRegExp.test(moduleName)) {
                    //Just a plain path, not module name lookup, so just return it.
                    //Add extension if it is included. This is a bit wonky, only non-.js things pass
                    //an extension, this method probably needs to be reworked.
                    url = moduleName + (ext ? ext : "");
                } else {
                    //A module that needs to be converted to a path.
                    paths = config.paths;
                    packages = config.packages;
        
                    syms = moduleName.split("/");
                    //For each module name segment, see if there is a path
                    //registered for it. Start with most specific name
                    //and work up from it.
                    for (i = syms.length; i > 0; i--) {
                        parentModule = syms.slice(0, i).join("/");
                        if (paths[parentModule]) {
                            syms.splice(0, i, paths[parentModule]);
                            break;
                        } else if ((pkg = packages[parentModule])) {
                            //pkg can have just a string value to the path
                            //or can be an object with props:
                            //main, lib, name, location.
                            pkgPath = pkg.location + '/' + pkg.lib;
                            //If module name is just the package name, then looking
                            //for the main module.
                            if (moduleName === pkg.name) {
                                pkgPath += '/' + pkg.main;
                            }
                            syms.splice(0, i, pkgPath);
                            break;
                        }
                    }

                    //Join the path parts together, then figure out if baseUrl is needed.
                    url = syms.join("/") + (ext || ".js");
                    url = (url.charAt(0) === '/' || url.match(/^\w+:/) ? "" : config.baseUrl) + url;
                }
                return config.urlArgs ? url +
                                        ((url.indexOf('?') === -1 ? '?' : '&') +
                                         config.urlArgs) : url;
            }
        };

        //Make these visible on the context so can be called at the very
        //end of the file to bootstrap
        context.jQueryCheck = jQueryCheck;
        context.resume = resume;

        load = req.makeLoad(context);

        return context;
    }

    /**
     * Main entry point.
     *
     * If the only argument to require is a string, then the module that
     * is represented by that string is fetched for the appropriate context.
     *
     * If the first argument is an array, then it will be treated as an array
     * of dependency string names to fetch. An optional function callback can
     * be specified to execute when all of those dependencies are available.
     *
     * Make a local req variable to help Caja compliance (it assumes things
     * on a require that are not standardized), and to give a short
     * name for minification/local scope use.
     */
    req = require = function (deps, callback) {

        //Find the right context, use default
        var contextName = defContextName,
            context, config;

        // Determine if have config object in the call.
        if (!isArray(deps)) {
            // deps is a config object
            config = deps;
            if (isArray(callback)) {
                // Adjust args if there are dependencies
                deps = callback;
                callback = arguments[2];
            } else {
                deps = [];
            }
        }

        if (config && config.context) {
            contextName = config.context;
        }

        context = contexts[contextName] ||
                  (contexts[contextName] = newContext(contextName));

        if (config) {
            context.configure(config);
        }

        context.require(deps, callback);
    };

    req.version = version;
    req.isArray = isArray;
    req.isFunction = isFunction;
    req.mixin = mixin;
    //Used to filter out dependencies that are already paths.
    req.jsExtRegExp = /\.js$/;
    s = req.s = {
        contexts: contexts,
        //Stores a list of URLs that should not get async script tag treatment.
        skipAsync: {},
        isBrowser: isBrowser,
        isPageLoaded: !isBrowser,
        readyCalls: [],
        doc: isBrowser ? document : null
    };

    req.isBrowser = s.isBrowser;
    if (isBrowser) {
        head = s.head = document.getElementsByTagName("head")[0];
        //If BASE tag is in play, using appendChild is a problem for IE6.
        //When that browser dies, this can be removed. Details in this jQuery bug:
        //http://dev.jquery.com/ticket/2709
        baseElement = document.getElementsByTagName("base")[0];
        if (baseElement) {
            head = s.head = baseElement.parentNode;
        }
    }

    /**
     * Any errors that require explicitly generates will be passed to this
     * function. Intercept/override it if you want custom error handling.
     * @param {Error} err the error object.
     */
    req.onError = function (err) {
        throw err;
    };

    /**
     * Creates a function that does the loading of the file that maps
     * to a module. Make this a separate function to allow other environments
     * to override it.
     * @param {Object} context the context to use for this load function.
     */
    req.makeLoad = function (context) {

        /**
         * Does the request to load a module for the browser case.
         * 
         * @param {String} moduleName the name of the module.
         */
        return function (moduleName) {
            var contextName = context.contextName,
                urlFetched = context.urlFetched,
                loaded = context.loaded, url;
            isDone = false;

            //Only set loaded to false for tracking if it has not already been set.
            if (!loaded[moduleName]) {
                loaded[moduleName] = false;
            }

            //First derive the path name for the module.
            url = context.nameToUrl(moduleName);
            if (!urlFetched[url]) {
                context.scriptCount += 1;
                req.attach(url, contextName, moduleName);
                urlFetched[url] = true;

                //If tracking a jQuery, then make sure its readyWait
                //is incremented to prevent its ready callbacks from
                //triggering too soon.
                if (context.jQuery && !context.jQueryIncremented) {
                    context.jQuery.readyWait += 1;
                    context.jQueryIncremented = true;
                }
            }
        };
    };

    function getInteractiveScript() {
        var scripts, i, script;
        if (interactiveScript && interactiveScript.readyState === 'interactive') {
            return interactiveScript;
        }

        scripts = document.getElementsByTagName('script');
        for (i = scripts.length - 1; i > -1 && (script = scripts[i]); i--) {
            if (script.readyState === 'interactive') {
                return (interactiveScript = script);
            }
        }
        return null;
    }

    /**
     * The function that handles definitions of modules. Differs from
     * require() in that a string for the module should be the first argument,
     * and the function to execute after dependencies are loaded should
     * return a value to define the module corresponding to the first argument's
     * name.
     */
    define = req.def = function (name, deps, callback) {
        var i, scripts, script, node = currentlyAddingScript, args, context;

        //Allow for anonymous functions
        if (typeof name !== 'string') {
            //Adjust args appropriately
            callback = deps;
            deps = name;
            name = null;
        }

        //This module may not have dependencies
        if (!req.isArray(deps)) {
            callback = deps;
            deps = [];
        }

        //If no name, and callback is a function, then figure out if it a
        //CommonJS thing with dependencies.
        if (!name && !deps.length && req.isFunction(callback)) {
            //Remove comments from the callback string,
            //look for require calls, and pull them into the dependencies.
            callback
                .toString()
                .replace(commentRegExp, "")
                .replace(cjsRequireRegExp, function (match, dep) {
                    deps.push(dep);
                });

            //May be a CommonJS thing even without require calls, but still
            //could use exports, and such, so always add those as dependencies.
            //This is a bit wasteful for RequireJS modules that do not need
            //an exports or module object, but erring on side of safety.
            //REQUIRES the function to expect the CommonJS variables in the
            //order listed below.
            deps = ["require", "exports", "module"].concat(deps);
        }

        //If in IE 6-8 and hit an anonymous define() call, do the interactive
        //work.
        if (useInteractive) {
            if (!name) {
                node = getInteractiveScript();
                if (!node) {
                    return req.onError(new Error("ERROR: No matching script interactive for " + callback));
                }

                name = node.getAttribute("data-requiremodule");
            }
            context = contexts[node.getAttribute("data-requirecontext")];
        }

        //Always save off evaluating the def call until the script onload handler.
        //This allows multiple modules to be in a file without prematurely
        //tracing dependencies, and allows for anonymous module support,
        //where the module name is not known until the script onload event
        //occurs. If no context, use the global queue, and get it processed
        //in the onscript load callback.
        (context ? context.defQueue : globalDefQueue).push([name, deps, callback]);

        return undefined;
    };

    /**
     * callback for script loads, used to check status of loading.
     *
     * @param {Event} evt the event from the browser for the script
     * that was loaded.
     *
     * @private
     */
    req.onScriptLoad = function (evt) {
        //Using currentTarget instead of target for Firefox 2.0's sake. Not
        //all old browsers will be supported, but this one was easy enough
        //to support and still makes sense.
        var node = evt.currentTarget || evt.srcElement, contextName, moduleName,
            context, args;

        if (evt.type === "load" || readyRegExp.test(node.readyState)) {
            //Reset interactive script so a script node is not held onto for
            //to long.
            interactiveScript = null;

            //Pull out the name of the module and the context.
            contextName = node.getAttribute("data-requirecontext");
            moduleName = node.getAttribute("data-requiremodule");
            context = contexts[moduleName];

            //Push all the globalDefQueue items into the context's defQueue
            if (globalDefQueue.length) {
                args = [context.defQueue.length - 1, 0].concat(globalDefQueue);
                aps.apply(context.defQueue, args);
                globalDefQueue = [];
            }

            contexts[contextName].completeLoad(moduleName);

            //Clean up script binding.
            if (node.removeEventListener) {
                node.removeEventListener("load", req.onScriptLoad, false);
            } else {
                //Probably IE. If not it will throw an error, which will be
                //useful to know.
                node.detachEvent("onreadystatechange", req.onScriptLoad);
            }
        }
    };

    /**
     * Attaches the script represented by the URL to the current
     * environment. Right now only supports browser loading,
     * but can be redefined in other environments to do the right thing.
     * @param {String} url the url of the script to attach.
     * @param {String} contextName the name of the context that wants the script.
     * @param {moduleName} the name of the module that is associated with the script.
     * @param {Function} [callback] optional callback, defaults to require.onScriptLoad
     * @param {String} [type] optional type, defaults to text/javascript
     */
    req.attach = function (url, contextName, moduleName, callback, type) {
        var node, loaded, context;
        if (isBrowser) {
            //In the browser so use a script tag
            callback = callback || req.onScriptLoad;
            node = document.createElement("script");
            node.type = type || "text/javascript";
            node.charset = "utf-8";
            //Use async so Gecko does not block on executing the script if something
            //like a long-polling comet tag is being run first. Gecko likes
            //to evaluate scripts in DOM order, even for dynamic scripts.
            //It will fetch them async, but only evaluate the contents in DOM
            //order, so a long-polling script tag can delay execution of scripts
            //after it. But telling Gecko we expect async gets us the behavior
            //we want -- execute it whenever it is finished downloading. Only
            //Helps Firefox 3.6+
            //Allow some URLs to not be fetched async. Mostly helps the order!
            //plugin
            if (!req.s.skipAsync[url]) {
                node.async = true;
            }
            node.setAttribute("data-requirecontext", contextName);
            node.setAttribute("data-requiremodule", moduleName);

            //Set up load listener.
            if (node.addEventListener) {
                node.addEventListener("load", callback, false);
            } else {
                //Probably IE. If not it will throw an error, which will be
                //useful to know. IE (at least 6-8) do not fire
                //script onload right after executing the script, so
                //we cannot tie the anonymous require.def call to a name.
                //However, IE reports the script as being in "interactive"
                //readyState at the time of the require.def call.
                useInteractive = true;
                node.attachEvent("onreadystatechange", callback);
            }
            node.src = url;

            //For some cache cases in IE 6-8, the script executes before the end
            //of the appendChild execution, so to tie an anonymous require.def
            //call to the module name (which is stored on the node), hold on
            //to a reference to this node, but clear after the DOM insertion.
            currentlyAddingScript = node;
            if (baseElement) {
                head.insertBefore(node, baseElement);
            } else {
                head.appendChild(node);
            }
            currentlyAddingScript = null;
            return node;
        } else if (isWebWorker) {
            //In a web worker, use importScripts. This is not a very
            //efficient use of importScripts, importScripts will block until
            //its script is downloaded and evaluated. However, if web workers
            //are in play, the expectation that a build has been done so that
            //only one script needs to be loaded anyway. This may need to be
            //reevaluated if other use cases become common.
            context = contexts[contextName];
            loaded = context.loaded;
            loaded[moduleName] = false;

            importScripts(url);

            //Account for anonymous modules
            context.completeLoad(moduleName);
        }
        return null;
    };


    //Determine what baseUrl should be if not already defined via a require config object
    s.baseUrl = cfg.baseUrl;
    if (isBrowser && (!s.baseUrl || !head)) {
        //Figure out baseUrl. Get it from the script tag with require.js in it.
        scripts = document.getElementsByTagName("script");
        if (cfg.baseUrlMatch) {
            rePkg = cfg.baseUrlMatch;
        } else {
            //>>includeStart("jquery", pragmas.jquery);
            rePkg = /(requireplugins-|require-)?jquery[\-\d\.]*(min)?\.js(\W|$)/i;
            //>>includeEnd("jquery");

            //>>includeStart("dojoConvert", pragmas.dojoConvert);
            rePkg = /dojo\.js(\W|$)/i;
            //>>includeEnd("dojoConvert");

            //>>excludeStart("dojoConvert", pragmas.dojoConvert);

            //>>excludeStart("jquery", pragmas.jquery);
            rePkg = /(allplugins-)?require\.js(\W|$)/i;
            //>>excludeEnd("jquery");

            //>>excludeEnd("dojoConvert");
        }

        for (i = scripts.length - 1; i > -1 && (script = scripts[i]); i--) {
            //Set the "head" where we can append children by
            //using the script's parent.
            if (!head) {
                head = script.parentNode;
            }

            //Look for a data-main attribute to set main script for the page
            //to load.
            if (!cfg.deps) {
                dataMain = script.getAttribute('data-main');
                if (dataMain) {
                    cfg.deps = [dataMain];
                }
            }

            //Using .src instead of getAttribute to get an absolute URL.
            //While using a relative URL will be fine for script tags, other
            //URLs used for text! resources that use XHR calls might benefit
            //from an absolute URL.
            src = script.src;
            if (src && !s.baseUrl) {
                m = src.match(rePkg);
                if (m) {
                    s.baseUrl = src.substring(0, m.index);
                    break;
                }
            }
        }
    }

    //>>excludeStart("requireExcludePageLoad", pragmas.requireExcludePageLoad);
    //****** START page load functionality ****************
    /**
     * Sets the page as loaded and triggers check for all modules loaded.
     */
    req.pageLoaded = function () {
        if (!s.isPageLoaded) {
            s.isPageLoaded = true;
            if (scrollIntervalId) {
                clearInterval(scrollIntervalId);
            }

            //Part of a fix for FF < 3.6 where readyState was not set to
            //complete so libraries like jQuery that check for readyState
            //after page load where not getting initialized correctly.
            //Original approach suggested by Andrea Giammarchi:
            //http://webreflection.blogspot.com/2009/11/195-chars-to-help-lazy-loading.html
            //see other setReadyState reference for the rest of the fix.
            if (setReadyState) {
                document.readyState = "complete";
            }

            req.callReady();
        }
    };

    /**
     * Internal function that calls back any ready functions. If you are
     * integrating RequireJS with another library without require.ready support,
     * you can define this method to call your page ready code instead.
     */
    req.callReady = function () {
        var callbacks = s.readyCalls, i, callback, contexts, context, prop;

        if (s.isPageLoaded && s.isDone) {
            if (callbacks.length) {
                s.readyCalls = [];
                for (i = 0; (callback = callbacks[i]); i++) {
                    callback();
                }
            }

            //If jQuery with readyWait is being tracked, updated its
            //readyWait count.
            contexts = s.contexts;
            for (prop in contexts) {
                if (!(prop in empty)) {
                    context = contexts[prop];
                    if (context.jQueryIncremented) {
                        context.jQuery.readyWait -= 1;
                        context.jQueryIncremented = false;
                    }
                }
            }
        }
    };

    /**
     * Registers functions to call when the page is loaded
     */
    req.ready = function (callback) {
        if (s.isPageLoaded && s.isDone) {
            callback();
        } else {
            s.readyCalls.push(callback);
        }
        return req;
    };

    if (isBrowser) {
        if (document.addEventListener) {
            //Standards. Hooray! Assumption here that if standards based,
            //it knows about DOMContentLoaded.
            document.addEventListener("DOMContentLoaded", req.pageLoaded, false);
            window.addEventListener("load", req.pageLoaded, false);
            //Part of FF < 3.6 readystate fix (see setReadyState refs for more info)
            if (!document.readyState) {
                setReadyState = true;
                document.readyState = "loading";
            }
        } else if (window.attachEvent) {
            window.attachEvent("onload", req.pageLoaded);

            //DOMContentLoaded approximation, as found by Diego Perini:
            //http://javascript.nwbox.com/IEContentLoaded/
            if (self === self.top) {
                scrollIntervalId = setInterval(function () {
                    try {
                        //From this ticket:
                        //http://bugs.dojotoolkit.org/ticket/11106,
                        //In IE HTML Application (HTA), such as in a selenium test,
                        //javascript in the iframe can't see anything outside
                        //of it, so self===self.top is true, but the iframe is
                        //not the top window and doScroll will be available
                        //before document.body is set. Test document.body
                        //before trying the doScroll trick.
                        if (document.body) {
                            document.documentElement.doScroll("left");
                            req.pageLoaded();
                        }
                    } catch (e) {}
                }, 30);
            }
        }

        //Check if document already complete, and if so, just trigger page load
        //listeners. NOTE: does not work with Firefox before 3.6. To support
        //those browsers, manually call require.pageLoaded().
        if (document.readyState === "complete") {
            req.pageLoaded();
        }
    }
    //****** END page load functionality ****************
    //>>excludeEnd("requireExcludePageLoad");

    //Set up default context. If require was a configuration object, use that as base config.
    req(cfg);

    //If modules are built into require.js, then need to make sure dependencies are
    //traced. Use a setTimeout in the browser world, to allow all the modules to register
    //themselves. In a non-browser env, assume that modules are not built into require.js,
    //which seems odd to do on the server.
    if (typeof setTimeout !== "undefined") {
        setTimeout(function () {
            var ctx = s.contexts[(cfg.context || defContextName)];
            //Allow for jQuery to be loaded/already in the page, and if jQuery 1.4.3,
            //make sure to hold onto it for readyWait triggering.
            ctx.jQueryCheck();
            ctx.resume();
        }, 0);
    }
}());
