const _cloneDeep = require('lodash/cloneDeep');
const _filter = require('lodash/filter');
const _find = require('lodash/find');
const _findIndex = require('lodash/findIndex');
const _flatten = require('lodash/flatten');
const _forEach = require('lodash/forEach');
const _map = require('lodash/map');
const _sumBy = require('lodash/sumBy');
const axios = require('axios');
const https = require('https');
const { getTodaysDate, getIsoWeekday, add, subtract, isBetween, isSame, DEFAULT_ISOFORMAT } = require('dateUtils'); // from shared lambda layer
const { getHoursRequired, getSecret } = require('./shared.js');
const { invokeLambda } = require('utils');

const STAGE = process.env.STAGE;

let accessToken, cert, key, httpsAgent;
let cykAdpEmployees;

function _isCykReminderDay() {
  let timePeriod = _getCykCurrentPeriod();
  let today = getTodaysDate(DEFAULT_ISOFORMAT);
  let lastDay = timePeriod.endDate;
  let isoWeekDay = getIsoWeekday(lastDay);
  let daysToSubtract = Math.max(isoWeekDay - 5, 0);
  let lastWorkDay = subtract(lastDay, daysToSubtract, 'day', DEFAULT_ISOFORMAT);
  return isSame(today, lastWorkDay, 'day');
}

async function _shouldSendCykEmployeeReminder(employee) {
  await initializeCredentials();
  let aoid = await getAoid(employee);
  let timePeriod = _getCykCurrentPeriod();
  let hoursSubmitted = await getHoursSubmitted(aoid, timePeriod.startDate, timePeriod.endDate);
  let hoursRequired = getHoursRequired(employee, timePeriod.startDate, timePeriod.endDate);
  return hoursRequired > hoursSubmitted;
}

async function getAoid(employee) {
  let aoid = employee.cykAoid;
  if (!aoid) {
    if (!cykAdpEmployees) cykAdpEmployees = await getEmployees();
    let emp = _find(cykAdpEmployees, (e) => {
      let field = _find(e?.customFieldGroup?.stringFields, (f) => f.nameCode.shortName === 'Int Comp ID');
      return String(employee.employeeNumber) === String(field.stringValue);
    });
    aoid = emp.associateOID;
  }
  return aoid;
}

async function initializeCredentials() {
  if (!accessToken || !cert || !key || !httpsAgent) {
    [accessToken, cert, key] = await Promise.all([
      getADPAccessToken(),
      getSecret(`/ADP/CYK/SSLCert`),
      getSecret(`/ADP/CYK/SSLKey`)
    ]);
    // ADP requires certificate signing with each API call
    httpsAgent = new https.Agent({ cert, key });
  }
}

/**
 * Gets the access token by invoking the get access token lambda functions
 * @returns String - The access token for the connectors scope
 */
async function getADPAccessToken() {
  try {
    let payload = { account: 'CYK', connector: 'Timesheets' };
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
 * Gets the current bi-weekly pay period for CYK employees.
 *
 * @returns Object - The start and end date of the current bi-weekly period
 */
function _getCykCurrentPeriod() {
  const CYK_ORIG_START_DATE = '2024-04-15';
  const CYK_ORIG_END_DATE = '2024-04-28';
  let today = getTodaysDate();
  let startDate = _cloneDeep(CYK_ORIG_START_DATE);
  let endDate = _cloneDeep(CYK_ORIG_END_DATE);
  while (!isBetween(today, startDate, endDate, 'day', '[]')) {
    startDate = add(startDate, 14, 'day', DEFAULT_ISOFORMAT);
    endDate = add(endDate, 14, 'day', DEFAULT_ISOFORMAT);
  }
  return { startDate, endDate };
} // _getCykCurrentPeriod

/**
 * Gets the ADP employees.
 *
 * @returns Array - The list of ADP employees
 */
async function getEmployees() {
  try {
    let query = '$select=workers/associateOID,workers/workerStatus,workers/customFieldGroup/stringFields';
    let payload = { account: 'CYK', connector: 'Timesheets', query };
    let params = {
      FunctionName: `mysterio-adp-employees-${STAGE}`,
      Payload: JSON.stringify(payload),
      Qualifier: '$LATEST'
    };
    let result = await invokeLambda(params);
    let employees = result.body;
    employees = _filter(employees, (e) => e.workerStatus.statusCode.codeValue === 'Active');
    return employees;
  } catch (err) {
    throw err;
  }
} // getEmployees

/**
 * Gets the user's timesheets within a given time period.
 *
 * @param {String} aoid - The ADP user aoid
 * @param {String} startDate - The period start date
 * @param {String} endDate - The period end date
 * @returns Array - All user timesheets within the given time period
 */
async function getHoursSubmitted(aoid, startDate, endDate) {
  try {
    // ADP sometimes retrives the dates slightly after or before the needed date, add/subtract values as a safety net
    let startDateAdjusted = subtract(startDate, 15, 'day', DEFAULT_ISOFORMAT);
    let endDateAdjusted = add(endDate, 15, 'day', DEFAULT_ISOFORMAT);
    const options = {
      method: 'GET',
      url: `https://api.adp.com/time/v2/workers/${aoid}/time-cards?$filter=timeCards/timePeriod/startDate ge \'${startDateAdjusted}\' and timeCards/timePeriod/endDate le \'${endDateAdjusted}\'`,
      headers: { Authorization: `Bearer ${accessToken}` },
      httpsAgent: httpsAgent
    };
    let timesheetResponse = await axios(options);
    // flatten timesheet responses into array of ADP's pay period objects that contains the time cards
    let timesheets = timesheetResponse.data.timeCards;
    // filter out duplicate pay periods
    timesheets = _filter(timesheets, (v, i, a) => _findIndex(a, (v2) => v2.timeCardID === v.timeCardID) === i);
    _forEach(timesheets, (t) => {
      let regularJobcode = t.homeLaborAllocations[t.homeLaborAllocations.length - 1]?.allocationCode?.codeValue;
      _forEach(t.dailyTotals, (dt) => {
        if (dt.payCode.shortName === 'Regular') {
          dt.payCode.shortName = regularJobcode;
        } else {
          let name = dt.payCode.shortName;
          if (name === 'Paid Time Off') name = 'PTO';
        }
      });
    });
    timesheets = _flatten(_map(timesheets, (t) => t.dailyTotals));
    timesheets = _filter(timesheets, ({ entryDate }) => isBetween(entryDate, startDate, endDate, 'day', '[]'));
    timesheets = _map(timesheets, ({ entryDate, payCode, timeDuration }) => ({
      date: entryDate,
      jobcode: payCode.shortName === 'Paid Time Off' ? 'PTO' : payCode.shortName,
      duration: convertToSeconds(timeDuration)
    }));
    let hoursSubmitted = _sumBy(timesheets, (t) => t.duration) / 60 / 60; // convert from seconds to hours
    return hoursSubmitted;
  } catch (err) {
    throw err;
  }
} // getTimesheets

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
  _isCykReminderDay,
  _shouldSendCykEmployeeReminder
};
