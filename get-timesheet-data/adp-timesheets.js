const _ = require('lodash');
const axios = require('axios');
const fs = require('fs');
const https = require('https');
const dateUtils = require('dateUtils'); // from shared lambda layer
const { getSecret } = require('./secrets');
const { getTimesheetDateBatches } = require('./shared');
const { invokeLambda } = require('utils');

const STAGE = process.env.STAGE;
let accessTokenTimesheets, accessTokenPTO, cert, key, httpsAgent, account;
let nonBillables;

/**
 * Doc
 * @param {*} event
 * @returns
 */
async function handler(event) {
  try {
    let employeeNumber = event.employeeNumber;
    let onlyPto = event.onlyPto;
    account = event.account;
    nonBillables = new Set();
    await initializeCredentials();
    //let employees = await getEmployees();
    // G3VQ1GNRWFZXND4Q G35GRH4KHAZK9SYC G3EYH892PW4QY9PJ G3EXKS6X566SG2AE G35GRH4KHAZKNAMH G3FZVBAQ2TB6B37E
    // INVALID USERS: G35GRH4KHAZKJT7N G35GRH4KHAZKPTXH
    //let aoid = _.find(employees, (e) => String(employeeNumber) === String(e.customFieldGroup?.stringFields?.[0]?.stringValue))
    let aoid = 'G3EYH892PW4QY9PJ';
    if (onlyPto) {
      let ptoBalances = await getPtoBalances(aoid);
      return { statusCode: 200, body: { ptoBalances } };
    }
    let periods = event.periods;
    let startDate = periods[0].startDate;
    let endDate = periods[periods.length - 1].endDate;
    let [timesheets, ptoBalances] = await Promise.all([getTimesheets(aoid, startDate, endDate), getPtoBalances(aoid)]);
    let periodTimesheets = getPeriodTimesheets(timesheets, periods);
    let supplementalData = getSupplementalData(timesheets);
    return Promise.resolve({
      statusCode: 200,
      body: { timesheets: periodTimesheets, ptoBalances, supplementalData }
    });
  } catch (err) {
    console.log(err);
    return err.response.data || err;
  }
}

function getSupplementalData(timesheets) {
  let days = 0;
  let duration = 0;
  let today = dateUtils.getTodaysDate(dateUtils.DEFAULT_ISOFORMAT);
  // get timesheets after today
  let futureTimesheets = _.filter(timesheets, (timesheet) => dateUtils.isAfter(timesheet.date, today, 'day'));
  // group timesheets by day they were submitted to allow getting amount of future days
  let groupedFutureTimesheets = _.groupBy(futureTimesheets, ({ date }) =>
    dateUtils.format(date, null, dateUtils.DEFAULT_ISOFORMAT)
  );
  _.forEach(groupedFutureTimesheets, (timesheets, date) => {
    days += 1;
    _.forEach(timesheets, (timesheet) => {
      duration += timesheet.duration;
    });
  });
  nonBillables = [...nonBillables];
  return { future: { days, duration }, nonBillables };
}

async function getPtoBalances(aoid) {
  const options = {
    method: 'GET',
    url: `https://api.adp.com/time/v3/workers/${aoid}/time-off-balances`,
    headers: { Authorization: `Bearer ${accessTokenPTO}` },
    httpsAgent: httpsAgent
  };
  const result = await axios(options);
  let ptoBalances = {};
  _.forEach(result.data?.timeOffBalances[0]?.timeOffPolicyBalances, (b) => {
    let quantity = (b.policyBalances[0].totalQuantity?.quantityValue || 0) * 60 * 60; // unlimited if there is no quantity value
    ptoBalances[b.timeOffPolicyCode.shortName] = quantity;
  });
  return ptoBalances;
}

function getPeriodTimesheets(timesheets, periods) {
  let periodTimesheets = [];
  _.forEach(periods, (p) => {
    p.timesheets = _.filter(timesheets, ({ date }) => dateUtils.isBetween(date, p.startDate, p.endDate, 'day', '[]'));
    p.timesheets = _.groupBy(p.timesheets, (timesheet) => timesheet.jobcode);
    _.forEach(p.timesheets, (jobcodeTimesheets, jobcode) => {
      // Assign the duration sum of each months jobcode
      p.timesheets[jobcode] = _.reduce(
        jobcodeTimesheets,
        (sum, timesheet) => {
          return (sum += timesheet.duration);
        },
        0
      );
    });
    periodTimesheets.push(p);
  });
  return periodTimesheets;
}

async function initializeCredentials() {
  [accessTokenTimesheets, accessTokenPTO, cert, key] = await Promise.all([
    getADPAccessToken('Timesheets'),
    getADPAccessToken('PTO'),
    getSecret(`/ADP/${account}/SSLCert`),
    getSecret(`/ADP/${account}/SSLKey`)
  ]);

  // ADP requires certificate signing with each API call
  httpsAgent = new https.Agent({
    cert,
    key
  });
}

async function getTimesheets(aoid, startDate, endDate) {
  let dateBatches = getTimesheetDateBatches(startDate, endDate);
  let promises = [];
  _.forEach(dateBatches, (dateBatch) => {
    let startDate = dateUtils.subtract(dateBatch.startDate, 15, 'day', dateUtils.DEFAULT_ISOFORMAT);
    let endDate = dateUtils.add(dateBatch.endDate, 15, 'day', dateUtils.DEFAULT_ISOFORMAT);
    const options = {
      method: 'GET',
      url: `https://api.adp.com/time/v2/workers/${aoid}/time-cards?$filter=timeCards/timePeriod/startDate ge \'${startDate}\' and timeCards/timePeriod/endDate le \'${endDate}\'`,
      headers: { Authorization: `Bearer ${accessTokenTimesheets}` },
      httpsAgent: httpsAgent
    };
    promises.push(axios(options));
  });
  let timesheetResponses = await Promise.all(promises);
  let timesheets = [];
  _.forEach(timesheetResponses, (timesheetResponse) => {
    timesheets.push(timesheetResponse.data.timeCards);
  });
  timesheets = _.flatten(timesheets);
  timesheets = _.filter(timesheets, (v, i, a) => _.findIndex(a, (v2) => v2.timeCardID === v.timeCardID) === i);
  _.forEach(timesheets, (t) => {
    let regularJobcode = t.homeLaborAllocations[t.homeLaborAllocations.length - 1]?.allocationCode?.codeValue;
    _.forEach(t.dailyTotals, (dt) => {
      if (dt.payCode.shortName === 'Regular') {
        dt.payCode.shortName = regularJobcode;
      } else {
        nonBillables.add(dt.payCode.shortName);
      }
    });
  });
  timesheets = _.flatten(_.map(timesheets, (t) => t.dailyTotals));
  timesheets = _.map(timesheets, ({ entryDate, payCode, timeDuration }) => ({
    date: entryDate,
    jobcode: payCode.shortName,
    duration: convertToSeconds(timeDuration)
  }));
  return timesheets;
}

/**
 * Converts ADP's formatted time duration to seconds.
 *
 * @param duration String - Examples: 'PT7H', 'PT30M', 'PT8H30M'
 * @return Integer - ADP's formatted time converted to seconds
 */
function convertToSeconds(duration) {
  if (!duration) return 0;
  let str = duration.substring(2);
  let [seconds, minutes, hours] = [0, 0, 0];
  if (str.includes('H')) {
    hours = str?.includes('H') ? str.split('H')?.[0] : 0;
    str = str.split('H')?.[1];
  }
  minutes = str?.split('M')?.[0] || 0;
  seconds = minutes * 60 + hours * 60 * 60;
  return seconds;
} // convertToSeconds

/**
 * Gets the access token by invoking the get access token lambda functions
 * @returns
 */
async function getADPAccessToken(connector) {
  try {
    let payload = { account, connector };
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
    let payload = { account, connector: 'Timesheets' };
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
