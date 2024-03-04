const axios = require('axios');
const _ = require('lodash');
const dateUtils = require('dateUtils'); // from shared lambda layer
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const ssmClient = new SSMClient({ region: 'us-east-1' });
let accessToken;
/*
 * Access system manager parameter store and return secret value of the given name.
 */
async function getSecret(secretName) {
  const params = {
    Name: secretName,
    WithDecryption: true
  };
  const result = await ssmClient.send(new GetParameterCommand(params));
  return result.Parameter.Value;
} // getSecret

/**
 * Begin execution of timesheet Lambda Function
 *
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 */
async function start(event) {
  try {
    // get access token from parameter store
    accessToken = await getSecret('/TSheets/accessToken');
    let employeeNumber = event.employeeNumber;
    let onlyPto = event.onlyPto;
    let startDate = event.startDate;
    let endDate = event.endDate;
    // get QuickBooks user
    let userData = await getUser(employeeNumber);
    let [userId, user] = Object.entries(userData)[0];
    // convert a user's PTO jobcodes into an array of jobcode Objects
    let ptoJobcodes = _.map(userData.jobcodes, (value, key) => {
      return { id: value.id, parentId: value.parent_id, type: value.type, name: value.name };
    });
    if (onlyPto) {
      // return only PTO jobcodes and early exit
      let ptoBalances = _.mapKeys(user.pto_balances, (value, key) => getJobcode(key, ptoJobcodes)?.name);
      return { statusCode: 200, body: { ptoBalances: ptoBalances } };
    }
    // get Quickbooks user jobcodes and timesheets data
    let [jobcodesData, timesheetsData] = await Promise.all([getJobcodes(), getTimesheets(startDate, endDate, userId)]);
    // merge regular jobcodes with pto jobcodes
    jobcodesData = _.merge(jobcodesData, ptoJobcodes);
    // calculate how many days are entered in the future
    let supplementalData = getSupplementalData(timesheetsData, jobcodesData);
    // group timesheet entries by month and each month by jobcodes with the sum of their duration
    let periodTimesheets = getPeriodTimesheets(timesheetsData, jobcodesData, startDate, endDate);
    // set pto balances
    let ptoBalances = _.mapKeys(user.pto_balances, (value, key) => getJobcode(key, jobcodesData)?.name);
    return Promise.resolve({
      statusCode: 200,
      body: { timesheets: periodTimesheets, ptoBalances: ptoBalances, supplementalData: supplementalData }
    });
  } catch (err) {
    return err;
  }
} // start

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
  let duration = 0;
  let today = dateUtils.getTodaysDate(dateUtils.DEFAULT_ISOFORMAT);
  // get timesheets after today
  let futureTimesheets = _.filter(timesheetsData, (timesheet) => dateUtils.isAfter(timesheet.date, today, 'day'));
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
  let nonBillables = getNonBillableCodes(timesheetsData, jobcodesData);
  return { future: { days, duration }, nonBillables };
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
function getPeriodTimesheets(timesheetsData, jobcodesData, startDate, endDate) {
  // group by month
  let periodTimesheets = _.groupBy(timesheetsData, ({ date }) => dateUtils.format(date, null, 'YYYY-MM'));
  // set each month of the year to empty object
  for (let i = startDate; dateUtils.isSameOrBefore(i, endDate, 'month'); i = dateUtils.add(i, 1, 'month', 'YYYY-MM')) {
    let index = dateUtils.format(i, null, 'YYYY-MM');
    if (!periodTimesheets[index]) {
      periodTimesheets[index] = {};
    }
  }
  // group timesheet entries by jobcode names and duration for each month
  _.forEach(periodTimesheets, (timesheetsArr, month) => {
    // group timesheet entries by jobcode names
    periodTimesheets[month] = _.groupBy(
      timesheetsArr,
      (timesheet) => getJobcode(timesheet.jobcodeId, jobcodesData)?.name
    );
    _.forEach(periodTimesheets[month], (jobcodeTimesheets, jobcodeName) => {
      // Assign the duration sum of each months jobcode
      periodTimesheets[month][jobcodeName] = _.reduce(
        jobcodeTimesheets,
        (sum, timesheet) => {
          return (sum += timesheet.duration);
        },
        0
      );
    });
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
 * Gets all jobcodes that CASE has.
 *
 * @returns Array - All jobcodes
 */
async function getJobcodes() {
  let hasMoreJobcodes = true;
  let page = 1;
  let jobcodesArr = [];
  try {
    // keep looping until QuickBooks returns all pages worth of jobcodes
    while (hasMoreJobcodes) {
      // set options for TSheet API call
      let options = {
        method: 'GET',
        url: 'https://rest.tsheets.com/api/v1/jobcodes',
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      };

      // request data from TSheet API 2 pages at a time
      let [firstRequest, secondRequest] = await Promise.all([
        axios({ ...options, params: { page: page } }),
        axios({ ...options, params: { page: page + 1 } })
      ]);
      let jobcodesObj = _.merge(firstRequest.data.results.jobcodes, secondRequest.data.results.jobcodes);
      jobcodesArr = _.merge(
        jobcodesArr,
        _.map(jobcodesObj, (value, key) => {
          return { id: value.id, parentId: value.parent_id, type: value.type, name: value.name };
        })
      );
      page += 2;
      hasMoreJobcodes = firstRequest.data.more && secondRequest.data.more;
    }
    return Promise.resolve(jobcodesArr);
  } catch (err) {
    return Promise.reject(err);
  }
} // getJobcodes

/**
 * Gets the user's timesheets within a given time period.
 *
 * @param {String} startDate - The period start date
 * @param {String} endDate - The period end date
 * @param {Number} userId - The QuickBooks user ID
 * @returns Array - All user timesheets within the given time period
 */
async function getTimesheets(startDate, endDate, userId) {
  try {
    let promises = [];
    let timesheets = [];
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
    });
    return Promise.resolve(timesheets);
  } catch (err) {
    return Promise.reject(err);
  }
} // getTimesheets

/**
 * Gets an array of time period batches to allow for efficient API calls. Goes 2 months
 * at a time until todays month has been met. When todays date has been met, get todays month through
 * the end date provided.
 *
 * @param {String} startDate - The time period start date
 * @param {String} endDate  - The time period end date
 * @returns Array - The list of start and end date batches to recieve timesheets data for
 */
function getTimesheetDateBatches(startDate, endDate) {
  let batches = [];
  // get start month and the next month
  let startBatchDate = dateUtils.startOf(startDate, 'day');
  let endBatchDate = dateUtils.endOf(dateUtils.add(startDate, 1, 'month', dateUtils.DEFAULT_ISOFORMAT), 'month');
  let today = dateUtils.getTodaysDate(dateUtils.DEFAULT_ISOFORMAT);
  while (dateUtils.isBefore(startBatchDate, endDate, 'month')) {
    batches.push({ startDate: startBatchDate, endDate: endBatchDate });
    // get next 2 months
    startBatchDate = dateUtils.startOf(dateUtils.add(endBatchDate, 1, 'month', dateUtils.DEFAULT_ISOFORMAT), 'month');
    endBatchDate = dateUtils.endOf(dateUtils.add(endBatchDate, 2, 'month', dateUtils.DEFAULT_ISOFORMAT), 'month');
    if (
      dateUtils.isSameOrAfter(startBatchDate, today, 'month') &&
      dateUtils.isBefore(startBatchDate, endDate, 'month')
    ) {
      // push this or next month all the way thoughout the end month
      batches.push({ startDate: startBatchDate, endDate: endDate });
      return batches;
    }
  }
  return batches;
} // getTimesheetDateBatches

/**
 *
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Context doc: https://docs.aws.amazon.com/lambda/latest/dg/nodejs-prog-model-context.html
 * @param {Object} context
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 *
 */
async function handler(event) {
  return start(event);
} // handler

module.exports = { handler };
