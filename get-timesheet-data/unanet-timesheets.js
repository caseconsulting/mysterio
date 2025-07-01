/**
 * 
 * Unanet Swagger API: https://consultwithcase-sand.unanet.biz/platform/swagger/
 * Rate limit: 5000 calls per day
 * 
 */

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
const URL_SUFFIX = STAGE === 'prod' ? '' : '-sand';
const BASE_URL = `https://consultwithcase${URL_SUFFIX}.unanet.biz/platform`;
const BILLABLE_CODES = ["BILL_SVCS"];

let APICalls = 0;

/**
 * Done:
 * - [x] Use getSecret to store login info
 * - [x] Store/retrieve PersonKey in/from Dynamo
 * - [x] Pass personkey in the event to save an API call
 * - [x] Add non-billables
 * - [x] Add check for event dates before summing timeslip
 * - [x] Support onlyPto flag
 * - [x] Make title according to passed in titles
 * - [x] Handle yearly calls correctly
 * - [x] How does the frontend react to a period's timesheets being `{}`?
 * - [x] Update frontend to warn that future PTO in Unanet is not included in the planner
 * - [x] Handle Unanet going down vs code crashing
 * - [x] Get PTO data from API
 * 
 * Today:
 * - [ ] Get PTO balances using CSV
 *    - [ ] upload report in front end
 *    - [ ] download report in lambda
 *    - [ ] get date of front-end upload
 *    - [ ] math through timesheets and upload to show correct balance
 *    - [ ] come up with consistent method for them to know when to upload
 * 
 * Future:
 * - [ ] Warehouse API data from previous months (only get 2 months via API)
 * - [ ] Make efficient calls for multiple users (will be doing entire company at some point)
 * - [ ] Input validation
 * 
 */

/**
 * Handler for Unanet timesheet data
 *
 * @param event - The lambda event
 * @returns Object - The timesheet data
 */
async function handler(event) {
  try {
    // pull out vars from the event
    let { onlyPto, periods, unanetPersonKey, employeeNumber } = event;
    
    // log in to Unanet
    accessToken = await getAccessToken();
    unanetPersonKey ??= await getUnanetPersonKey(employeeNumber);

    // build the return body
    let body = { system: 'Unanet' };
    if (onlyPto) {
      let { ptoBalances } = await getPtoBalances(unanetPersonKey);
      body.ptoBalances = ptoBalances;
    } else {
      let { timesheets, supplementalData: timeSupp } = await getPeriodTimesheets(periods, unanetPersonKey);
      let { ptoBalances, supplementalData: ptoSupp } = await getPtoBalances(unanetPersonKey);
      let supplementalData = combineSupplementalData(timeSupp, ptoSupp);
      body = { ...body, timesheets, ptoBalances, supplementalData }
    }

    // return everything together
    return Promise.resolve({ statusCode: 200, APICalls, body });
  } catch (err) {
    return Promise.reject(await handleError(err));
  }
} // handler

/**
 * Gets timesheet data for a given array of periods and a Unanet user
 * 
 * @param periods array of periods to get data for
 * @param userId Unanet key of user to get data for
 * @returns timesheets and supplemental data for all periods
 */
async function getPeriodTimesheets(periods, userId) {
  // get timesheets and data for all periods
  let timesheets = [];
  let supplDatas = [];
  for (let period of periods) {
    let { startDate, endDate, title } = period;
    let { timesheet, supplementalData } = await getTimesheet(startDate, endDate, title, userId);
    timesheets.push(timesheet);
    supplDatas.push(supplementalData);
  }

  // combine all supplemental data and return everything
  let supplementalData = combineSupplementalData(...supplDatas);
  return { timesheets, supplementalData };
} // getPeriodTimesheets

/**
 * Creates a timesheet object for a given period
 * 
 * @param startDate Start date (inclusive) of timesheet data
 * @param endDate End date (inclusive) of timesheet data
 * @param title title of the timesheet
 * @param userId Unanet ID of user
 * @returns timesheet object between start and end dates
 */
async function getTimesheet(startDate, endDate, title, userId) {
  // get data from Unanet
  let basicTimesheets = await getRawTimesheets(startDate, endDate, userId); // returns monthly blocks
  let filledTimesheets = await getFullTimesheets(basicTimesheets); // returns monthly blocks with paycodes

  // helpful vars
  let today = dateUtils.getTodaysDate();
  let isToday = (date) => dateUtils.isSame(date, today, 'day');
  let isFuture = (date) => dateUtils.isAfter(date, today, 'day');
  let hoursToSeconds = (hours) => hours * 60 * 60;

  // vars to fill in
  let supplementalData = {};
  let nonBillables = new Set();
  let timesheet = { startDate, endDate, title, timesheets: {} }

  // loop through each month returned from Unanet API
  for (let month of filledTimesheets) {
    // loop through 'timeslips' (there's one per labor category per day) and tally up for each job code
    for (let slip of month.timeslips) {
      // skip slips that are past the end date or before the start date
      let beforeStart = dateUtils.isBefore(slip.workDate, startDate, 'day');
      let afterEnd = dateUtils.isAfter(slip.workDate, endDate, 'day');
      if (beforeStart || afterEnd) continue;

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
        supplementalData.future.duration += hoursToSeconds(Number(slip.hoursWorked));
      }
    }
  }

  // add seen non-billables to supplementalData
  supplementalData.nonBillables = Array.from(nonBillables);

  // give back finished result
  return { timesheet, supplementalData };
} // getTimesheet

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

/**
 * Updates a user's personKey in DynamoDB for future use
 * 
 * @param employeeNumber user's portal employee number
 * @param personKey from Unanet to add to user's profile
 */
async function updateUserPersonKey(employeeNumber, personKey) {
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
} // updateUserPersonKey

// |----------------------------------------------------|
// |                                                    |
// |                  API CONNECTIONS                   |
// |                                                    |
// |----------------------------------------------------|

/**
 * Returns an auth token for the API account
 * 
 * @returns the auth token
 */
async function getAccessToken() {
  // get login info from parameter store
  let { username, password } = JSON.parse(await getSecret('/Unanet/login'));
  if (!username || !password) throw new Error('Could not get login info from parameter store.');

  // build options to log in with user/pass from parameter store
  let options = {
    method: 'POST',
    url: BASE_URL + '/rest/login',
    data: { username, password }
  };

  // request and return token from Unanet API
  let resp = await axios(options);
  APICalls++;
  return resp.data.token;
} // getAccessToken

/**
 * Gets a user's key from Unanet API based on Portal employeeNumber
 * 
 * @param employeeNumber Portal Employee Number
 * @returns Unanet personKey
 */
async function getUnanetPersonKey(employeeNumber) {
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
  APICalls++;

  // pull out the employee's key
  if (resp.data?.items?.length !== 1) throw new Error(`Could not distinguish Unanet employee ${employeeNumber} (${resp.data.length} options).`);
  let personKey = resp.data.items[0].key;

  // update user's DynamoDB object and return for usage now
  await updateUserPersonKey(employeeNumber, personKey);
  return personKey;
} // getUnanetPersonKey

/**
 * Gets the user's timesheets within a given time period
 *
 * @param startDate - The period start date
 * @param endDate - The period end date
 * @param userId - The unanet personKey
 * @returns Array of all user timesheets within the given time period
 */
async function getRawTimesheets(startDate, endDate, userId) {
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
  APICalls++;
  return resp.data.items;
} // getRawTimesheets

/**
 * Fills the timesheets with jobcode data
 * 
 * @param timesheets timesheets from getRawTimesheets
 * @returns timesheets with jobcode data added
 */
async function getFullTimesheets(timesheets) {
  // build and run promises all at once
  let promises = [];
  let headers = { Authorization: `Bearer ${accessToken}` };
  for (let timesheet of timesheets) promises.push(axios.get(BASE_URL + `/rest/time/${timesheet.key}`, { headers }));
  let resp = await Promise.all(promises);
  APICalls += promises.length;

  // pull out response data and return it all together
  let filledTimesheets = resp.map(res => res.data);
  return filledTimesheets;
} // getFullTimesheets

// |----------------------------------------------------|
// |                                                    |
// |                       HELPERS                      |
// |                                                    |
// |----------------------------------------------------|

/**
 * Gets the project name, without any decimals or numbers
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
  
  // return leftover parts and remove any extra whitespace/underscores
  return parts.join(' ').replaceAll(/[ +_*]/g, ' ');
} // getProjectName

/**
 * Combines any number of supplemental data objects
 * 
 * @param supps the supplemental data objects
 * @returns combined supplementalData object
 */
function combineSupplementalData(...supps) {
  // base default to make sure everything has at least some data
  let combined = { today: 0, future: { days: 0, duration: 0 }, nonBillables: [] };

  // loop through all supplemental data and combine it
  for (let supp of supps) {
    if (!supp) continue; // avoid error if it's undefined
    combined.today += supp.today ?? 0;
    combined.nonBillables = [...new Set([...combined.nonBillables, ...supp.nonBillables ?? []])];
    combined.future.days += supp.future?.days ?? 0;
    combined.future.duration += supp.future?.duration ?? 0;
  }

  return combined;
} // combineSupplementalData

/**
 * Helper to seralize an error
 * 
 * @param err the error to seralized
 * @reutrns object of serialized data for printing/returning
 */
function serializeError(err) {
  if (!err) return null;
  if (typeof err === 'string') return err;
  return {
    name: err.name ?? null,
    message: err.message ?? null,
    stack: err.stack ?? null 
  };
} // serializeError

/**
 * Helper to redact data from a string
 * 
 * @param str string to redact
 * @param start how many characters to keep on the start
 * @param end how many characters to keep on the end
 * @param fill (optional) characters to fill in place of redacted data
 */
function redact(str, start, end, fill='***') {
  if ([str, start, end, fill].some(v => v == null)) return null;
  return str.slice(0, start) + fill + str.slice(-end);
} // redact

/**
 * Builds an object to use in Promise rejections based on whether
 * or not Unanet is down, or if it was the code that errored.
 * 
 * @param err Error object
 * @returns object to use for Promise.reject()
 */
async function handleError(err){
  // make sure the error function doesn't error
  if (!err) err = new Error('Unknown error occurred.');

  // body to return either way
  let body = {
    stage: STAGE ?? null,
    url: BASE_URL ?? null,
    api_key: redact(accessToken, 8, 8),
    err: serializeError(err)
  };

  // return codes based on result of ping
  let ping = await axios.get(BASE_URL + '/rest/ping');
  if (ping?.status < 300 && ping?.status >= 200) {
    // Unanet is up
    console.log(err);
    return {
      status: 500,
      message: err.message,
      code: err.code,
      body
    };
  } else {
    // Unanet is down
    return {
      status: 503,
      message: "Unanet API failed to respond.",
      code: "ERR_UNANET_DOWN",
      body
    };
  }
} // handleError

// |----------------------------------------------------|
// |                                                    |
// |                        EXPORT                      |
// |                                                    |
// |----------------------------------------------------|

module.exports = {
  handler
};
