#!/usr/bin/nodejs
'use strict';

process.on('unhandledRejection', up => { throw up });

const https = require('https');
const pd = require('pretty-data').pd;
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

const VIESSMANN_API_HOST = 'api.viessmann.io';
const VIESSMANN_API_PORT = 443;
const VIESSMANN_API_PATH = '/vitotrol/soap/v1.0/iPhoneWebService.asmx';
const VIESSMANN_USER_AGENT = 'Vitotrol Plus/160 CFNetwork/897.15 Darwin/17.5.0';
const COOKIE_REGEX = /^(\S+=\S+);\s/;

const VIESSMANN_API_USERNAME = 'VIESSMANN_USERNAME';
const VIESSMANN_API_PASSWORD = 'VIESSMANN_PASSWORD';
const VIESSMANN_API_ANLAGEID = 'VIESSMANN_ANLAGEID';
const VIESSMANN_API_GERAETEID = 'VIESSMANN_GERAETEID';

var loginCookies = [];
var datapoints = [];

var graphite = require('graphite');
var graphiteClient = graphite.createClient('plaintext://localhost:2003/');

function getXmlRequest(request = null, params = []) {
    let xml = fs.readFileSync(path.join(__dirname, 'requests', request + '.xml'), 'utf8');

    for (let param in params) {
        xml = xml.replace('{' + param + '}', params[param]);
    }

    return pd.xmlmin(xml);
}

function makeRequest(action, requestData, callback, cookies = []) {
    let reqHeaders = {
        host: VIESSMANN_API_HOST,
        path: VIESSMANN_API_PATH,
        port: VIESSMANN_API_PORT,
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': action,
            'Accept-Language': 'en-us',
            'Content-Length': Buffer.byteLength(requestData),
            'User-Agent': VIESSMANN_USER_AGENT,
            'Cookie': []
        }
    }

    if (cookies.length) {
        for (let index in cookies) {
            reqHeaders.headers['Cookie'].push(cookies[index]);
        }
    }

    let req = https.request(reqHeaders, function(res) {
        let buffer = '';

        res.on('data', function(data) {
            buffer = buffer + data;
        });
        res.on('end', function(data) {
            if (this.statusCode == 200) {
                let that = this;
                xml2js.parseString(buffer, function(err, result) {
                    if (err) {
                        console.log('Not a valid xml response. Error occured!');
                    } else {
                        callback(result, that.headers);
                    }
                });
            } else {
                console.log('An error occured - Status code: ' + this.statusCode);
                console.log(buffer);
            }
        });

    });

    req.on('error', function(e) {
        console.log('an error occured while communicating with the Viessmann API: ' + e.message);
        process.exit(1);
    });

    req.write(requestData);
    req.end();
}

function makeAuthenticatedRequest(action, requestData, callback) {
    makeRequest(action, requestData, callback, loginCookies);
}

function authenticate() {
    let req = getXmlRequest('auth', {
        'username': VIESSMANN_API_USERNAME,
        'password': VIESSMANN_API_PASSWORD
    });

    loginCookies = [];

    makeRequest('http://www.e-controlnet.de/services/vii/Login', req, function(response, headers) {
        if (response['soap:Envelope']['soap:Body'][0].LoginResponse[0].LoginResult[0].Ergebnis[0] == '0') {
            console.log('Authenticated');
            // Logged in
            for (let index in headers['set-cookie']) {
                let cookie = headers['set-cookie'][index];
                let found = cookie.match(COOKIE_REGEX);
                if (found) {
                    // Valid Cookie
                    loginCookies.push(found[1]);
                }
            }

            updateDataPoints(function() {
                sendDataPoints();
            });

        }
    });
}

function updateDataPoints(callback = null) {
    let req = getXmlRequest('refreshData', {
        'anlageId': VIESSMANN_API_ANLAGEID,
        'geraetId': VIESSMANN_API_GERAETEID
    });

    makeAuthenticatedRequest('http://www.e-controlnet.de/services/vii/RefreshData', req, function(response, headers) {
        let data = response['soap:Envelope']['soap:Body'][0].RefreshDataResponse[0].RefreshDataResult[0];

        if (data.Ergebnis[0] == '0') {
            // Got Valid Data
            let req = getXmlRequest('getData', {
                'anlageId': VIESSMANN_API_ANLAGEID,
                'geraetId': VIESSMANN_API_GERAETEID
            });

            makeAuthenticatedRequest('http://www.e-controlnet.de/services/vii/GetData', req, function(response, headers) {
                let data = response['soap:Envelope']['soap:Body'][0].GetDataResponse[0].GetDataResult[0];

                if (data.Ergebnis[0] == '0') {
                    // Got Valid Data
                    datapoints = data.DatenwerteListe[0].WerteListe;

                    if (callback) {
                        callback();
                    }
                }
            });
        }
    });
}

function sendDataPoints() {
    for (let i in datapoints) {
        let datapoint = datapoints[i];
        let graphitePath = 'viessmann.' + datapoint.DatenpunktId[0];
        let graphiteHash = {};
        graphiteHash[graphitePath] = datapoint.Wert[0];
        graphiteClient.write(graphiteHash, function(err) {
            // if err is null, your data was sent to graphite!
        });
    }
}

authenticate();

setInterval(function() {
    updateDataPoints(function() {
        sendDataPoints();
    });
}, 60000);
