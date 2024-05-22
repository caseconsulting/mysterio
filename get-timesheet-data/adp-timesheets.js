const _ = require('lodash');
const axios = require('axios');
const fs = require('fs');
const https = require('https');
const dateUtils = require('dateUtils'); // from shared lambda layer
const { getSecret } = require('./secrets');
const { invokeLambda } = require('utils');

const STAGE = process.env.STAGE;
let accessTokenTimesheets, accessTokenPTO, cert, key, httpsAgent;

/**
 * Doc
 * @param {*} event
 * @returns
 */
async function handler(event) {
  try {
    let employeeNumber = event.employeeNumber;
    let onlyPto = event.onlyPto;
    await initializeCredentials();

    let employees = await getEmployees();
    let timesheets = await getTimesheets();

    return Promise.resolve({
      statusCode: 200,
      body: timesheets
    });
  } catch (err) {
    console.log(err);
    return err.response.data;
  }
}

async function initializeCredentials() {
  [accessTokenTimesheets, accessTokenPTO, cert, key] = await Promise.all([
    getADPAccessToken('Timesheets'),
    getADPAccessToken('PTO'),
    getSecret(`/ADP/CYK/SSLCert`),
    getSecret(`/ADP/CYK/SSLKey`)
  ]);

  // ADP requires certificate signing with each API call
  httpsAgent = new https.Agent({ cert, key });
}

async function getTimesheets() {
  const options = {
    method: 'GET',
    url: "https://api.adp.com/time/v2/workers/G3EXKS6X566SG2AE/time-cards?$filter=timeCards/timePeriod/endDate ge '2024-01-01' and timeCards/timePeriod/startDate le '2024-12-31'",
    headers: { Authorization: `Bearer ${accessTokenTimesheets}` },
    httpsAgent: httpsAgent
  };
  const result = await axios(options);
  let timesheets = result.data.timeCards;
  timesheets = _.flatten(_.map(timesheets, (t) => t.dailyTotals));
  timesheets = _.map(timesheets, ({ entryDate, payCode, timeDuration }) => ({
    date: entryDate,
    jobcode: payCode.shortName,
    duration: timeDuration
  }));
  return timesheets;
}

/**
 * Gets the access token by invoking the get access token lambda functions
 * @returns
 */
async function getADPAccessToken(connector) {
  try {
    let payload = { account: 'CYK', connector: connector };
    let params = {
      FunctionName: `mysterio-adp-token-${STAGE}`,
      Payload: JSON.stringify(payload),
      Qualifier: '$LATEST'
    };
    let result = await invokeLambda(params);
    return result.body;
  } catch (err) {
    throw err;
  }
} // getADPAccessToken

async function getEmployees() {
  try {
    let payload = { account: 'CYK', connector: 'Timesheets' };
    let params = {
      FunctionName: `mysterio-adp-employees-${STAGE}`,
      Payload: JSON.stringify(payload),
      Qualifier: '$LATEST'
    };
    let result = await invokeLambda(params);
    let employees = result.body;
    return employees;
  } catch (err) {
    throw err;
  }
}

module.exports = {
  handler
};
