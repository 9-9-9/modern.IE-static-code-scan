/*
 * Modern.IE main service; runs under node.js.
 *
 * Copyright (c) Microsoft Corporation; All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this
 * file except in compliance with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * THIS CODE IS PROVIDED AS IS BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, EITHER
 * EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION ANY IMPLIED WARRANTIES OR CONDITIONS
 * OF TITLE, FITNESS FOR A PARTICULAR PURPOSE, MERCHANTABLITY OR NON-INFRINGEMENT.
 *
 * See the Apache Version 2.0 License for specific language governing permissions
 * and limitations under the License.
 */

"use strict";

var url = require('url'),
    fs = require('fs'),
    port = process.env.PORT || 1337,
    request = require('request'),
    express = require('express'),
    cors = require('cors'),
    app = express(),
    cheerio = require('cheerio'),
    promises = require('promised-io/promise'),
    Deferred = require('promised-io').Deferred,
    promised = require("promised-io/promise"),
    cssLoader = require('./lib/checks/loadcss.js'),
    jsLoader = require('./lib/checks/loadjs.js'),
    tests = require('./lib/checks/loadchecks.js').tests,
    http = require('http'),
    path = require('path'),
    zlib = require('zlib'),
    sanitize = require('validator').sanitize,
    charset = 'utf-8',
    querystring = require('querystring'),
    request = request.defaults({followAllRedirects: true,
        encoding: null,
        jar: false,
        //proxy: 'http://localhost:8888',
        headers: {
            'Accept': 'text/html, application/xhtml+xml, */*',
            'Accept-Encoding': 'gzip,deflate',
            'Accept-Language': 'en-US,en;q=0.5',
            'User-Agent': 'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2; WOW64; Trident/6.0)'}});


function launchNonParallelTests(promisesArray, website) {
    var deferred = new Deferred();

    process.nextTick(function () {

        tests.forEach(function (test) {
            if (!test.parallel) {
                promisesArray.push(test.check(website));
            }
        });

        deferred.resolve(promisesArray);
    });

    return deferred.promise;
}

function sendResults(res, start, resultsArray) {
    var results = {};

    for (var i = 0; i < resultsArray.length; i++) {
        results[resultsArray[i].testName] = resultsArray[i];
    }
    res.writeHeader(200, {"Content-Type": "application/json",
        "X-Content-Type-Options": "nosniff" });
    res.write(JSON.stringify({processTime: (Date.now() - start) / 1000, results: results}));
    res.end();
}

function sendInternalServerError(error, res) {
    res.writeHeader(500, {"Content-Type": "text/plain"});
    res.write(JSON.stringify(error) + '\n');
    res.end();
}

function remoteErrorResponse(response, statusCode, message) {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.write(JSON.stringify({statusCode: statusCode, message: message}));
    response.end();
}

/*
 * Since several tests need HTML/JS/CSS content, fetch it all at once
 * before calling any of the tests. Note that the tests still could
 * retrieve additional content async, since they return a promise.
 */
function analyze(data, content, res) {
    var start = Date.now(),
        promisesTests = [];

    var website = {
        url: url.parse(data.uri),
        auth: data.auth,
        content: content.body,
        compression: content.compression,
        $: cheerio.load(content.body, { lowerCaseTags: true, lowerCaseAttributeNames: true })
    };

    tests.forEach(function (test) {
        if (test.parallel) {
            promisesTests.push(test.check(website));
        }
    });

    cssLoader.loadCssFiles(website)
        .then(jsLoader.loadjsFiles)
        .then(launchNonParallelTests.bind(null, promisesTests))
        .then(promises.all)
        .then(sendResults.bind(null, res, start), sendInternalServerError.bind(null, res));
}

function returnMainPage(req, response) {
    fs.readFile(path.join(__dirname, "lib", "index.html"), function (err, data) {
        if (!err) {
            response.writeHeader(200, {"Content-Type": "text/html"});

        } else {
            response.writeHeader(500, {"Content-Type": "text/plain"});
            data = "Server error: " + err + "\n";
        }
        response.write(data);
        response.end();
    });
}



function decompress(body, type) {
    var deferred = new Deferred();

    if (type === 'gzip') {
        zlib.gunzip(body, function (err, data) {
            if (!err) {
                deferred.resolve({
                    body: data.toString(charset),
                    compression: 'gzip'
                });
            } else {
                deferred.reject('Error found: can\'t gunzip content ' + err);
            }
        });
    }else if(type === 'deflate'){
        zlib.inflateRaw(body, function (err, data) {
            if (!err) {
                deferred.resolve({
                        body: data.toString(charset),
                        compression: 'deflate'}
                );
            } else {
                deferred.reject('Error found: can\'t deflate content' + err);
            }
        });
    }else{
        process.nextTick(function(){
            deferred.reject("Unknown content encoding: " + type);
        });
    }

    return deferred.promise;
}


function getBody(res, body) {
    var deferred = new Deferred();
    if (res.headers['content-encoding']) {
        return decompress(body, res.headers['content-encoding']);
    } else {
        process.nextTick(function () {
            if (body) {
                deferred.resolve({
                    body: body.toString(charset),
                    compression: 'none'});
            } else {
                deferred.reject('Error found: Empty body');
            }
        });
    }
    return deferred.promise;
}

function processResponse(response, auth) {
    return function (err, res, body) {
        if (!err && res.statusCode === 200) {
            getBody(res, body)
                .then(function (result) {
                    analyze({uri: res.request.href, auth: auth}, result, response);
                }, remoteErrorResponse.bind(null, response, res.statusCode));
        } else {
            remoteErrorResponse(response, res ? res.statusCode : 'No response', 'Error found: ' + err);
        }
    };
}

function handleRequest(req, response) {
    if (req.url === '/') {
        // Return the "local scan" page
        returnMainPage(req, response);
        return;
    }

    var requestUrl = url.parse(req.url),
        parameters = querystring.parse(requestUrl.query),
        urlToAnalyze = sanitize(decodeURIComponent(parameters.url)).xss(),
        user = sanitize(decodeURIComponent(parameters.user)).xss(),
        password = sanitize(decodeURIComponent(parameters.password)).xss(),
        auth;

    // If the request gave a user/pass, send it along. Wait for 401 response before sending passwords.
    if (user !== "undefined" && password !== "undefined") {
        auth = {
            'user': user,
            'pass': password,
            'sendImmediately': false
        };
        request(urlToAnalyze,
            {auth: auth},
            processResponse(response, auth));
    } else {
        request(urlToAnalyze, processResponse(response));
    }
}

function handlePackage(req, res) {
    if (!req.body.js || !req.body.css || !req.body.html || !req.body.url) {
        remoteErrorResponse(res, 400, "Missing information");
    }
    var start = Date.now(),
        cssPromises = [];

    var website = {
        url: req.body.url ? url.parse(req.body.url.replace(/"/g, '')) : "http://privates.ite",
        content: req.body.html,
        css: null,
        js: JSON.parse(req.body.js),
        $: cheerio.load(req.body.html, { lowerCaseTags: true, lowerCaseAttributeNames: true })
    };

    var remoteCSS = JSON.parse(req.body.css);
    remoteCSS.forEach(function (parsedCSS) {
        if (parsedCSS.content !== '') {
            cssPromises.push(cssLoader.parseCSS(parsedCSS.content, parsedCSS.url, null, null, website));
        }
    });

    promised.all(cssPromises)
        .then(function (results) {
            var cssResults = [],
                promisesTests = [];

            cssResults.concat.apply(cssResults, results);
            website.css = cssResults;

            for (var i = 0; i < tests.length; i++) {
                // Call each test and save its returned promise
                promisesTests.push(tests[i].check(website));
            }

            promises.all(promisesTests)
                .then(sendResults.bind(null, res, start));
        });
}

app.use(express.bodyParser());

app.get('/', handleRequest);
app.post('/package', cors(), handlePackage);

app.listen(port);
//http.createServer(handleRequest).listen(port);

console.log('Server started on port ' + port);
console.log('To scan a private url go to http://localhost:' + port + '/ and follow the instructions');

module.exports.port = port;