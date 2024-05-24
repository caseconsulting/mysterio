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
 * The handler for adp timesheet data
 *
 * @param {Object} event - The lambda event
 * @returns Object - The timesheet data
 */
async function handler(event) {
  try {
    // initialize variables
    let employeeNumber = event.employeeNumber;
    let onlyPto = event.onlyPto;
    let aoid = event.aoid;
    account = event.account;
    nonBillables = new Set();
    await initializeCredentials();
    if (!aoid) {
      // ADP aoid is not stored in employee object, find it through employee number
      let employees = await getEmployees();
      let employee = _.find(employees, (e) => {
        let field = _.find(e?.customFieldGroup?.stringFields, (f) => f.nameCode.shortName === 'Int Comp ID');
        // might need to change field.stringValue
        return String(employeeNumber) === String(field.stringValue);
      });
      aoid = employee.associateOID;
    }
    if (onlyPto) {
      // only PTO data is needed
      let ptoBalances = await getPtoBalances(aoid);
      return { statusCode: 200, body: { ptoBalances } };
    }
    let periods = event.periods;
    let startDate = periods[0].startDate;
    let endDate = periods[periods.length - 1].endDate;
    let [timesheets, ptoBalances] = await Promise.all([getTimesheets(aoid, startDate, endDate), getPtoBalances(aoid)]);
    let periodTimesheets = getPeriodTimesheets(timesheets, periods);
    let supplementalData = getSupplementalData(timesheets, endDate);
    return Promise.resolve({
      statusCode: 200,
      body: { timesheets: periodTimesheets, ptoBalances, supplementalData, aoid, system: 'ADP' }
    });
  } catch (err) {
    console.log(err.response?.data || err);
    return err.response?.data || err;
  }
} // handler

/**
 * Sets all necessary credentials for making API calls to ADP.
 */
async function initializeCredentials() {
  [accessTokenTimesheets, accessTokenPTO, cert, key] = await Promise.all([
    getADPAccessToken('Timesheets'),
    getADPAccessToken('PTO'),
    getSecret(`/ADP/${account}/SSLCert`),
    getSecret(`/ADP/${account}/SSLKey`)
  ]);
  // ADP requires certificate signing with each API call
  httpsAgent = new https.Agent({ cert, key });
} // initializeCredentials

/**
 * Gets the access token by invoking the get access token lambda functions
 * @returns String - The access token for the connectors scope
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

/**
 * Gets the user's timesheets within a given time period.
 *
 * @param {String} aoid - The ADP user aoid
 * @param {String} startDate - The period start date
 * @param {String} endDate - The period end date
 * @returns Array - All user timesheets within the given time period
 */
async function getTimesheets(aoid, startDate, endDate) {
  let dateBatches = getTimesheetDateBatches(startDate, endDate);
  let promises = [];
  _.forEach(dateBatches, (dateBatch) => {
    // ADP sometimes retrives the dates slightly after or before the needed date, add/subtract values as a safety net
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
  // flatten timesheet responses into array of ADP's pay period objects that contains the time cards
  let timesheets = _.flatten(_.map(timesheetResponses, (tr) => tr.data.timeCards));
  // filter out duplicate pay periods
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
} // getTimesheets

/**
 * Organizes and returns timesheets grouped by time periods then by jobcode.
 *
 * @param {Array} timesheetsData - The user timesheets within the given time period
 * @param {Object} periods - The time period objects with start and end dates
 * @returns Object - The timesheets grouped by time periods
 */
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
} // getPeriodTimesheets

/**
 * Gets the PTO balances from ADP.
 *
 * @param {String} aoid - The employee's ADP aoid
 * @returns Object - PTO balances with the balance as the key and duration in seconds as the value
 */
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
    let quantity = b.policyBalances[0].totalQuantity?.quantityValue;
    // some balances do not have a numeric quantity, filter those out
    if (Number.isInteger(Math.floor(quantity))) {
      quantity = quantity * 60 * 60; // 0 if there is no quantity value
      ptoBalances[b.timeOffPolicyCode.shortName] = quantity;
    }
  });
  return ptoBalances;
} // getPtoBalances

/**
 * Gets supplemental data like future timesheet hours and days.
 *
 * @param {Array} timesheets - The user timesheets within the given time period
 * @returns Object - The supplemental data
 */
function getSupplementalData(timesheets, endDate) {
  let days = 0;
  let duration = 0;
  let today = dateUtils.getTodaysDate(dateUtils.DEFAULT_ISOFORMAT);
  // get timesheets after today
  let futureTimesheets = _.filter(
    timesheets,
    (timesheet) =>
      dateUtils.isAfter(timesheet.date, today, 'day') && dateUtils.isSameOrBefore(timesheet.date, endDate, 'day')
  );
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
} // getSupplementalData

/**
 * Gets the ADP employees.
 *
 * @returns Array - The list of ADP employees
 */
async function getEmployees() {
  try {
    let query = '$select=workers/associateOID,workers/workerStatus,workers/customFieldGroup/stringFields';
    let payload = { account, connector: 'Timesheets', query };
    let params = {
      FunctionName: `mysterio-adp-employees-${STAGE}`,
      Payload: JSON.stringify(payload),
      Qualifier: '$LATEST'
    };
    let result = await invokeLambda(params);
    let employees = result.body;
    employees = _.filter(employees, (e) => e.workerStatus.statusCode.codeValue === 'Active');
    // TODO REMOVE BEFORE DEPLOYING TO PROD
    employees[0].customFieldGroup.stringFields[2].stringValue = '990';
    employees[1].customFieldGroup.stringFields[2].stringValue = '991';
    employees[2].customFieldGroup.stringFields[2].stringValue = '992';
    employees[3].customFieldGroup.stringFields[2].stringValue = '993';
    employees[4].customFieldGroup.stringFields[2].stringValue = '994';
    employees[5].customFieldGroup.stringFields[2].stringValue = '995';
    return employees;
  } catch (err) {
    throw err;
  }
} // getEmployees

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////// HELPERS ///////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

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

module.exports = {
  handler
};
