/**
 *
 * Unanet API reference: https://consultwithcase-sand.unanet.biz/platform/swagger/
 * 
 * Details about rate limiting:
 * Unanet will start rate limiting, but the process begins with contacting us. If they suspect
 * we're abusing their API then they will ask if we should get a higher plan or reduce our calls.
 * Exact numbers that would look suspicious are unknown.
 * 
 * Todo:
 * - [ ] Warehouse API data from previous months (only get the last 2 months via API)
 * - [ ] Make efficient calls for multiple users (will be doing entire company at some point)
 *
 */

// utils
const axios = require('axios');
const dateUtils = require('dateUtils'); // from shared lambda layer
const { getSecret } = require('./secrets');
const hoursToSeconds = (hours) => hours * 60 * 60;

// global and stage-based vars
let accessToken;
let eventOptions; // vars to allow event to communicate with all functions
let errors = []; // list of non-critical errors for debugging/tracking
const STAGE = process.env.STAGE;
const URL_SUFFIX = STAGE === 'prod' ? '' : '-sand';
const BASE_URL = `https://consultwithcase${URL_SUFFIX}.unanet.biz/platform`;
const BILLABLE_CODES = ['BILL_SVCS'];
const PLANABLE_KEYS = { PTO: 'PTO', Holiday: 'HOLIDAY' };

// DynamoDB
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);

/**
 * Handler for Unanet timesheet data
 *
 * @param event - The lambda event
 * @returns Object - The timesheet data
 */
async function handler(event) {
  try {
    // pull out vars from the event
    let { periods, employeeNumber, unanetPersonKey, options } = event;
    eventOptions = options ?? {};
    
    // log in to Unanet
    accessToken = await getAccessToken();

    // get Unanet keys, current and historical (one or both)
    let currentPersonKey, historicalPersonKey;
    keyErrors = {};
    try { currentPersonKey = await getUnanetPersonKey(employeeNumber) } catch (e) { keyErrors.c = e };
    try { historicalPersonKey = await getUnanetPersonKey(employeeNumber, true) } catch (e) { keyErrors.h = e};
    if (!currentPersonKey && !historicalPersonKey)
      throw new Error(`Neither current nor historical person keys found for ${employeeNumber}:\nCurrent: ${keyErrors.c}\nHistorical: ${keyErrors.h}`);

    // get bodies for current and historical (one or both)
    let current, historical;
    if (currentPersonKey) current = await getUnanetData(periods, currentPersonKey);
    if (historicalPersonKey) historical = await getUnanetData(periods, historicalPersonKey)

    // combine both bodies
    if (current && historical) body = combineBodies(current, historical);
    else body = current ?? historical;

    // add any soft errors
    if (errors?.length) body.errors = errors;

    // return everything together
    return { status: 200, body };
  } catch (err) {
    return await handleError(err);
  }
}

/**
 * Builds a return body from Unanet data given periods and the employee's
 * Unanet key.
 * 
 * @param periods time periods from event
 * @param unanetPersonKey userId from Unanet of person to get data for
 * @returns response body for given person over given period
 */
async function getUnanetData(periods, unanetPersonKey) {
  // get data from Unanet
  const { timeResults, leaveResults } = await getTimesheetsAndBalances(periods, unanetPersonKey);
  const { timesheets, supplementalData: timeSupp }  = timeResults;
  const { leaveBalances, supplementalData: leaveSupp } = leaveResults;

  // build the return body
  let supplementalData = combineSupplementalData(timeSupp, leaveSupp);
  processSupplementalData(supplementalData);
  body = { system: 'Unanet', timesheets, leaveBalances, supplementalData };

  return body;
}

/**
 * Quick helper to get timesheet and leave balances. Really just makes the handler
 * look prettier.
 * 
 * @param periods time periods from event
 * @param unanetPersonKey userId from Unanet of person to get data for
 * @returns Object with time and leave 
 */
async function getTimesheetsAndBalances(periods, unanetPersonKey) {
  let [timeResults, leaveResults] = await Promise.all([
    getPeriodTimesheets(periods, unanetPersonKey),
    getLeaveBalances(unanetPersonKey),
  ]);
  return { timeResults, leaveResults };
}

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
}

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
  let monthStart = dateUtils.format(dateUtils.startOf(startDate, 'month'), null, 'YYYY-MM-DD');
  let basicTimesheets = await getRawTimesheets(monthStart, endDate, userId); // returns monthly blocks
  let filledTimesheets = await getFullTimesheets(basicTimesheets); // returns monthly blocks with paycodes

  // helpful vars
  let today = dateUtils.getTodaysDate();
  let isToday = (date) => dateUtils.isSame(date, today, 'day');
  let isFuture = (date) => dateUtils.isAfter(date, today, 'day');

  // vars to fill in
  let supplementalData = {};
  let nonBillables = new Set();

  let timesheet = { startDate, endDate, title, timesheets: {} };

  // loop through each month returned from Unanet API
  for (let month of filledTimesheets) {
    // loop through 'timeslips' (there's one per labor category per day) and tally up for each job code
    for (let slip of month.timeslips) {
      // skip if there's no hours
      let hoursWorked = hoursToSeconds(Number(slip.hoursWorked));
      if (hoursWorked === 0) continue;

      // skip slips that are past the end date or before the start date
      let beforeStart = dateUtils.isBefore(slip.workDate, startDate, 'day');
      let afterEnd = dateUtils.isAfter(slip.workDate, endDate, 'day');
      if (beforeStart || afterEnd) continue;

      // add the hours worked for the project
      let jobCode = getProjectName(slip);
      timesheet.timesheets[jobCode] ??= 0;
      timesheet.timesheets[jobCode] += hoursWorked;

      // add bill code to non-billables if it is not marked as billable
      if (!BILLABLE_CODES.includes(slip.projectType.name)) {
        nonBillables.add(jobCode);
      }

      // if this slip is for today, add it to supplementalData
      if (isToday(slip.workDate)) {
        supplementalData.today ??= 0;
        supplementalData.today += hoursWorked;
      }

      // if this slip is for the future, add it to supplementalData
      if (isFuture(slip.workDate)) {
        supplementalData.future ??= { raw: {} }
        supplementalData.future.raw[slip.workDate] ??= 0;
        supplementalData.future.raw[slip.workDate] += hoursWorked;
      }
    }
  }

  // add seen non-billables to supplementalData
  supplementalData.nonBillables = Array.from(nonBillables);

  // give back finished result
  return { timesheet, supplementalData };
}

/**
 * Gets current leave balances for a user
 * 
 * @param userId Unanet ID of user
 * @returns leave balances and supplemental data
 */
async function getLeaveBalances(userId) {
  // base variables
  const today = dateUtils.getTodaysDate('YYYY-MM-DD');
  let yearStart = dateUtils.format(dateUtils.startOf(today, 'year'), null, 'YYYY-MM-DD');
  if (dateUtils.isSame(today, '2025-08-01', 'year')) yearStart = '2025-08-01'; // TODO: remove after 2025 and make yearStart a const
  const yearEnd = dateUtils.format(dateUtils.endOf(today, 'year'), null, 'YYYY-MM-DD');
  let round = (n) => (Math.round(n * 1000) / 1000);

  // vars to fill
  let leaveMappings = {};
  let leaveBalances = {};

  // Get basic leave data
  let leave = await getLeaveData(userId, yearStart, yearEnd);

  // find oddball dates and refetch those ones, build an object of them to access
  let oddballPromises = [];
  let oddballCodes = [];
  let oddballMap = {};
  const EOT = '2099-12-31';
  for (let item of leave.items) {
    if (item.beginDate !== yearStart || (item.endDate !== yearEnd && item.endDate !== EOT)) {
      oddballPromises.push(getLeaveData(userId, item.beginDate, item.endDate));
      oddballCodes.push(item.project.code);
    }
  }
  let oddballLeave = await Promise.all(oddballPromises);
  for (let i = 0; i < oddballCodes.length; i++){
    let code = oddballCodes[i];
    oddballMap[code] = oddballLeave[i].items.find((l) => l.project.code === code);
  }

  // set initial balances
  for (let item of leave.items) {
    let { code, name } = item.project;
    let balance = oddballMap[code]?.budget ?? item.budget;
    let actuals = oddballMap[code]?.actuals ?? item.actuals;
    leaveMappings[code] = name;
    leaveBalances[code] = hoursToSeconds(balance) - hoursToSeconds(actuals);
    leaveBalances[code] = round(leaveBalances[code]);
  }

  // return data in object
  return { 
    leaveBalances,
    supplementalData: {
      leaveMappings,
      planableKeys: PLANABLE_KEYS
    }
  };
}

// |----------------------------------------------------|
// |                                                    |
// |                  AWS CONNECTIONS                   |
// |                                                    |
// |----------------------------------------------------|

/**
 * Gets a specific employee attribute from the database
 * Usage eg: const { id, email } = await getEmployeeAttrFromDb(10001, 'id', 'email');
 *
 * @param employeeNumber employee to retrieve data for
 * @param attrs attributes to fetch
 * @return An object with keys matching attrs
 */
async function getEmployeeAttrFromDb(employeeNumber, ...attrs) {
  // build command
  const TableName = `${STAGE}-employees`;
  const scanCommand = new ScanCommand({
    ProjectionExpression: attrs.join(','),
    FilterExpression: 'employeeNumber = :n OR employeeNumber = :s',
    ExpressionAttributeValues: { ':n': Number(employeeNumber), ':s': String(employeeNumber) },
    TableName
  });

  // send command
  resp = await docClient.send(scanCommand);

  // throw error or return object
  if (resp.Count !== 1)
    throw new Error(`Could not distinguish Portal employee ${employeeNumber} (${resp.Count} options).`);
  return resp.Items[0];
}

/**
 * Updates a user's personKey in DynamoDB for future use.
 * 
 * On error, this function will not stop the code from returning.
 *
 * @param employeeNumber user's portal employee number
 * @param personKey from Unanet to add to user's profile
 */
async function updateUserPersonKey(employeeNumber, personKey) {
  try {
    // common table for both commands
    const TableName = `${STAGE}-employees`;

    // find the user's ID
    const { id } = await getEmployeeAttrFromDb(employeeNumber, 'id');

    // use their ID to update the personKey
    const updateCommand = new UpdateCommand({
      TableName,
      Key: { id },
      UpdateExpression: `set unanetPersonKey = :k`,
      ExpressionAttributeValues: { ':k': `${personKey}` }
    });
    await docClient.send(updateCommand);
  } catch (err) {
    errors.push(serializeError(err));
  }
}

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
  try {
    let resp = await axios(options);
    return resp.data.token;
  } catch (err) {
    throw new Error(`Login to Unanet failed: ${err.message}`);
  }
}

/**
 * Gets a user's key from Unanet API based on Portal employeeNumber
 *
 * @param employeeNumber Portal Employee Number
 * @param historical (optional) Whether or not to use idCode2, typically used to get historical data
 * @returns Unanet personKey
 */
async function getUnanetPersonKey(employeeNumber, historical = false) {
  // build options to find employee based on employeeNumber
  let idCode = historical ? 'idCode2' : 'idCode1';
  let options = {
    method: 'POST',
    url: BASE_URL + '/rest/people/search',
    data: {
      [idCode]: employeeNumber
    },
    headers: { Authorization: `Bearer ${accessToken}` }
  };

  // request data from Unanet API
  let resp = await axios(options);

  // pull out the employee's key
  if (resp.data?.items?.length !== 1)
    throw new Error(`Could not distinguish Unanet employee ${employeeNumber} (${resp.data.length} options).`);
  let personKey = resp.data.items[0].key;

  // ~~update user's DynamoDB object and return for usage now~~
  // We now have two person keys per employee, since historical data is separate.
  // This could be stored.
  // await updateUserPersonKey(employeeNumber, personKey);

  return personKey;
}

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
      beginDateEnd: endDate,
      // active: true
    },
    headers: { Authorization: `Bearer ${accessToken}` }
  };
  
  
  // get response
  let resp = await axios(options);
  let filtered = filterTimesheets(resp.data.items);
  return filtered;
}

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

  // pull out response data and return it all together
  let filledTimesheets = resp.map((res) => res.data);
  return filledTimesheets;
}

/**
 * Gets leave balance report from Unanet
 *
 * @param userId Unanet ID of user
 * @param startDate start date of period to look for
 * @param endDate end date of period to look for
 * @returns leave balances object and supplemental data
 */
async function getLeaveData(userId, startDate, endDate) {
  const options = {
    method: 'POST',
    url: `${BASE_URL}/rest/people/${userId}/leave`,
    data: {
      dateRange: { rangeStart: startDate, rangeEnd: endDate }
    },
    headers: { 'Authorization': `Bearer ${accessToken}` }
  };
  const resp = await axios(options);
  return resp.data;
}

// |----------------------------------------------------|
// |                                                    |
// |                       HELPERS                      |
// |                                                    |
// |----------------------------------------------------|

/**
 * Gets the project name, without any decimals or numbers
 * Eg. converts "9876.54.32.PROJECT.OY1" to "PROJECT OY1"
 *
 * @param slip The timeslip object
 * @returns More human-friendly project name for Portal
 */
function getProjectName(slip) {
  let projectName = slip.project?.name;
  let taskName = slip.task?.name;
  let spacesRegex = /[ _]+/g; // regex to match spaces and underscores
  
  // get project name: filter out all numeric parts and keep the rest
  let projectSplit = projectName.split('.');
  let project = projectSplit.filter((value) => /\D/.test(value)); // '\D' is any non-number character
  project = project.join(' ');
  project = project?.replace(spacesRegex, ' '); // trim spaces/underscores

  // task name often has duplicate information separated by a dash, and
  // duplicate option year text; remove both
  let task = taskName;
  if (task?.includes(' - ')) task = task.split(' - ')[1];
  task = task?.replace(/OY[0-9]/g, '');
  task = task?.replace(spacesRegex, ' '); // trim spaces/underscores

  // return with task name if it exists
  if (!task) return project;
  else return `${project} - ${task}`;
}

/**
 * Combines any number of supplemental data objects
 *
 * @param supps the supplemental data objects
 * @returns combined supplementalData object
 */
function combineSupplementalData(...supps) {
  // base default to make sure everything has at least some data
  let combined = { today: 0, future: { days: new Set(), duration: 0 }, nonBillables: [], leaveMappings: {}, planableKeys: {} };

  // loop through all supplemental data and combine it
  for (let supp of supps) {
    if (!supp) continue; // avoid error if it's undefined
    combined.today += supp.today ?? 0;
    combined.nonBillables = [...new Set([...combined.nonBillables, ...(supp.nonBillables ?? [])])];
    combined.leaveMappings = { ...combined.leaveMappings, ...(supp.leaveMappings ?? {}) };
    combined.planableKeys = { ...combined.planableKeys, ...(supp.planableKeys ?? {}) };
    combined.future.raw = { ...combined.future.raw, ...(supp.future?.raw ?? {}) }
  }

  return combined;
}

/**
 * Last-second conversions of supplemental data before returning it. Do not use this anywhere
 * other than a last-second conversion of data before returning the handler.
 * 
 * Currently does the following:
 *  - Converts future days raw to days and duration
 * 
 * @param data the supplemental data object to update
 */
function processSupplementalData(data) {
  if (data.future?.raw) {
    let durations = Object.values(data.future.raw);
    data.future = {
      days: durations.length,
      duration: durations.reduce((acc, curr) => acc + curr, 0)
    }
  }
}

/**
 * Combines return bodies into one unified body.
 * Note that the first body's leave balances will be used.
 * 
 * @param bodies Spread of all bodies to combine
 * @returns all bodies combined into one
 */
function combineBodies(...bodies) {
  // base body
  let [combined, ...rest] = bodies;

  for (let body of rest) {
    // combine timesheets
    // since `periods` is the same for all fetches, array will always be the same order. Only
    // the actual values will be different
    for (let i in body.timesheets) {
      // get the keys for both
      let cSheet = combined.timesheets[i];
      let bSheet = body.timesheets[i];
      let keys = [...Object.keys(cSheet.timesheets), ...Object.keys(bSheet.timesheets)];
      // add together
      for (let key of keys) {
        combined.timesheets[i].timesheets[key] = (cSheet.timesheets[key] ?? 0) + (bSheet.timesheets[key] ?? 0);
      }
    }

    // combine supplemental data
    combined.supplementalData = combineSupplementalData(combined.supplementalData, body.supplementalData);
  }

  return combined;
}

/**
 * Filters timesheets based on eventOptions
 *
 * @param timesheets to filter
 * @returns filtered timesheets object
 */
function filterTimesheets(timesheets) {
  let filtered = timesheets;

  // filter for status
  // options: "NEW", "INUSE", "DISAPPROVED", "LOCKED", "COMPLETED", "EXTRACTED", "APPROVING", "SUBMITTED"
  if (eventOptions.status) {
    let status = eventOptions.status;
    if (!Array.isArray(status)) status = [status];
    filtered = filtered.filter((timesheet) => status.includes(timesheet.status));
  }

  // return filtered timesheets
  return filtered;
}

/**
 * Helper to seralize an error
 *
 * @param err the error to seralized
 * @returns object of serialized data for printing/returning
 */
function serializeError(err) {
  if (!err) return null;
  if (typeof err === 'string') return err;
  return {
    name: err.name ?? null,
    message: err.message ?? null,
    stack: err.stack ?? null
  };
}

/**
 * Helper to redact data from a string
 *
 * @param str string to redact
 * @param start how many characters to keep on the start
 * @param end how many characters to keep on the end
 * @param fill (optional) characters to fill in place of redacted data
 * @returns The redacted string
 */
function redact(str, start, end, fill = '***') {
  if ([str, start, end, fill].some((v) => v == null)) return null;
  return str.slice(0, start) + fill + str.slice(-end);
}

/**
 * Builds an object to use in Promise rejections based on whether
 * or not Unanet is down, or if it was the code that errored.
 *
 * @param err Error object
 * @returns object to use for Promise.reject()
 */
async function handleError(err) {
  // make sure the error function doesn't error
  err ??= new Error('Unknown error occurred.');

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
      message: 'Unanet API failed to respond.',
      code: 'ERR_UNANET_DOWN',
      body
    };
  }
}

// |----------------------------------------------------|
// |                                                    |
// |                        EXPORT                      |
// |                                                    |
// |----------------------------------------------------|

module.exports = {
  handler
};
