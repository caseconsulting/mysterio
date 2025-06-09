// util imports
const axios = require('axios');
const dateUtils = require('dateUtils'); // from shared lambda layer
const { getSecret } = require('./secrets');

// DynamoDB import and setup
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);

// global and stage-based vars
let accessToken;
const STAGE = process.env.STAGE;
const IS_PROD = STAGE === 'prod';
const URL_SUFFIX = IS_PROD ? '' : '-sand';
const BASE_URL = `https://consultwithcase${URL_SUFFIX}.unanet.biz/platform`;
const BILLABLE_CODES = [ "BILL_SVCS" ];

/**
 * TODO
 * - [x] Use getSecret to store login info
 * - [x] Store/retrieve PersonKey in/from Dynamo
 *    - [x] pass this in the event to save the call
 * - [ ] Add check for event dates before summing timeslip (Unanet gives back the whole month)
 * - [ ] Handle yearly calls correctly
 * - [ ] Support onlyPto flag
 * - [ ] Add non-billables
 * - [ ] Get PTO balances
 * - [ ] Update frontend to warn that future PTO in Unanet is not included in the planner
 */

/**
 * Handler for Unanet timesheet data
 *
 * @param {Object} event - The lambda event
 * @returns Object - The timesheet data
 */
async function handler(event) {
  try {
    // pull out some vars from the event
    let onlyPto = event.onlyPto;
    let startDate = event.periods[0].startDate;
    let endDate = event.periods[0].endDate;

    // log in to Unanet
    accessToken = await getAccessToken();
    let personKey = event.unanetPersonKey ?? await getUnanetKey(event.employeeNumber);

    // build the return body
    let { timesheets, supplementalData: timeSupp } = await getTimesheets(startDate, endDate, personKey);
    let { ptoBalances, supplementalData: ptoSupp } = await getPtoBalances(personKey);
    let supplementalData = combineSupplementalData(timeSupp, ptoSupp);

    // return everything together
    return Promise.resolve({
      statusCode: 200,
      body: {
        timesheets,
        ptoBalances,
        supplementalData,
        system: 'Unanet'
      }
    });
  } catch (err) {
    console.log(err);
    return Promise.reject({
      statusCode: 500,
      body: {
        stage: STAGE ?? 'undefined',
        is_prod: IS_PROD ?? 'undefined',
        url: BASE_URL ?? 'undefined',
        api_key: redact(accessToken, 'apikey'),
        err: err ?? 'undefined'
      }
    });
  }
} // handler

/**
 * Helper to redact data
 * 
 * @param data (probably a string) to redact
 * @param type what type of data it is: ['email', 'password', 'apikey']
 */
function redact(data, type) {
  // return early if the data is not there
  if (!data) return data;

  // helper to add stars in place of majority of data
  let sliceHelper = (str, start, end, fill='***') => {
    return str.slice(0, start) + fill + str.slice(-end);
  }

  // redact data based on type
  switch(type) {
    case 'email':
      if (typeof data !== 'string') return 'undefined';
      let email = data.split('@');
      return sliceHelper(email[0], 2, 2) + `@${email[1]}`; // eg. un***pi@consultwithcase.com
      break;
    case 'password':
      if (typeof data !== 'string') return 'undefined';
      return sliceHelper(data, 1, 1); // eg. T***1
      break;
    case 'apikey':
      if (typeof data !== 'string') return 'undefined';
      return sliceHelper(data, 8, 8); // eg. eyJ0eXAi***wLQFeyjA
      break;
  }
} // redact

/**
 * Returns an auth token for the API account.
 * 
 * @returns the auth token
 */
async function getAccessToken() {
  try {
    // get login info from parameter store
    const LOGIN = JSON.parse(await getSecret('/Unanet/login'));
    if (!LOGIN.username || !LOGIN.password) throw new Error('Could not get login info from parameter store');

    // build options to log in with user/pass from parameter store
    let options = {
      method: 'POST',
      url: BASE_URL + '/rest/login',
      data: {
        username: LOGIN.username,
        password: LOGIN.password
      }
    };

    // request data from Unanet API
    let resp = await axios(options);
    
    // actually error if it doesn't work
    if (resp.status > 299) throw new Error(resp);

    return resp.data.token;
  } catch (err) {
    console.log('Failed to get Unanet access token');
    return err;
  }
} // getAccessToken

/**
 * Gets a user's key from Unanet API based on Portal employeeNumber
 * 
 * @param employeeNumber Portal Employee Number
 * @returns Unanet personKey
 */
async function getUnanetKey(employeeNumber) {
  try {
    // build options to find employee based on employeeNumber
    let options = {
      method: 'POST',
      url: BASE_URL + '/rest/people/search',
      data: {
        idCode1: employeeNumber
      },
      headers: { Authorization: `Bearer ${accessToken}` }
    };

    // request data from Unanet API
    let resp = await axios(options);
    if (resp.status > 299) throw new Error(resp);

    // pull out the employee's key
    if (resp.data?.items?.length !== 1) throw new Error(`Could not distinguish Unanet employee ${employeeNumber} (${resp.data.length} options).`);
    let personKey = resp.data.items[0].key;

    // update user's DynamoDB object
    await updateUserPersonKey(employeeNumber, personKey);

    // return for usage now
    return personKey;
  } catch (err) {
    console.log(err);
    return err;
  }
} // getUnanetKey

/**
 * Updates a user's personKey in DynamoDB for future use
 * 
 * @param employeeNumber user's portal employee number
 * @param personKey from Unanet to add to user's profile
 */
async function updateUserPersonKey(employeeNumber, personKey) {
  try {
    // common table for both commands
    const TableName = `${STAGE}-employees`;

    // find the user's ID
    const scanCommand = new ScanCommand({
      ProjectionExpression: 'id',
      ExpressionAttributeValues: { ':n': Number(employeeNumber) },
      FilterExpression: 'employeeNumber = :n',
      TableName
    });
    resp = await docClient.send(scanCommand);
    if (resp.$metadata.httpStatusCode > 299) throw new Error(resp);
    if (resp.Count !== 1) throw new Error(`Could not distinguish Portal employee ${employeeNumber} (${resp.Count} options).`);
    const id = resp.Items[0].id;

    // use their ID to update the personKey
    const updateCommand = new UpdateCommand({ 
      TableName,
      Key: { id },
      UpdateExpression: `set unanetPersonKey = :k`,
      ExpressionAttributeValues: { ':k': `${personKey}` }
    });
    await docClient.send(updateCommand);
  } catch (err) {
    console.log(`Failed to update entry personKey of ${personKey} in ${STAGE}-employees of employee ${employeeNumber}`);
    return err;
  }
} // updateUserPersonKey


/**
 * Combines any number of supplemental datas
 * 
 * @param supps the supplemental data objects
 * @returns combined supplementalData object
 */
function combineSupplementalData(...supps) {
  // base default to make sure everything has at least some data
  let combined = { today: 0, future: { days: 0, duration: 0 }, nonBillables: [] };

  // loop through all supplemental data and combine it
  for(let supp of supps) {
    if(!supp) continue; // avoid error if it's undefined
    combined.today += supp.today ?? 0;
    combined.nonBillables = [...new Set([...combined.nonBillables, ...supp.nonBillables ?? []])];
    combined.future.days += supp.future?.days ?? 0;
    combined.future.duration += supp.future?.duration ?? 0;
  }

  return combined;
} // combineSupplementalData

/**
 * Gets timesheet data by calling helper functions
 * 
 * @param startDate Start date (inclusive) of timesheet data
 * @param endDate End date (inclusive) of timesheet data
 * @param userId Unanet ID of user
 * @returns user's timesheets and maybe supplemental data
 */
async function getTimesheets(startDate, endDate, userId) {
  // get data from Unanet
  let basicTimesheets = await getRawTimesheets(startDate, endDate, userId);
  let filledTimesheets = await fillTimesheetData(basicTimesheets);

  // helpful vars
  let today = dateUtils.getTodaysDate();
  let isToday = (date) => dateUtils.isSame(date, today, 'day');
  let isFuture = (date) => dateUtils.isAfter(date, today, 'day');
  let hoursToSeconds = (hours) => hours * 60 * 60;

  // put data in Portal format
  let supplementalData = {};
  let nonBillables = new Set();
  let timesheets = [];
  let timesheet;
  for (let month of filledTimesheets) {
    // fill in basic data
    timesheet = {
      startDate: month.timePeriod.beginDate,
      endDate: month.timePeriod.endDate,
      title: dateUtils.format(month.timePeriod.beginDate, null, 'MMMM'),
      timesheets: {}
    }

    // loop through 'timeslips' (there's one per labor category per day) and tally up for each job code
    for(let slip of month.timeslips) {
      // add the hours worked for the project
      let jobCode = getProjectName(slip.project.name);
      timesheet.timesheets[jobCode] ??= 0;
      timesheet.timesheets[jobCode] += hoursToSeconds(Number(slip.hoursWorked));

      // add bill code to non-billables if it is not marked as billable
      if (!BILLABLE_CODES.includes(slip.projectType.name)) {
        nonBillables.add(jobCode);
      }

      // if this slip is for today, add it to supplementalData
      if (isToday(slip.workDate)) {
        supplementalData.today ??= 0;
        supplementalData.today += hoursToSeconds(Number(slip.hoursWorked));
      }

      // if this slip is for the future, add it to supplementalData
      if (isFuture(slip.workDate)) {
        supplementalData.future ??= { days: 0, duration: 0 };
        supplementalData.future.days += 1;
        supplementalData.future.duration += hoursToSecondsNumber(Number(slip.hoursWorked));
      }
    }

    // add timesheet to array
    timesheets.push(timesheet);
  }

  // add seen non-billables to supplementalData
  supplementalData.nonBillables = Array.from(nonBillables);

  // give back finished result
  return { timesheets, supplementalData };
} // getTimesheets

/**
 * Gets the project name, without any decimals or numbers.
 * Eg. converts "9876.54.32.PROJECT.OY1" to "PROJECT OY1"
 * 
 * @param projectName Name of the project, for converting
 * @returns More human-friendly project name for Portal
 */
function getProjectName(projectName) {
  // split up each part and remove any parts that are all digits
  let parts = projectName.split('.');
  // remove part if it's just numbers
  for (let i = 0; i < parts.length; i++)
    if (/^\d+$/g.test(parts[i]))
      parts.splice(i--, 1); // post-decrement keeps i correct after splice
  // return leftover parts and remove any extra whitespace
  return parts.join(' ').replaceAll(/ +/g, ' ');
} // getProjectName

/**
 * Gets the user's timesheets within a given time period.
 *
 * @param {String} startDate - The period start date
 * @param {String} endDate - The period end date
 * @param {Number} userId - The unanet personKey
 * @returns Array of all user timesheets within the given time period
 */
async function getRawTimesheets(startDate, endDate, userId) {
  try {
    // build options to search for user's time within the start and end dates
    let options = {
      method: 'POST',
      url: BASE_URL + '/rest/time/search',
      data: {
        personKeys: [userId],
        beginDateStart: startDate,
        beginDateEnd: endDate
      },
      headers: { Authorization: `Bearer ${accessToken}` }
    };

    // get response and just return it
    let resp = await axios(options);
    return resp.data.items
  } catch (err) {
    throw new Error(err);
  }
} // getRawTimesheets

/**
 * Fills the timesheets with jobcode data.
 * 
 * @param timesheets timesheets from getRawTimesheets
 * @returns timesheets with jobcode data added
 */
async function fillTimesheetData(timesheets) {
  try {
    // build and run promises all at once
    let promises = [];
    let headers = { Authorization: `Bearer ${accessToken}` };
    for (let sheet of timesheets) promises.push(axios.get(BASE_URL + `/rest/time/${sheet.key}`, { headers }));
    let resp = await Promise.all(promises);

    // pull out response data and return it all together
    let jobcodes = resp.map(res => res.data);
    return jobcodes;
  } catch (err) {
    throw new Error(err);
  }
} // fillTimesheetData

/**
 * Gets a user's PTO balances
 * 
 * @param userId Unanet ID of user
 * @return PTO balances and maybe supplemental data
 */ 
async function getPtoBalances(userId) {
  return {
    ptoBalances: {
      "Holiday": 0,
      "Training": 0,
      "PTO": 0,
      "Jury Duty": 0,
      "Maternity/Paternity Time Off": 0,
      "Bereavement": 0
    },
    supplementalData: {}
  };
} // getPtoBalances

module.exports = {
  handler
};
