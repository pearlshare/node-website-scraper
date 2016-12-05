/* eslint no-console: 0 */
/* eslint-env browser */
var page = require('webpage').create();
var system = require('system');

var url = system.args[1]; // The url to crawl
var imagePath = system.args[2]; // Optionally give a path to write a screenshot to

page.viewportSize = {
	width: 1920,
	height: 1080
};
page.onConsoleMessage = function proxyConsoleLog (msg) {
	console.log('log::' + msg);
};
page.open(url, function onOpen (status) {
	if (status === 'success') {
		if (imagePath) {
			page.render(imagePath);
		}
		console.log(page.content);
		window.phantom.exit(0);
	} else {
		system.stderr.write(status);
		window.phantom.exit(0);
	}
});
