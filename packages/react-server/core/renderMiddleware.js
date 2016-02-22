
var logger = require('./logging').getLogger(__LOGGER__),
	React = require('react'),
	ReactDOMServer = require('react-dom/server'),
	MobileDetect = require('mobile-detect'),
	RequestContext = require('./context/RequestContext'),
	RequestLocalStorage = require('./util/RequestLocalStorage'),
	RLS = RequestLocalStorage.getNamespace(),
	LABString = require('./util/LABString'),
	Q = require('q'),
	config = require('./config'),
	ExpressServerRequest = require("./ExpressServerRequest"),
	expressState = require('express-state'),
	cookieParser = require('cookie-parser'),
	PageUtil = require("./util/PageUtil"),
	TritonAgent = require('./TritonAgent'),
	StringEscapeUtil = require('./util/StringEscapeUtil'),
	{getRootElementAttributes} = require('./components/RootElement'),
	{PAGE_CSS_NODE_ID, PAGE_LINK_NODE_ID, PAGE_CONTENT_NODE_ID, PAGE_CONTAINER_NODE_ID} = require('./constants');

var _ = {
	map: require('lodash/collection/map'),
};

// TODO FIXME ??
// It *might* be worthwhile to get rid of all the closure-y things in render()
// https://developers.google.com/speed/articles/optimizing-javascript

// If an element hasn't rendered in this long it gets the axe.
var FAILSAFE_RENDER_TIMEOUT = 20e3;

// If a page's `handleRoute` fails to resolve this fast it gets the axe.
var FAILSAFE_ROUTER_TIMEOUT = 20e3;

// We'll use this for keeping track of request concurrency per worker.
var ACTIVE_REQUESTS = 0;

// Some non-content items that can live in the elements array.
var ELEMENT_PENDING         = -1;
var ELEMENT_ALREADY_WRITTEN = -2;

/**
 * renderMiddleware entrypoint. Called by express for every request.
 */
module.exports = function(server, routes) {

	expressState.extend(server);

	// parse cookies into req.cookies property
	server.use(cookieParser());

	// sets the namespace that data will be exposed into client-side
	// TODO: express-state doesn't do much for us until we're using a templating library
	server.set('state namespace', '__tritonState');

	server.use((req, res, next) => { RequestLocalStorage.startRequest(() => {
		ACTIVE_REQUESTS++;

		var start = RLS().startTime = new Date();
		var startHR = process.hrtime();

		logger.debug(`Incoming request for ${req.path}`);

		initResponseCompletePromise(res);

		// Just to keep an eye out for leaks.
		logger.gauge("requestLocalStorageNamespaces", RequestLocalStorage.getCountNamespaces());

		// monkey-patch `res.write` so that we don't try to write to the stream if it's
		// already closed
		var origWrite = res.write;
		res.write = function () {
			if (!res.finished) {
				origWrite.apply(res, arguments);
			} else {
				logger.error("Attempted write after response finished", { path: req && req.path || "unknown", stack: logger.stack() });
			}
		};

		// TODO? pull this context building into its own middleware
		var context = new RequestContext.Builder()
				.setRoutes(routes)
				.setDefaultXhrHeadersFromRequest(req)
				.create({
					// TODO: context opts?
				});

		// Need this stuff in corvair for logging.
		context.setServerStash({ req, res, start, startHR });

		context.setMobileDetect(new MobileDetect(req.get('user-agent')));

		// setup navigation handler (TODO: should we have a 'once' version?)
		context.onNavigate( (err, page) => {

			if (!navigateDfd.promise.isPending()) {
				logger.error("Finished navigation after FAILSAFE_ROUTER_TIMEOUT", {
					page: context.page,
					path: req.path,
				});
				return;
			}

			// Success.
			navigateDfd.resolve();

			if (err) {
				// The page can elect to proceed to render
				// even with a non-2xx response.  If it
				// _doesn't_ do so then we're done.
				var done = !(page && page.getHasDocument());

				if (err.status === 301 || err.status === 302 || err.status === 307) {
					if (done){
						// This adds a boilerplate body.
						res.redirect(err.status, err.redirectUrl);
					} else {
						// This expects our page to
						// render a body.  Hope they
						// know what they're doing.
						res.set('Location', err.redirectUrl);
					}
				} else if (done) {
					if (err.status === 404) {
						next();
					} else {
						next(err);
					}
				}
				if (done) {
					logger.log("onNavigate received a non-2xx HTTP code", err);
					handleResponseComplete(req, res, context, start, page);
					return;
				}
			}

			renderPage(req, res, context, start, page);

		});


		var navigateDfd = Q.defer();

		setTimeout(navigateDfd.reject, FAILSAFE_ROUTER_TIMEOUT);

		// If we fail to navigate, we'll throw a 500 and move on.
		navigateDfd.promise.catch(() => {
			logger.error("Failed to navigate after FAILSAFE_ROUTER_TIMEOUT", {
				page: context.navigator.getCurrentRoute().name,
				path: req.path,
			});
			handleResponseComplete(req, res, context, start, context.page);
			next({status: 500});
		});

		context.navigate(new ExpressServerRequest(req));

	})});
}

module.exports.getActiveRequests = () => ACTIVE_REQUESTS;

function initResponseCompletePromise(res){
	var dfd = Q.defer();

	res.on('close',  dfd.resolve);
	res.on('finish', dfd.resolve);

	RLS().responseCompletePromise = dfd.promise;
}

function handleResponseComplete(req, res, context, start, page) {

	RLS().responseCompletePromise.then(RequestLocalStorage.bind(() => {

		// All intentional response completion should funnel through
		// this function.  If this value starts climbing gradually
		// that's an indication that we have some _unintentional_
		// response completion going on that we should deal with.
		ACTIVE_REQUESTS--;

		// Note that if the navigator couldn't even map the request to
		// a page, we won't be able to call middleware
		// `handleComplete()` here.
		//
		if (page) {
			logRequestStats(req, res, context, start, page);

			page.handleComplete();
		}
	}));
}

function renderPage(req, res, context, start, page) {

	var routeName = context.navigator.getCurrentRoute().name;

	logger.debug("Route Name: " + routeName);

	var timer = logger.timer("lifecycle.individual");

	res.status(page.getStatus()||200);

	// Each of these functions has the same signature and returns a
	// promise, so we can chain them up with a promise reduction.
	var lifecycleMethods;
	if (PageUtil.PageConfig.get('isFragment')){
		lifecycleMethods = fragmentLifecycle();
	} else if (PageUtil.PageConfig.get('isRawResponse')){
		lifecycleMethods = rawResponseLifecycle();
	} else {
		lifecycleMethods = pageLifecycle();
	}

	lifecycleMethods.reduce((chain, func) => chain
		.then(() => func(req, res, context, start, page))
		.then(() => {
			timer.tick(func.name);
			logger.time(`lifecycle.fromStart.${func.name}`, new Date - start);
		})
	).catch(err => {
		logger.error("Error in renderPage chain", err)

		// Register `finish` listener before ending response.
		handleResponseComplete(req, res, context, start, page);

		// Bummer.
		res.status(500).end();
	});

	// TODO: we probably want a "we're not waiting any longer for this"
	// timeout as well, and cancel the waiting deferreds
}

function rawResponseLifecycle () {
	return [
		Q(), // NOOP lead-in to prime the reduction
		setContentType,
		writeResponseData,
		handleResponseComplete,
		endResponse,
	];
}

function fragmentLifecycle () {
	return [
		Q(), // NOOP lead-in to prime the reduction
		setContentType,
		writeDebugComments,
		writeBody,
		handleResponseComplete,
		endResponse,
	];
}

function pageLifecycle() {
	return [
		Q(), // This is just a NOOP lead-in to prime the reduction.
		setContentType,
		writeHeader,
		startBody,
		writeBody,
		wrapUpLateArrivals,
		closeBody,
		handleResponseComplete,
		endResponse,
	];
}

function setContentType(req, res, context, start, pageObject) {
	res.set('Content-Type', pageObject.getContentType());
}

function writeHeader(req, res, context, start, pageObject) {
	res.type('html');
	res.set('Transfer-Encoding', 'chunked');

	res.write("<!DOCTYPE html><html><head>");

	// note: these responses can currently come back out-of-order, as many are returning
	// promises. scripts and stylesheets are guaranteed
	return Q.all([
		renderDebugComments(pageObject, res),
		renderTimingInit(pageObject, res),
		renderTitle(pageObject, res),
		// PLAT-602: inline scripts come before stylesheets because
		// stylesheet downloads block inline script execution.
		renderScripts(pageObject, res),
		renderStylesheets(pageObject, res),
		renderMetaTags(pageObject, res),
		renderLinkTags(pageObject, res),
		renderBaseTag(pageObject, res),
	]).then(() => {
		// once we have finished rendering all of the pieces of the head element, we
		// can close the head and start the body element.
		res.write(`</head>`);

		// Get headers out right away so secondary resource download can start.
		flushRes(res);
	});
}

function flushRes(res){

	// This method is only defined on the response object if the compress
	// middleware is installed, so we need to guard our calls.
	if (res.flush) {
		res.flush()
		if (!RLS().didLogFirstFlush){
			RLS().didLogFirstFlush = true;
			logger.time('firstFlush', new Date - RLS().startTime);
		}
	}
}

function renderTimingInit(pageObject, res) {
	// This is awkward and imprecise.  We don't want to put `<script>`
	// tags between divs above the fold, so we're going to keep separate
	// track of time client and server side. Then we'll put `<noscript>`
	// tags with data elements representing offset from our _server_ base
	// time that we'll apply to our _client_ base time as a proxy for when
	// the element arrived (when it's actually when we _sent_ it).
	//
	RLS().timingDataT0 = new Date;
	renderScriptsSync([{text:`__tritonTimingStart=new Date`}], res)
}

function renderDebugComments (pageObject, res) {
	var debugComments = pageObject.getDebugComments();
	debugComments.map(debugComment => {
		if (!debugComment.label || !debugComment.value) {
			logger.warning("Debug comment is missing either a label or a value", debugComment);
		}

		res.write(`<!-- ${debugComment.label}: ${debugComment.value} -->`);
	});

	// resolve immediately.
	return Q("");
}

function writeDebugComments (req, res, context, start, pageObject) {
	return Q(renderDebugComments(pageObject, res));
}

function renderTitle (pageObject, res) {
	return pageObject.getTitle().then((title) => {
		res.write(`<title>${title}</title>`);
	});
}

function attrfy (value) {
	return value.replace(/"/g, '&quot;');
}

function renderMetaTags (pageObject, res) {
	var metaTags = pageObject.getMetaTags();

	var metaTagsRendered = metaTags.map(metaTagPromise => {
		return metaTagPromise.then(PageUtil.makeArray).then(metaTags => metaTags.forEach(metaTag => {
			// TODO: escaping
			if ((metaTag.name && metaTag.httpEquiv) || (metaTag.name && metaTag.charset) || (metaTag.charset && metaTag.httpEquiv)) {
				throw new Error("Meta tag cannot have more than one of name, httpEquiv, and charset", metaTag);
			}

			if ((metaTag.name && !metaTag.content) || (metaTag.httpEquiv && !metaTag.content)) {
				throw new Error("Meta tag has name or httpEquiv but does not have content", metaTag);
			}

			if (metaTag.noscript) res.write(`<noscript>`);
			res.write(`<meta`);

			if (metaTag.name)      res.write(` name="${attrfy(metaTag.name)}"`);
			if (metaTag.httpEquiv) res.write(` http-equiv="${attrfy(metaTag.httpEquiv)}"`);
			if (metaTag.charset)   res.write(` charset="${attrfy(metaTag.charset)}"`);
			if (metaTag.property)  res.write(` property="${attrfy(metaTag.property)}"`);
			if (metaTag.content)   res.write(` content="${attrfy(metaTag.content)}"`);

			res.write(`>`)
			if (metaTag.noscript) res.write(`</noscript>`);
		}));
	});

	return Q.all(metaTagsRendered);
}

function renderLinkTags (pageObject, res) {
	var linkTags = pageObject.getLinkTags();

	var linkTagsRendered = linkTags.map(linkTagPromise => {
		return linkTagPromise.then(PageUtil.makeArray).then(linkTags => linkTags.forEach(linkTag => {

			if (!linkTag.rel) {
				throw new Error(`<link> tag specified without 'rel' attr`);
			}

			res.write(`<link ${PAGE_LINK_NODE_ID} ${
				Object.keys(linkTag)
					.map(attr => `${attr}="${attrfy(linkTag[attr])}"`)
					.join(' ')
			}>`);
		}));
	});

	return Q.all(linkTagsRendered);
}

function renderBaseTag(pageObject, res) {
	return pageObject.getBase().then((base) => {
		if (base !== null) {
			if (!base.href && !base.target) {
				throw new Error("<base> needs at least one of 'href' or 'target'");
			}
			var tag = "<base";
			if (base.href) {
				tag += ` href="${attrfy(base.href)}"`;
			}
			if (base.target) {
				tag += ` target="${attrfy(base.target)}"`;
			}
			tag += ">";
			res.write(tag);
		}
	});
}

function renderScriptsSync(scripts, res) {

	// right now, the getXXXScriptFiles methods return synchronously, no promises, so we can render
	// immediately.
	scripts.forEach( (script) => {
		// make sure there's a leading '/'
		if (!script.type) script.type = "text/javascript";

		if (script.href) {
			res.write(`<script src="${script.href}" type="${script.type}"></script>`);
		} else if (script.text) {
			res.write(`<script type="${script.type}">${script.text}</script>`);
		} else {
			throw new Error("Script cannot be rendered because it has neither an href nor a text attribute: " + script);
		}
	});
}

function renderScriptsAsync(scripts, res) {

	// Nothing to do if there are no scripts.
	if (!scripts.length) return;

	// Don't need "type" in <script> tags anymore.
	//
	// http://www.w3.org/TR/html/scripting-1.html#the-script-element
	//
	// > The default, which is used if the attribute is absent, is "text/javascript".
	//
	res.write("<script>");

	// Lazily load LAB the first time we spit out async scripts.
	if (!RLS().didLoadLAB){

		// This is the full implementation of LABjs.
		res.write(LABString);

		// We always want scripts to be executed in order.
		res.write("$LAB.setGlobalDefaults({AlwaysPreserveOrder:true});");

		// We'll use this to store state between calls (see below).
		res.write("window._tLAB=$LAB")

		// Only need to do this part once.
		RLS().didLoadLAB = true;
	} else {

		// The assignment to `_tLAB` here is so we maintain a single
		// LAB chain through all of our calls to `renderScriptsAsync`.
		//
		// Each call to this function emits output that looks
		// something like:
		//
		//   _tLAB=_tLAB.script(...).wait(...) ...
		//
		// The result is that `window._tLAB` winds up holding the
		// final state of the LAB chain after each call, so that same
		// LAB chain can be appended to in the _next_ call (if there
		// is one).
		//
		// You can think of a LAB chain as being similar to a promise
		// chain.  The output of `$LAB.script()` or `$LAB.wait()` is
		// an object that itself has `script()` and `wait()` methods.
		// So long as the output of each call is used as the input for
		// the next call our code (both async loaded scripts and
		// inline JS) will be executed _in order_.
		//
		// If we start a _new_ chain directly from `$LAB` (the root
		// chain), we can wind up with _out of order_ execution.
		//
		// We want everything to be executed in order, so we maintain
		// one master chain for the page.  This chain is
		// `window._tLAB`.
		//
		res.write("_tLAB=_tLAB");
	}

	scripts.forEach(script => {

		if (script.href) {
			var LABScript = { src: script.href };

			if (script.crossOrigin){
				LABScript.crossOrigin = script.crossOrigin;
			}

			// If we don't have any other options we can shave a
			// few bytes by just passing the string.
			if (Object.keys(LABScript).length === 1){
				LABScript = LABScript.src;
			}

			if (script.condition) {
				res.write(`.script(function(){if(${script.condition}) return ${JSON.stringify(LABScript)}})`);
			} else {
				res.write(`.script(${JSON.stringify(LABScript)})`);
			}

		} else if (script.text) {
			if (script.condition) {
				throw new Error("Script using `text` cannot be loaded conditionally");
			}

			// The try/catch dance here is so exceptions get their
			// own time slice and can't mess with execution of the
			// LAB chain.
			//
			// The binding to `this` is so enclosed references to
			// `this` correctly get the `window` object (despite
			// being in a strict context).
			//
			res.write(`.wait(function(){${
				script.strict?'"use strict";':''
			}try{${
				script.text
			}}catch(e){setTimeout(function(){throw(e)},1)}}.bind(this))`);

		} else {

			throw new Error("Script needs either `href` or `text`: " + script);
		}
	});

	res.write(";</script>");
}

function renderScripts(pageObject, res) {

	// Want to gather these into one list of scripts, because we care if
	// there are any non-JS scripts in the whole bunch.
	var scripts = pageObject.getSystemScripts().concat(pageObject.getScripts());

	var thereIsAtLeastOneNonJSScript = scripts.filter(
		script => script.type && script.type !== "text/javascript"
	).length;

	if (thereIsAtLeastOneNonJSScript){

		// If there are non-JS scripts we can't use LAB for async
		// loading.  We still want to preserve script execution order,
		// so we'll cut over to all-synchronous loading.
		renderScriptsSync(scripts, res);
	} else {

		// Otherwise, we can do async script loading.
		renderScriptsAsync(scripts, res);
	}

	// resolve immediately.
	return Q("");
}

function renderStylesheets (pageObject, res) {
	pageObject.getHeadStylesheets().forEach((styleSheet) => {
		if (styleSheet.href) {
			res.write(`<link rel="stylesheet" type="${styleSheet.type}" media="${styleSheet.media}" href="${styleSheet.href}" ${PAGE_CSS_NODE_ID}>`);
		} else if (styleSheet.text) {
			res.write(`<style type="${styleSheet.type}" media="${styleSheet.media}" ${PAGE_CSS_NODE_ID}>${styleSheet.text}</style>`);
		} else {
			throw new Error("Style cannot be rendered because it has neither an href nor a text attribute: " + styleSheet);
		}
	});

	// resolve immediately.
	return Q("");
}

function startBody(req, res, context, start, page) {

	var routeName = context.navigator.getCurrentRoute().name

	return page.getBodyClasses().then((classes) => {
		classes.push(`route-${routeName}`)
		res.write(`<body class='${classes.join(' ')}'>`);
	}).then(() => page.getBodyStartContent()).then((texts) => texts.forEach((text) => {
		res.write(text);
	})).then(() => {
		res.write(`<div id='content' ${PAGE_CONTENT_NODE_ID}>`);
	});
}

/**
 * Writes out the ReactElements to the response. Returns a promise that fulfills when
 * all the ReactElements have been written out.
 */
function writeBody(req, res, context, start, page) {

	// standardize to an array of EarlyPromises of ReactElements
	var elementPromises = PageUtil.standardizeElements(page.getElements());

	// No JS until the HTML above the fold has made it through.
	// Need this to be an integer value greater than zero.
	RLS().atfCount = Math.max(page.getAboveTheFoldCount()|0, 1);

	// This is where we'll store our rendered HTML strings.  A value of
	// `undefined` means we haven't rendered that element yet.
	var rendered = elementPromises.map(() => ELEMENT_PENDING);

	// We need to return a promise that resolves when we're done, so we'll
	// maintain an array of deferreds that we punch out as we render
	// elements and we'll return a promise that resolves when they've all
	// been hit.
	var dfds = elementPromises.map(() => Q.defer());

	var doElement = (element, index) => {

		// Exceeded `FAILSAFE_RENDER_TIMEOUT`.  Bummer.
		if (rendered[index] === ELEMENT_ALREADY_WRITTEN) return;

		rendered[index] = renderElement(res, element, context);

		// If we've just rendered the next element to be written we'll
		// write it out.
		writeElements(res, rendered);

		dfds[index].resolve();
	};

	// Render elements as their data becomes available.
	elementPromises.forEach((promise, index) => promise
		.then(element => doElement(element, index))
		.catch(e => {
			logger.error(`Error rendering element ${index}`, e)
			// TODO: the error handling here should probably be merged
			// somehow with renderElement so that we get timing info.

			// In the case where there was an exception thrown while rendering,
			// the next three lines are effectively a no-op. In the case where
			// the element promise was rejected, this prevents a hang until
			// FAILSAFE_RENDER_TIMEOUT has passed.

			// No way we can recover in the second case, so let's just move on.
			// We'll call `writeElements` just in case everything is ready
			// after us.

			// This doesn't completely handle the extremely unlikely case that:
			//     1) `renderElement` successfully rendered this element, and
			//     2) `writeElements` successfully wrote it, but...
			//     3) `writeElements` threw after this element was written.
			//
			// We'll make a good-faith effort, but in this rare case writeElements is probably
			// going to fail again when we call it here. At least if that happens, _this_
			// particular element should show up properly on the page, even though the page
			// overall could be totally horked. And we won't have a 20s timeout...
			try {
				if (rendered[index] !== ELEMENT_ALREADY_WRITTEN) {
					rendered[index] = '';
					writeElements(res, rendered);
				}
			} finally {
				// try _really_ hard to resolve this deferred, to avoid a 20s hang.
				dfds[index].resolve();
			}
		})
		// just in case writeElements throws in our error callback above.
		.catch(e => logger.error(`Error recovering from error rendering element ${index}`, e))
	);

	// Some time has already elapsed since the request started.
	// Note that you can override `FAILSAFE_RENDER_TIMEOUT` with a
	// `?_debug_render_timeout={ms}` query string parameter.
	var totalWait     = req.query._debug_render_timeout || FAILSAFE_RENDER_TIMEOUT
	,   timeRemaining = totalWait - (new Date - start)

	var retval = Q.defer();

	// If we exceed the timeout then we'll just send empty elements for
	// anything that hadn't rendered yet.
	retval.promise.catch(() => {

		// Write out what we've got.
		writeElements(res, rendered.map(
			value => value === ELEMENT_PENDING?'':value
		));

		// If it hasn't arrived by now, we're not going to wait for it.
		RLS().lateArrivals = undefined;

		// Let the client know it's not getting any more data.
		renderScriptsAsync([{ text: `__tritonFailArrival()` }], res)
	});

	Q.all(dfds.map(dfd => dfd.promise)).then(retval.resolve);

	setTimeout(() => {
		// give some additional information when we time out
		retval.reject({
			message: "Timed out rendering.",
			// `timeRemaining` is how long we waited before timing out
			timeWaited: timeRemaining,
			elements: rendered.map(val => {
				if (val === ELEMENT_ALREADY_WRITTEN) {
					return 'W'; // written
				} else if (val === ELEMENT_PENDING) {
					return 'P'; // not rendered
				} else {
					return 'R'; // rendered, not yet written
				}
			}),
		});
	}, timeRemaining);

	return retval.promise;
}

function writeResponseData(req, res, context, start, page) {
	page.setExpressRequest(req);
	page.setExpressResponse(res);
	return page.getResponseData().then(data => {
		if (typeof data !== 'undefined') {
			res.write(data);
		}
	});
}

function renderElement(res, element, context) {

	if (element.containerOpen || element.containerClose){

		// Short-circuit out.  Don't want timing for containers.
		return element;
	}

	var name  = PageUtil.getElementDisplayName(element)
	,   start = RLS().startTime
	,   timer = logger.timer(`renderElement.individual.${name}`)
	,   html  = ''
	,   attrs = {}

	try {
		if (element !== null) {
			html = ReactDOMServer.renderToString(
				React.cloneElement(element, { context: context })
			);
			attrs = getRootElementAttributes(element);
		}
	} catch (err) {
		// A component failing to render is not fatal.  We've already
		// started the page with a 200 response.  We've even opened
		// the `data-triton-root-id` div for this component.  We need
		// to close it out and move on.  This is a bummer, and we'll
		// log it, but it's too late to totally bail out.
		logger.error(`Error rendering element ${name}`, err);
	}

	// We time how long _this_ element's render took, and also how long
	// since the beginning of the request it took us to spit this element
	// out.
	var individualTime = timer.stop();
	logger.time(`renderElement.fromStart.${name}`, new Date - start);

	// We _also_ keep track of the _total_ time we spent rendering during
	// each request so we can keep track of that overhead.
	RLS().renderTime || (RLS().renderTime = 0);
	RLS().renderTime += individualTime;

	return { html, attrs };
}

// Write as many elements out in a row as possible and then flush output.
// We render elements as their data becomes available, so they might fill in
// out-of-order.
function writeElements(res, elements) {

	// Pick up where we left off.
	var start = RLS().nextElement||(RLS().nextElement=0);

	for (var i = start; i < elements.length; RLS().nextElement = ++i){

		// If we haven't rendered the next element yet, we're done.
		if (elements[i] === ELEMENT_PENDING) break;

		// Got one!
		writeElement(res, elements[i], i);

		// Free for GC.
		elements[i] = ELEMENT_ALREADY_WRITTEN;

		if (PageUtil.PageConfig.get('isFragment')) continue;

		if (i === RLS().atfCount - 1){

			// Okay, we've sent all of our above-the-fold HTML,
			// now we can let the client start waking nodes up.
			bootstrapClient(res)
			for (var j = 0; j <= i; j++){
				renderScriptsAsync([{ text: `__tritonNodeArrival(${j})` }], res)
			}
		} else if (i >= RLS().atfCount){

			// Let the client know it's there.
			renderScriptsAsync([{ text: `__tritonNodeArrival(${i})` }], res)
		}
	}

	// It may be a while before we render the next element, so if we just
	// wrote anything let's send it down right away.
	if (i !== start) flushRes(res);
}

function writeElement(res, element, i){
	if (element.containerOpen) {
		res.write(`<div ${PAGE_CONTAINER_NODE_ID}=${i}${
			_.map(element.containerOpen, (v, k) => ` ${k}="${attrfy(v)}"`)
		}>`);
	} else if (element.containerClose) {
		res.write('</div>');
	} else {
		res.write(`<div data-triton-root-id=${
			i
		} data-triton-timing-offset="${
			// Mark when we sent it.
			new Date - RLS().timingDataT0
		}"${
			_.map(element.attrs, (v, k) => ` ${k}="${attrfy(v)}"`)
		}>${element.html}</div>`);
	}
}

function bootstrapClient(res) {
	var initialContext = {
		'TritonAgent.cache': TritonAgent.cache().dehydrate(),
	};

	res.expose(initialContext, 'InitialContext');
	res.expose(getNonInternalConfigs(), "Config");

	// Using naked `rfBootstrap()` instead of `window.rfBootstrap()`
	// because the browser's error message if it isn't defined is more
	// helpful this way.  With `window.rfBootstrap()` the error is just
	// "undefined is not a function".
	renderScriptsAsync([{
		text: `${res.locals.state};rfBootstrap();`,
	}], res);

	// This actually needs to happen _synchronously_ with this current
	// function to avoid letting responses slip in between.
	setupLateArrivals(res);
}

function setupLateArrivals(res) {
	var start = RLS().startTime;
	var notLoaded = TritonAgent.cache().getPendingRequests();

	// This is for reporting purposes.  We're going to log how many late
	// requests there were, but we won't actually emit the log line until
	// all of the requests have resolved.
	TritonAgent.cache().markLateRequests();

	notLoaded.forEach( pendingRequest => {
		pendingRequest.entry.whenDataReadyInternal().then( () => {
			logger.time("lateArrival", new Date - start);
			renderScriptsAsync([{
				text: `__tritonDataArrival(${
					JSON.stringify(pendingRequest.url)
				}, ${
					StringEscapeUtil.escapeForScriptTag(JSON.stringify(pendingRequest.entry.dehydrate()))
				});`,
			}], res);

		})
	});

	// TODO: maximum-wait-time-exceeded-so-cancel-pending-requests code
	var promises = notLoaded.map( result => result.entry.dfd.promise );
	RLS().lateArrivals = Q.allSettled(promises)
}

function wrapUpLateArrivals(){
	return RLS().lateArrivals;
}

function closeBody(req, res) {
	res.write("</div></body></html>");
	return Q();
}

function endResponse(req, res) {
	res.end();
	return Q();
}

function logRequestStats(req, res, context, start){
	var allRequests = TritonAgent.cache().getAllRequests()
	,   notLoaded   = TritonAgent.cache().getLateRequests()
	,   sock        = req.socket
	,   stash       = context.getServerStash()

	// The socket can be re-used for multiple requests with keep-alive.
	// Fortunately, until HTTP/2 rolls around, the requests over a given
	// socket will happen serially.  So we can just keep track of the
	// previous values for each socket and log the delta for a given
	// request.
	stash.bytesR = sock.bytesRead    - (sock._preR||(sock._preR=0));
	stash.bytesW = sock.bytesWritten - (sock._preW||(sock._preW=0));

	sock._preR += stash.bytesR;
	sock._preW += stash.bytesW;

	logger.gauge("countDataRequests", allRequests.length);
	logger.gauge("countLateArrivals", notLoaded.length, {hi: 1});
	logger.gauge("bytesRead", stash.bytesR, {hi: 1<<12});
	logger.gauge("bytesWritten", stash.bytesW, {hi: 1<<18});

	var time = new Date - start;

	logger.time(`responseCode.${res.statusCode}`, time);
	logger.time("totalRequestTime", time);

	// Only populated for full pages and fragments.
	if (RLS().renderTime){
		logger.time("totalRenderTime", RLS().renderTime);
	}

	if (notLoaded.length) {
		logger.time("totalRequestTimeWithLateArrivals", time);
	}

	return Q();
}

function getNonInternalConfigs() {
	var nonInternal = {};
	var fullConfig = config();
	Object.keys(fullConfig).forEach( configKey => {
		if (configKey !== 'internal') {
			nonInternal[configKey] = fullConfig[configKey];
		}
	});
	return nonInternal;
}