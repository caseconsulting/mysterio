// https://tsheetsteam.github.io/api_docs/?javascript--node#request-formats
// https://tsheetsteam.github.io/api_docs/?javascript--node#timesheets
const moment = require('moment');
const axios = require('axios');
const _ = require('lodash');
const ssm = require('./aws-client');
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
  return Math.floor(parseInt(value) / 36) / 100;
}

/*
 * Begin execution of Time Sheets Lambda Function
 */
async function start(event) {
  // get access token from parameter store
  let accessToken = await getSecret('/TSheets/accessToken');
  // variables to filter tsheets api query on
  let employeeNumbers = event.employeeNumber; // 10044 10020
  // get the first day of the month in the proper format
  let firstDay = moment().startOf('month').format(ISOFORMAT);
  // get last day of the month
  let lastDay = moment().endOf('month').format(ISOFORMAT);
  // get todays date
  let today = moment().startOf('day');

  console.info(`today: ` + today.format(ISOFORMAT));

  console.info(`Obtaining time sheets for employees #${employeeNumbers} for this month`);

  console.info(`Getting user data`);

  let page = 1;
  let employeesData = {};
  let employeeMap = {};
  let ptoJobCodeMap = {};
  do {
    // set userOptions for TSheet API call
    let userOptions = {
      method: 'GET',
      url: 'https://rest.tsheets.com/api/v1/users',
      params: {
        employee_numbers: employeeNumbers,
        page: page
      },
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    };

    // request user data from TSheet API
    let employeeRequest = await axios(userOptions);
    employeesData = employeeRequest.data.results.users;

    // create map from user id to employee number
    let currEmployeeMap = _.mapValues(employeesData, (user) => {
      return user.employee_number;
    });

    employeeMap = _.merge(employeeMap, currEmployeeMap);

    // create a map from job code to job name
    let currPtoJobCodeMap = _.mapValues(employeeRequest.data.supplemental_data.jobcodes, (jobCode) => {
      return jobCode.name;
    });

    ptoJobCodeMap = _.merge(ptoJobCodeMap, currPtoJobCodeMap);

    page++;
  } while (_.isEmpty(employeesData));

  if (employeeMap.length === 0) {
    throw new Error(`No users found with employee number ${employeeNumbers}`);
  }

  let jobCodesMap = ptoJobCodeMap;

  console.info(`Getting job code data`);

  page = 1;
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

  // get employee id and employee_number
  let employees = _.map(employeesData, (e) => {
    return { id: e.id, employee_number: e.employee_number };
  });

  // loop all employees
  let i; // loop index
  let previousHours = 0;
  let todaysHours = 0;
  let futureHours = 0;
  let jobcodeHours = {};
  for (i = 0; i < employees.length; i++) {
    console.info(`Getting time sheet data for employee ${employees[i].employee_number} with userId ${employees[i].id}`);

    page = 1;
    let timeSheets = [];
    do {
      // set timeSheetOptions for TSheet API call
      let timeSheetOptions = {
        method: 'GET',
        url: 'https://rest.tsheets.com/api/v1/timesheets',
        params: {
          user_ids: employees[i].id,
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
        timesheet.duration = secondsToHours(timesheet.duration); // convert duration from seconds to hours
        if (moment(timesheet.date, ISOFORMAT).isBefore(today)) { // log previous hours (before today)
          previousHours += timesheet.duration;
        } else if (moment(timesheet.date, ISOFORMAT).isAfter(today)) { // log future hours (afrer today)''
          console.log('inFutute');
          futureHours += timesheet.duration;
        } else { // log todays hours
          console.log('inToday: ' + timesheet.duration);
          todaysHours += timesheet.duration ? timesheet.duration : 0;
        }
        // timesheet.jobcode = jobCodesMap[timesheet.jobcode_id];
        // if the jobcode exists add the duration else set the jobcode duration to the current duration
        jobcodeHours[timesheet.jobcode_id] = jobcodeHours[timesheet.jobcode_id] ? jobcodeHours[timesheet.jobcode_id] + timesheet.duration : timesheet.duration;
      });
      page++;
    } while (timeSheets.length !== 0);
    console.info(`Retrieved time sheets for employee ${employees[i].employee_number}`);
  }

  // map jobcode name to jobcode ids
  let jobcodeHoursMapped = [];
  _.forEach(jobcodeHours, (hours, id) => {
    jobcodeHoursMapped.push({
      jobCodesMap[id] : hours;
    });
  });

  console.info('object returned');
  console.info({
    previousHours,
    todaysHours,
    futureHours,
    jobcodeHours: jobcodeHoursMapped
  });

  // return the translated dataset response
  console.info('Returning time sheet data');

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
