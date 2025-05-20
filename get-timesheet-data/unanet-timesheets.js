const _ = require('lodash');
const axios = require('axios');
const dateUtils = require('dateUtils'); // from shared lambda layer
const { getSecret } = require('./secrets');
const { getTimesheetDateBatches } = require('./shared');

let accessToken;
// TODO: put in parameter store or something
const LOGIN = {
  username: 'logburn1@consultwithcase.com',
  password: 'Tester1'
}
const BASE_URL = 'https://consultwithcase-sand.unanet.biz/platform';

/**
 * The handler for unanet timesheet data
 *
 * @param {Object} event - The lambda event
 * @returns Object - The timesheet data
 */
async function handler(event) {
  try {
    let employeeNumber = event.employeeNumber;
    let onlyPto = event.onlyPto;
    // login to Unanet API account
    accessToken = await getAccessToken();
    console.log(accessToken);
    return;
    // get Unanet user
    let userData = await getUser(employeeNumber);
    let [userId, user] = Object.entries(userData)[0];
    // convert a user's PTO jobcodes into an array of jobcode Objects
    let ptoJobcodes = _.map(userData.jobcodes, (value, key) => {
      return { id: value.id, parentId: value.parent_id, type: value.type, name: value.name };
    });
    if (onlyPto) {
      // return only PTO jobcodes and early exit
      let ptoBalances = _.mapKeys(user.pto_balances, (value, key) => getJobcode(key, ptoJobcodes)?.name);
      return { statusCode: 200, body: { ptoBalances } };
    }
    let periods = event.periods;
    let startDate = periods[0].startDate;
    let endDate = periods[periods.length - 1].endDate;
    // get Unanet user jobcodes and timesheets data
    let { jobcodes: jobcodesData, timesheets: timesheetsData } = await getTimesheets(startDate, endDate, userId);
    // merge regular jobcodes with pto jobcodes
    jobcodesData = [...jobcodesData, ...ptoJobcodes];
    // calculate how many days are entered in the future
    let supplementalData = getSupplementalData(timesheetsData, jobcodesData);
    // group timesheet entries by month and each month by jobcodes with the sum of their duration
    let periodTimesheets = getPeriodTimesheets(timesheetsData, jobcodesData, periods);
    // set pto balances
    let ptoBalances = _.mapKeys(user.pto_balances, (value, key) => getJobcode(key, jobcodesData)?.name);
    return Promise.resolve({
      statusCode: 200,
      body: { timesheets: periodTimesheets, ptoBalances, supplementalData, system: 'Unanet' }
    });
  } catch (err) {
    console.log(err);
    return err;
  }
} // handler

/**
 * Returns an auth token for the API account.
 */
async function getAccessToken() {
  try {
    // set options for TSheet API call
    let options = {
      method: 'POST',
      url: BASE_URL + '/rest/login',
      data: {
        username: LOGIN.username,
        password: LOGIN.password
      }
    };

    // request data from TSheet API
    return await axios(options);
  } catch (err) {
    console.log(err);
    return err;
  }
}

/**
 * Returns the user's non-billable jobcodes.
 *
 * @param {Array} timesheetsData - The user's timesheets
 * @param {Array} jobcodesData - All jobcodes
 * @returns Array - The non-billable jobcodes
 */
function getNonBillableCodes(timesheetsData, jobcodesData) {
  let nonBillableids = [8690454, 40722896, 36091452]; // zAdmin (Overhead), Internship Program, Leave Without Pay
  let codes = new Set();
  _.forEach(timesheetsData, (timesheet) => {
    let jobcode = getJobcode(timesheet.jobcodeId, jobcodesData);
    if (!jobcode) jobcode = { id: 0, parentId: 8690454, type: 'regular', name: 'undefined' };
    if (isNonBillable(jobcode, jobcodesData, nonBillableids)) codes.add(jobcode.name);
  });
  return Array.from(codes);
} // getNonBillableCodes

/**
 * Recursively checks if a jobcode object is non-billable.
 *
 * @param {Object} jobcode - The jobcode object
 * @param {Array} jobcodesData - All jobcodes
 * @param {Array} nonBillableIds - The non-billable IDs
 * @returns Array - The non-billable jobcodes
 */
function isNonBillable(jobcode, jobcodesData, nonBillableIds) {
  if (jobcode.parentId === 0) {
    // base case
    return nonBillableIds.includes(jobcode.id) || jobcode.type === 'pto';
  } else {
    // checks if a jobcode is inside a non billable parent id
    let parentJobcode = getJobcode(jobcode.parentId, jobcodesData);
    return nonBillableIds.includes(jobcode.parentId) || isNonBillable(parentJobcode, jobcodesData, nonBillableIds);
  }
} // isNonBillable

/**
 * Gets supplemental data like future timesheet hours and days.
 *
 * @param {Array} timesheetsData - The user timesheets within the given time period
 * @param {Array} jobcodesData - All jobcodes
 * @returns Object - The supplemental data
 */
function getSupplementalData(timesheetsData, jobcodesData) {
  let days = 0;
  let futureDuration = 0;
  let todayDuration = 0;
  let today = dateUtils.getTodaysDate(dateUtils.DEFAULT_ISOFORMAT);
  // get timesheets after today
  let futureTimesheets = _.filter(timesheetsData, (timesheet) => dateUtils.isAfter(timesheet.date, today, 'day'));
  // get timesheets entered today and get duration
  let todaysTimesheets = _.filter(timesheetsData, (timesheet) => dateUtils.isSame(timesheet.date, today, 'day'));
  todayDuration = _.sumBy(todaysTimesheets, (timesheet) => timesheet.duration);
  // group timesheets by day they were submitted to allow getting amount of future days
  let groupedFutureTimesheets = _.groupBy(futureTimesheets, ({ date }) =>
    dateUtils.format(date, null, dateUtils.DEFAULT_ISOFORMAT)
  );
  _.forEach(groupedFutureTimesheets, (timesheets, date) => {
    days += 1;
    _.forEach(timesheets, (timesheet) => {
      futureDuration += timesheet.duration;
    });
  });
  let nonBillables = getNonBillableCodes(timesheetsData, jobcodesData);
  return { today: todayDuration, future: { days, duration: futureDuration }, nonBillables };
} // getSupplementalData

/**
 * Organizes and returns timesheets grouped by month then by jobcode.
 *
 * @param {Array} timesheetsData - The user timesheets within the given time period
 * @param {Array} jobcodesData - All jobcodes
 * @param {String} startDate - The period start date (in YYYY-MM format)
 * @param {String} endDate - The period end date (in YYYY-MM format)
 * @returns Object - The timesheets grouped by month and year
 */
function getPeriodTimesheets(timesheetsData, jobcodesData, periods) {
  let periodTimesheets = [];
  _.forEach(periods, (p) => {
    p.timesheets = _.filter(timesheetsData, ({ date }) =>
      dateUtils.isBetween(date, p.startDate, p.endDate, 'day', '[]')
    );
    p.timesheets = _.groupBy(p.timesheets, (timesheet) => getJobcode(timesheet.jobcodeId, jobcodesData)?.name);
    _.forEach(p.timesheets, (jobcodeTimesheets, jobcodeName) => {
      // Assign the duration sum of each months jobcode
      p.timesheets[jobcodeName] = _.reduce(
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
 * Gets the jobcode object from the jobcode ID.
 *
 * @param {Number} jobcodeId - The jobcode ID
 * @param {Array} jobcodes - The jobcodes
 * @returns Object - The jobcode
 */
function getJobcode(jobcodeId, jobcodes) {
  return _.find(jobcodes, (jobcodeObj) => Number(jobcodeObj.id) === Number(jobcodeId));
} // getJobcode

/**
 * Gets the user from timesheets API.
 *
 * @param {Number} employeeId
 * @returns Object - The timesheets user object along with their supplemental data
 */
async function getUser(employeeId) {
  try {
    // set options for TSheet API call
    let options = {
      method: 'GET',
      url: 'https://rest.tsheets.com/api/v1/users',
      params: {
        employee_numbers: employeeId
      },
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    };

    // request data from TSheet API
    let userRequest = await axios(options);
    let userObject = userRequest.data.results.users;
    if (userObject?.length === 0) throw { status: 400, message: 'Invalid employee number' };
    let supplementalObject = userRequest.data.supplemental_data;
    // attach supplemental data to the user object (this contains PTO data)
    let user = _.merge(userObject, supplementalObject);
    return Promise.resolve(user);
  } catch (err) {
    return Promise.reject(err);
  }
} // getUser

/**
 * Gets the user's timesheets within a given time period.
 *
 * @param {String} startDate - The period start date
 * @param {String} endDate - The period end date
 * @param {Number} userId - The unanet personKey
 * @returns Array - All user timesheets within the given time period
 */
async function getTimesheets(startDate, endDate, userId) {
  try {
    let promises = [];
    let timesheets = [];
    let jobcodes = [];
    // get date batches that span 2 months (start of month to the end of the next month) to run in parallel
    let dateBatches = getTimesheetDateBatches(startDate, endDate);
    _.forEach(dateBatches, (dateBatch) => {
      // set options for TSheet API call
      let options = {
        method: 'GET',
        url: 'https://rest.tsheets.com/api/v1/timesheets',
        params: {
          start_date: dateUtils.format(dateBatch.startDate, null, dateUtils.DEFAULT_ISOFORMAT),
          end_date: dateUtils.format(dateBatch.endDate, null, dateUtils.DEFAULT_ISOFORMAT),
          user_ids: userId
        },
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      };
      // request data from TSheet API
      promises.push(axios(options));
    });
    let timesheetResponses = await Promise.all(promises);
    // organize results into an array of data that is only needed
    _.forEach(timesheetResponses, (timesheetResponse) => {
      _.forEach(timesheetResponse.data.results.timesheets, (ts) => {
        timesheets.push({
          id: ts.id,
          userId: ts.user_id,
          jobcodeId: ts.jobcode_id,
          duration: ts.duration,
          date: ts.date
        });
      });
      let jobcodesObj = timesheetResponse.data?.supplemental_data?.jobcodes;
      let arr = _.map(jobcodesObj, (value, key) => {
        return { id: value.id, parentId: value.parent_id, type: value.type, name: value.name };
      });
      jobcodes = [...jobcodes, ...arr];
    });
    return Promise.resolve({ timesheets, jobcodes });
  } catch (err) {
    return Promise.reject(err);
  }
} // getTimesheets

module.exports = {
  handler
};
