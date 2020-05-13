// https://tsheetsteam.github.io/api_docs/?javascript--node#request-formats
// https://tsheetsteam.github.io/api_docs/?javascript--node#timesheets
const axios = require('axios');
const _ = require('lodash');
const ssm = require('./aws-client');

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
  var accessToken = await getSecret('/TSheets/accessToken');

  // variables to filter tsheets api query on
  var employeeNumbers = event.pathParameters.employeeNumber; // 10044 10020
  var startDate = event.pathParameters.startDate;
  var endDate = event.pathParameters.endDate;

  console.info(`Obtaining time sheets for employees #${employeeNumbers} from ${startDate} to ${endDate}`);

  console.info(`Getting user data`);

  // set userOptions for TSheet API call
  var userOptions = {
    method: 'GET',
    url: 'https://rest.tsheets.com/api/v1/users',
    params: {
      employee_numbers: employeeNumbers
    },
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  };

  // request user data from TSheet API
  let employeeRequest = await axios(userOptions);
  let employeesData = employeeRequest.data.results.users;

  // create a map from job code to job name
  let ptoJobCodeMap = _.mapValues(employeeRequest.data.supplemental_data.jobcodes, jobCode => {
    return jobCode.name;
  });

  console.info(`Getting job code data`);

  // set jobCodeOptions for TSheet API call
  var jobCodeOptions = {
    method: 'GET',
    url: 'https://rest.tsheets.com/api/v1/jobcodes',
    headers: {
     Authorization: `Bearer ${accessToken}`
    }
  };

  // request job code data from TSheet API
  let jobCodeRequest = await axios(jobCodeOptions);
  let jobCodeData = jobCodeRequest.data.results.jobcodes;

  // create a map from job code to job name
  let jobCodesMap = _.mapValues(jobCodeData, jobCode => {
    return jobCode.name;
  });

  jobCodesMap = _.merge(jobCodesMap, ptoJobCodeMap);

  // get employee id and employee_number
  let employees = _.map(employeesData, e => {
    return {id: e.id, employee_number: e.employee_number};
  });

  let allTimeSheets = [];

  // loop all employees
  let i; // loop index
  for(i = 0; i < employees.length; i++) {

    console.info(`Getting time sheet data for employee ${employees[i].employee_number} with userId ${employees[i].id}`);

    // set timeSheetOptions for TSheet API call
    var timeSheetOptions = {
      method: 'GET',
      url: 'https://rest.tsheets.com/api/v1/timesheets',
      params: {
        user_ids: employees[i].id,
        start_date: startDate,
        end_date: endDate,
        on_the_clock: 'both',
      },
      headers:
       {
         'Authorization': `Bearer ${accessToken}`,
       }
    };

    // request time sheets data from TSheet API
    let tSheetsResponse = await axios(timeSheetOptions);
    let timeSheets = tSheetsResponse.data.results.timesheets;

    console.info(`Retrieved time sheets for employee ${employees[i].employee_number}`);

    // translate duration from seconds to hours
    console.info('Translating time sheet duration from seconds to hours');

    _.forEach(timeSheets, timesheet => {
      timesheet.duration = secondsToHours(timesheet.duration); // convert duration from seconds to hours
      timesheet.jobcode = jobCodesMap[timesheet.jobcode_id];
      allTimeSheets.push(timesheet); // add to array of all time sheets
    });
  }

  // return the translated dataset response
  console.info('Returning time sheet data');

  return {
    statusCode: 200,
    body: JSON.stringify(allTimeSheets)
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
