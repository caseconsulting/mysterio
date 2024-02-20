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

/*
 * Begin execution of Jobcodes Lambda Function
 */
async function start(event) {
  try {
    // get access token from parameter store
    accessToken = await getSecret('/TSheets/accessToken');
    let employeeNumber = event.employeeNumber;
    let startDate = event.startDate;
    let endDate = event.endDate;
    // get QuickBooks user
    let userData = await getUser(employeeNumber);
    let [userId, user] = Object.entries(userData)[0];
    // get Quickbooks user jobcodes and timesheets data
    let [jobcodesData, timesheetsData] = await Promise.all([getJobcodes(), getTimesheets(startDate, endDate, userId)]);
    // convert a user's PTO jobcodes into an array of jobcode Objects
    let ptoJobcodes = _.map(userData.jobcodes, (value, key) => value);
    // merge regular jobcodes with pto jobcodes
    jobcodesData = _.merge(jobcodesData, ptoJobcodes);
    // group timesheet entries by month and each month by jobcodes with the sum of their duration
    let monthlyTimesheets = getMonthlyTimesheets(timesheetsData, jobcodesData, startDate, endDate);
    // set pto balances
    let ptoBalances = _.mapKeys(user.pto_balances, (value, key) => getJobcodeName(key, jobcodesData));
    return Promise.resolve({
      statusCode: 200,
      body: { timesheets: monthlyTimesheets, ptoBalances: ptoBalances }
    });
  } catch (err) {
    return err;
  }
}

function getMonthlyTimesheets(timesheetsData, jobcodesData, startDate, endDate) {
  // group by month
  let monthlyTimesheets = _.groupBy(timesheetsData, ({ date }) => dateUtils.format(date, null, 'YYYY-MM'));
  // set each month of the year to empty object
  for (let i = startDate; dateUtils.isSameOrBefore(i, endDate, 'month'); i = dateUtils.add(i, 1, 'month', 'YYYY-MM')) {
    let index = dateUtils.format(i, null, 'YYYY-MM');
    if (!monthlyTimesheets[index]) {
      monthlyTimesheets[index] = {};
    }
  }
  // group timesheet entries by jobcode names and duration for each month
  _.forEach(monthlyTimesheets, (timesheetsArr, month) => {
    // group timesheet entries by jobcode names
    monthlyTimesheets[month] = _.groupBy(timesheetsArr, (timesheet) =>
      getJobcodeName(timesheet.jobcodeId, jobcodesData)
    );
    _.forEach(monthlyTimesheets[month], (jobcodeTimesheets, jobcodeName) => {
      // Assign the duration sum of each months jobcode
      monthlyTimesheets[month][jobcodeName] = _.reduce(
        jobcodeTimesheets,
        (sum, timesheet) => {
          return (sum += timesheet.duration);
        },
        0
      );
    });
  });
  return monthlyTimesheets;
}

function getJobcodeName(jobcodeId, jobcodes) {
  return _.find(jobcodes, (jobcodeObj) => Number(jobcodeObj.id) === Number(jobcodeId))?.name;
}

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
    let user = _.merge(userObject, supplementalObject);
    return Promise.resolve(user);
  } catch (err) {
    return Promise.reject(err);
  }
}

async function getJobcodes() {
  try {
    // set options for TSheet API call
    let options = {
      method: 'GET',
      url: 'https://rest.tsheets.com/api/v1/jobcodes',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    };

    // request data from TSheet API
    let jobcodeRequest = await axios(options);
    let jobcodesObj = jobcodeRequest.data.results.jobcodes;
    let jobcodesArr = _.map(jobcodesObj, (value, key) => value);
    return Promise.resolve(jobcodesArr);
  } catch (err) {
    return Promise.reject(err);
  }
}

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
}

function getTimesheetDateBatches(startDate, endDate) {
  let batches = [];
  let startBatchDate = dateUtils.startOf(startDate, 'day');
  let endBatchDate = dateUtils.endOf(dateUtils.add(startDate, 1, 'month', dateUtils.DEFAULT_ISOFORMAT), 'month');
  let today = dateUtils.getTodaysDate(dateUtils.DEFAULT_ISOFORMAT);
  while (dateUtils.isBefore(startBatchDate, endDate, 'month')) {
    batches.push({ startDate: startBatchDate, endDate: endBatchDate });
    startBatchDate = dateUtils.startOf(dateUtils.add(endBatchDate, 1, 'month', dateUtils.DEFAULT_ISOFORMAT), 'month');
    endBatchDate = dateUtils.endOf(dateUtils.add(endBatchDate, 2, 'month', dateUtils.DEFAULT_ISOFORMAT), 'month');
    if (
      dateUtils.isSameOrAfter(startBatchDate, today, 'month') &&
      dateUtils.isBefore(startBatchDate, endDate, 'month')
    ) {
      batches.push({ startDate: startBatchDate, endDate: endDate });
      return batches;
    }
  }
  return batches;
}

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
}

module.exports = { handler };
