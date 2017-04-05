var Promise = require('bluebird');
var _ = require('lodash');

var logger = require('./logger');
var path = require('path');

var defaults = require('./config/defaults');
var recursiveSources = require('./config/recursive-sources');
var Resource = require('./resource');

var FilenameGenerator = require('./filename-generator');
var Request = require('./request');
var ResourceHandler = require('./resource-handler');
var FSAdapter = require('./fs-adaper');
var utils = require('./utils');
var phantomjs = require('phantomjs-prebuilt');
var NormalizedUrlMap = require('./utils/normalized-url-map');

function Scraper (options) {
	var self = this;

	this.usePhantom = options.usePhantom;

	// Extend options
	self.options = _.extend({}, defaults, options);
	self.options.request = _.extend({}, defaults.request, options.request);
	self.options.urls = _.isArray(self.options.urls) ? self.options.urls : [self.options.urls];

	if (self.options.subdirectories) {
		self.options.subdirectories.forEach((element) => {
			element.extensions = element.extensions.map((ext) => ext.toLowerCase());
		});
	}

	if (self.options.recursive) {
		self.options.sources = _.union(self.options.sources, recursiveSources);
	}

	logger.info('init with options', self.options);

	self.request = new Request(self.options);
	self.resourceHandler = new ResourceHandler(self.options, self);
	self.filenameGenerator = new FilenameGenerator(self.options);
	self.fsAdapter = new FSAdapter(self.options);

	// Custom structures
	// Array of Resources for downloading
	self.originalResources = _.map(self.options.urls, function createResource (obj) {
		var url = _.isObject(obj) && _.has(obj, 'url') ? obj.url : obj;
		var filename = _.isObject(obj) && _.has(obj, 'filename') ? obj.filename : self.options.defaultFilename;
		return new Resource(url, filename);
	});

	self.requestedResourcePromises = new NormalizedUrlMap(); // Map url -> request promise
	self.loadedResources = new NormalizedUrlMap(); // Map url -> resource
}

Scraper.prototype.loadResource = function loadResource (resource) {
	var self = this;
	var url = resource.getUrl();

	if (self.loadedResources.has(url)) {
		logger.debug('found loaded resource for ' + resource);
	} else {
		logger.debug('add loaded resource ' + resource);
		self.loadedResources.set(url, resource);
	}
};

Scraper.prototype.saveResource = function saveResource (resource) {
	var self = this;
	resource.setSaved();

	return Promise.resolve()
		.then(function handleResource () {
			return self.resourceHandler.handleResource(resource);
		}).then(function fileHandled () {
			logger.info('saving resource ' + resource + ' to fs');
			return self.fsAdapter.saveResource(resource);
		}).then(function afterResourceSaved () {
			if (self.options.onResourceSaved) {
				self.options.onResourceSaved(resource);
			}
		}).catch(function handleError (err) {
			logger.warn('failed to save resource ' + resource);
			return self.handleError(err, resource);
		});
};

Scraper.prototype.createNewRequest = function createNewRequest (resource) {
	var self = this;
	var url = resource.getUrl();

	var requestPromise = Promise.resolve()
		.then(function makeRequest () {
			logger.debug('requesting ' + url);
			var referer = resource.parent ? resource.parent.getUrl() : null;

			if (resource.isHtml() && self.usePhantom) {
				return self.getHtmlViaPhantom(url);
			} else {
				return self.request.get(url, referer);
			}
		}).then(function requestCompleted (responseData) {

			if (!utils.urlsEqual(responseData.url, url)) { // Url may be changed in redirects
				logger.debug('url changed. old url = ' + url + ', new url = ' + responseData.url);

				if (self.requestedResourcePromises.has(responseData.url)) {
					return self.requestedResourcePromises.get(responseData.url);
				}

				resource.setUrl(responseData.url);
				self.requestedResourcePromises.set(responseData.url, requestPromise);
			}

			resource.setType(utils.getTypeByMime(responseData.mimeType));

			var filename = self.filenameGenerator.generateFilename(resource);
			resource.setFilename(filename);

			// if type was not determined by mime we can try to get it from filename after it was generated
			if (!resource.getType()) {
				resource.setType(utils.getTypeByFilename(filename));
			}

			if (responseData.metadata) {
				resource.setMetadata(responseData.metadata);
			}

			resource.setText(responseData.body);
			self.loadResource(resource); // Add resource to list for future downloading, see Scraper.waitForLoad
			return resource;
		}).catch(function handleError (err) {
			logger.warn('failed to request resource ' + resource);
			return self.handleError(err, resource);
		});

	self.requestedResourcePromises.set(url, requestPromise);
	return requestPromise;
};

Scraper.prototype.requestResource = function requestResource (resource) {
	var self = this;
	var url = resource.getUrl();

	if (self.options.urlFilter && !self.options.urlFilter(url)) {
		logger.debug('filtering out ' + resource + ' by url filter');
		return Promise.resolve(null);
	}

	if (self.options.maxDepth && resource.getDepth() > self.options.maxDepth) {
		logger.debug('filtering out ' + resource + ' by depth');
		return Promise.resolve(null);
	}

	if (self.requestedResourcePromises.has(url)) {
		logger.debug('found requested resource for ' + resource);
		return self.requestedResourcePromises.get(url);
	}

	return self.createNewRequest(resource);
};

Scraper.prototype.validate = function validate () {
	return this.fsAdapter.validateDirectory();
};

Scraper.prototype.load = function load () {
	var self = this;
	return self.fsAdapter.createDirectory().then(function loadAllResources () {
		return Promise.map(self.originalResources, self.requestResource.bind(self));
	}).then(self.waitForLoad.bind(self));
};

// Returns a promise which gets resolved when all resources are loaded.
// 1. Get all not saved resources and save them
// 2. Recursion if any new not saved resource were added during this time. If not, loading is done.
Scraper.prototype.waitForLoad = function waitForLoad () {
	var self = this;
	var resourcesToSave = Array.from(self.loadedResources.values()).filter((r) => !r.isSaved());
	var loadingIsFinished = _.isEmpty(resourcesToSave);

	if (!loadingIsFinished) {
		return Promise.mapSeries(resourcesToSave, self.saveResource.bind(self))
			.then(self.waitForLoad.bind(self));
	}
	logger.info('downloading is finished successfully');
	return Promise.resolve(self.originalResources);
};

Scraper.prototype.handleError = function handleError (err, resource) {
	if (resource && this.options.onResourceError) {
		this.options.onResourceError(resource, err);
	}
	if (this.options.ignoreErrors) {
		logger.warn('ignoring error: ' + err.message);
		return Promise.resolve(null);
	}
	return Promise.reject(err);
};

Scraper.prototype.errorCleanup = function errorCleanup (error) {
	logger.error('finishing with error: ' + error.message);
	return this.fsAdapter.cleanDirectory().then(function loadedDataRemoved () {
		return Promise.reject(error);
	});
};

Scraper.prototype.getHtmlViaPhantom = function getHtmlViaPhantom (url) {
	return new Promise(function getViaPhantom (resolve, reject) {
		const program = phantomjs.exec(path.join(__dirname, './phantom/get_html.js'), url, 'tmp/out.jpg');
		var log = [];
		var html = '';
		let error;

		program.stdout.on('data', function onPhantomData (data) {
			var d = data.toString();
			// The internal phantom page console.log statements are prepended with 'log::'
			// We extract these here and pass through to a console.log in the parent
			if (/^log::.*/.test(d)) {
				log.push(d.substr(3));
			} else {
				// Messages not prefixed with log
				html = html + d;
			}
		});
		program.stderr.on('error', function onPhantomError (err) {
			error = err;
		});

		program.on('exit', function onPhantomExit (code) {
			logger.info('PhantomJS log: ', log);
			// do something on end
			if (code === 0) {
				resolve({
					url: url,
					body: html
				});
			} else {
				reject(error);
			}
		});
	});
};

Scraper.prototype.scrape = function scrape (callback) {
	var self = this;
	return Promise.bind(self)
		.then(self.validate)
		.then(self.load)
		.catch(self.errorCleanup)
		.asCallback(callback);
};

Scraper.defaults = _.clone(defaults);

module.exports = Scraper;
