// https://tsheetsteam.github.io/api_docs/?javascript--node#request-formats
// https://tsheetsteam.github.io/api_docs/?javascript--node#timesheets
const axios = require('axios');
const _ = require('lodash');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const ssmClient = new SSMClient({ region: 'us-east-1' });
const dateUtils = require('dateUtils'); // from shared lambda layer

const ISOFORMAT = 'YYYY-MM-DD';

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
  let accessToken = '';
  // variables to filter tsheets api query on
  let employeeNumber = event.employeeNumber; // 10044   OR   54
  let isFireTeam = parseInt(employeeNumber) < 100;
  let isFirstPeriod;
  // get access token from parameter store
  if (isFireTeam) {
    isFirstPeriod = dateUtils.getDay(dateUtils.getTodaysDate()) < 16;
    accessToken = await getSecret('/TSheets/FireTeam/accessToken');
    console.info('Getting FireTeam access code with ' + employeeNumber + ' employee number');
  } else {
    accessToken = await getSecret('/TSheets/accessToken');
    console.info('Getting CASE access code with ' + employeeNumber + ' employee number');
  }

  //let firstDay;
  let lastDay, firstDayPreviousPeriod, lastDayPreviousPeriod;

  if (isFireTeam) {
    if (isFirstPeriod) {
      // get first day of the month
      // firstDay = dateUtils.format(dateUtils.setDay(dateUtils.getTodaysDate(ISOFORMAT), 1), null, ISOFORMAT);
      // get 15th of the month
      lastDay = dateUtils.format(dateUtils.setDay(dateUtils.getTodaysDate(ISOFORMAT), 15), null, ISOFORMAT);
      // get the 16th day of the previous  month
      firstDayPreviousPeriod = dateUtils.format(
        dateUtils.setDay(dateUtils.subtract(dateUtils.getTodaysDate(ISOFORMAT), 1, 'month'), 16),
        null,
        ISOFORMAT
      );
      // get last day of the previous month
      lastDayPreviousPeriod = dateUtils.format(
        dateUtils.endOf(dateUtils.subtract(dateUtils.getTodaysDate(ISOFORMAT), 1, 'month'), 'month'),
        null,
        ISOFORMAT
      );
    } else {
      // get 16th of the month
      // firstDay = dateUtils.format(dateUtils.setDay(dateUtils.getTodaysDate(ISOFORMAT), 16), null, ISOFORMAT);
      // get last day of the month
      lastDay = dateUtils.format(dateUtils.endOf(dateUtils.getTodaysDate(ISOFORMAT), 'month'), null, ISOFORMAT);
      // get the first day of the month
      firstDayPreviousPeriod = dateUtils.format(
        dateUtils.setDay(dateUtils.getTodaysDate(ISOFORMAT), 1),
        null,
        ISOFORMAT
      );
      // get the 15th of the month
      lastDayPreviousPeriod = dateUtils.format(
        dateUtils.setDay(dateUtils.getTodaysDate(ISOFORMAT), 15),
        null,
        ISOFORMAT
      );
    }
  } else {
    // get the first day of the month
    // firstDay = dateUtils.format(dateUtils.startOf(dateUtils.getTodaysDate(ISOFORMAT), 'month'), null, ISOFORMAT);
    // get last day of the month
    lastDay = dateUtils.format(dateUtils.endOf(dateUtils.getTodaysDate(ISOFORMAT), 'month'), null, ISOFORMAT);
    // get first day of the previous month
    firstDayPreviousPeriod = dateUtils.format(
      dateUtils.startOf(dateUtils.subtract(dateUtils.getTodaysDate(ISOFORMAT), 1, 'month'), 'month'),
      null,
      ISOFORMAT
    );
    // get last day of the previous month
    lastDayPreviousPeriod = dateUtils.format(
      dateUtils.endOf(dateUtils.subtract(dateUtils.getTodaysDate(ISOFORMAT), 1, 'month'), 'month'),
      null,
      ISOFORMAT
    );
  }

  // get todays date
  let todayStart = dateUtils.startOf(dateUtils.getTodaysDate(ISOFORMAT), 'day');
  let todayEnd = dateUtils.endOf(dateUtils.getTodaysDate(ISOFORMAT), 'day');

  console.info(`Obtaining hourly time charges for employee #${employeeNumber} for this month`);

  console.info('Getting user data');

  let employeeNums = employeeNumber.split(',');
  if (employeeNums.length < 1) {
    throw new Error('Missing employee number');
  } else if (employeeNums.length > 1) {
    throw new Error('Cannot query more than 1 employee number');
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
  // let employeeData = employeeRequest.data.results.users[employeeId];

  // create a map from job code to job name
  let jobCodesMap = _.mapValues(employeeRequest.data.supplemental_data.jobcodes, (jobCode) => {
    return jobCode.name;
  });

  console.info('Getting job code data');

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
  } while (!_.isEmpty(jobCodeData));

  // loop all employees
  let previousHours = 0;
  let previousPeriodHours = 0;
  let todaysHours = 0;
  let futureHours = 0;
  let jobcodeHours = {};
  let previousPeriodJobcodeHours = {};

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
        start_date: firstDayPreviousPeriod,
        end_date: lastDay,
        //on_the_clock: 'both',
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
      let duration;
      if (timesheet.duration) {
        duration = timesheet.duration;
      } else {
        duration = dateUtils.difference(
          dateUtils.getTodaysDate(ISOFORMAT),
          dateUtils.format(timesheet.start, null, 'yyyy-mm-dd hh:mm:ss'),
          null,
          null
        );
      }

      if (dateUtils.isSameOrBefore(dateUtils.format(timesheet.date, null, ISOFORMAT), lastDayPreviousPeriod)) {
        // log previous months hours
        previousPeriodHours += duration;
      } else if (dateUtils.isBefore(dateUtils.format(timesheet.date, null, ISOFORMAT), todayStart)) {
        // log previous hours (before today) from this month
        previousHours += duration;
      } else if (dateUtils.isAfter(dateUtils.format(timesheet.date, null, ISOFORMAT), todayEnd)) {
        // log future hours (after today)''
        futureHours += duration;
      } else {
        // log todays hours
        todaysHours += duration;
      }

      if (dateUtils.isSameOrBefore(dateUtils.format(timesheet.date, null, ISOFORMAT), lastDayPreviousPeriod)) {
        // if the jobcode exists add the duration else set the jobcode duration to the current duration
        previousPeriodJobcodeHours[timesheet.jobcode_id] = previousPeriodJobcodeHours[timesheet.jobcode_id]
          ? previousPeriodJobcodeHours[timesheet.jobcode_id] + duration
          : duration;
      } else {
        // if the jobcode exists add the duration else set the jobcode duration to the current duration
        jobcodeHours[timesheet.jobcode_id] = jobcodeHours[timesheet.jobcode_id]
          ? jobcodeHours[timesheet.jobcode_id] + duration
          : duration;
      }
    });

    page++;
  } while (!_.isEmpty(timeSheets));

  console.info(`Retrieved time sheet hours for employee ${employeeNumber}`);

  console.info('Converting seconds to hours');
  previousHours = secondsToHours(previousHours); // convert previous hours from secs to hrs
  previousPeriodHours = secondsToHours(previousPeriodHours); // convert previous month's hours from secs to hrs
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

  let previousPeriodJobcodeHoursMapped = [];
  _.forEach(previousPeriodJobcodeHours, (seconds, id) => {
    let name = jobCodesMap[id];
    let hours = secondsToHours(seconds); // convert duration from seconds to hours
    previousPeriodJobcodeHoursMapped.push({
      name,
      hours
    });
  });

  // sort jobcodes by name
  jobcodeHoursMapped = _.sortBy(jobcodeHoursMapped, (jobcode) => {
    return jobcode.name;
  });

  previousPeriodJobcodeHoursMapped = _.sortBy(previousPeriodJobcodeHoursMapped, (jobcode) => {
    return jobcode.name;
  });

  console.info('Returning tSheets monthly hour time charges');

  // return the translated dataset response
  return {
    statusCode: 200,
    body: {
      previousHours,
      previousPeriodHours,
      todaysHours,
      futureHours,
      jobcodeHours: jobcodeHoursMapped,
      previousPeriodJobcodeHours: previousPeriodJobcodeHoursMapped
    }
  };
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
