// https://tsheetsteam.github.io/api_docs/?javascript--node#request-formats
// https://tsheetsteam.github.io/api_docs/?javascript--node#timesheets
const moment = require('moment-timezone');
const axios = require('axios');
const _ = require('lodash');
const ssm = require('./aws-client');

moment.tz.setDefault("America/New_York");
const ISOFORMAT = 'YYYY-MM-DD';

/*
 * Access system manager parameter store and return secret value of the given name.
 */
async function getSecret(secretName) {
  const params = {
    Name: secretName,
    WithDecryption: true
  };
  const result = await ssm.getParameter(params).promise();
  return result.Parameter.Value;
}

/*
 * Converts seconds to hours to the lower bound 2 decimal place.
 */
function secondsToHours(value) {
  return Number((Math.floor(parseInt(value) / 36) / 100).toFixed(2));
}

/*
 * Begin execution of Time Sheets Lambda Function
 */
async function start(event) {
  // get access token from parameter store
  let accessToken = await getSecret('/TSheets/accessToken');
  // variables to filter tsheets api query on
  let employeeNumber = event.employeeNumber; // 10044 10020
  // get the first day of the month in the proper format
  let firstDay = moment().startOf('month').format(ISOFORMAT);
  // get last day of the month
  let lastDay = moment().endOf('month').format(ISOFORMAT);
  // get todays date
  let todayStart = moment().startOf('day');
  let todayEnd = moment().endOf('day');

  console.info(`Obtaining hourly time charges for employee #${employeeNumber} for this month`);

  console.info(`Getting user data`);

  let employeeNums = employeeNumber.split(',');
  if (employeeNums.length < 1) {
    throw new Error(`Missing employee number`);
  } else if (employeeNums.length > 1) {
    throw new Error(`Cannot query more than 1 employee number`);
  }

  // set userOptions for TSheet API call
  let userOptions = {
    method: 'GET',
    url: 'https://rest.tsheets.com/api/v1/users',
    params: {
      employee_numbers: employeeNumber
    },
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  };

  // request user data from TSheet API
  let employeeRequest = await axios(userOptions);

  // get employee id
  let employeeIds = Object.keys(employeeRequest.data.results.users);

  // throw error if no users found
  if (_.isEmpty(employeeIds)) {
    throw new Error(`No users found with employee number ${employeeNumber}`);
  }

  let employeeId = employeeIds[0];

  console.info(`EmployeeId: ${employeeId}`);

  // get data for employee id
  let employeeData = employeeRequest.data.results.users[employeeId];

  // create a map from job code to job name
  let jobCodesMap = _.mapValues(employeeRequest.data.supplemental_data.jobcodes, (jobCode) => {
    return jobCode.name;
  });

  console.info(`Getting job code data`);

  let page = 1;
  let jobCodeData = [];
  do {
    // set jobCodeOptions for TSheet API call
    let jobCodeOptions = {
      method: 'GET',
      url: 'https://rest.tsheets.com/api/v1/jobcodes',
      params: {
        page: page
      },
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    };

    // request job code data from TSheet API
    let jobCodeRequest = await axios(jobCodeOptions);
    jobCodeData = jobCodeRequest.data.results.jobcodes;

    // create a map from job code to job name
    let currJobCodesMap = _.mapValues(jobCodeData, (jobCode) => {
      return jobCode.name;
    });

    jobCodesMap = _.merge(jobCodesMap, currJobCodesMap);
    page++;
  } while (jobCodeData.length !== 0);

  // loop all employees
  let previousHours = 0;
  let todaysHours = 0;
  let futureHours = 0;
  let jobcodeHours = {};

  console.info(`Getting hourly data for employee ${employeeNumber} with userId ${employeeId}`);

  page = 1;
  let timeSheets = [];
  do {
    // set timeSheetOptions for TSheet API call
    let timeSheetOptions = {
      method: 'GET',
      url: 'https://rest.tsheets.com/api/v1/timesheets',
      params: {
        user_ids: employeeId,
        start_date: firstDay,
        end_date: lastDay,
        on_the_clock: 'both',
        page: page
      },
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    };

    // request time sheets data from TSheet API
    let tSheetsResponse = await axios(timeSheetOptions);
    timeSheets = tSheetsResponse.data.results.timesheets;

    _.forEach(timeSheets, (timesheet) => {
      // get todays hours of currently clocked in time sheet
      let duration = timesheet.duration ? timesheet.duration : moment.duration(moment().diff(moment(timesheet.start))).as('seconds');

      // let duration = timesheet.duration;

      if (moment(timesheet.date, ISOFORMAT).isBefore(todayStart)) {
        // log previous hours (before today)
        previousHours += duration;
      } else if (moment(timesheet.date, ISOFORMAT).isAfter(todayEnd)) {
        // log future hours (after today)''
        futureHours += duration;
      } else {
        // log todays hours
        todaysHours += duration;
      }

      // if the jobcode exists add the duration else set the jobcode duration to the current duration
      jobcodeHours[timesheet.jobcode_id] = jobcodeHours[timesheet.jobcode_id]
        ? jobcodeHours[timesheet.jobcode_id] + duration
        : duration;
    });

    page++;
  } while (timeSheets.length !== 0);

  console.info(`Retrieved time sheet hours for employee ${employeeNumber}`);

  console.info('Converting seconds to hours');
  previousHours = secondsToHours(previousHours); // convert previous hours from secs to hrs
  futureHours = secondsToHours(futureHours); // convert future hours from secs to hrs
  todaysHours = secondsToHours(todaysHours); // convert todays hours from secs to hrs

  // map jobcode name to jobcode ids
  console.info('Converting jobcode ids to names and seconds to hours');
  let jobcodeHoursMapped = [];
  _.forEach(jobcodeHours, (seconds, id) => {
    let name = jobCodesMap[id];
    let hours = secondsToHours(seconds); // convert duration from seconds to hours
    jobcodeHoursMapped.push({
      name,
      hours
    });
  });

  // sort jobcodes by name
  jobcodeHoursMapped = _.sortBy(jobcodeHoursMapped, (jobcode) => {
    return jobcode.name;
  });

  console.info('Returning tSheets monthly hour time charges');

  // return the translated dataset response
  return {
    statusCode: 200,
    body: {
      previousHours,
      todaysHours,
      futureHours,
      jobcodeHours: jobcodeHoursMapped
    }
  };
}

/**
 *
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Context doc: https://docs.aws.amazon.com/lambda/latest/dg/nodejs-prog-model-context.html
 * @param {Object} context
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 *
 */
async function handler(event, context) {
  return start(event);
}

module.exports = { handler };
