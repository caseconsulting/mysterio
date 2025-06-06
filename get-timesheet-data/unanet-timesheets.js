const axios = require('axios');
const dateUtils = require('dateUtils'); // from shared lambda layer
const { getSecret } = require('./secrets');
const { getTimesheetDateBatches } = require('./shared');

let accessToken;
const STAGE = process.env.STAGE;
const IS_PROD = STAGE === 'prod';
const URL_SUFFIX = IS_PROD ? '' : '-sand';
const BASE_URL = `https://consultwithcase${URL_SUFFIX}.unanet.biz/platform`;

/**
 * TODO
 * - [x] Use getSecret to store login info
 * - [ ] Store/retrieve PersonKey in/from Dynamo
 *       - maybe pass this in the event to save the call
 * - [ ] Maybe use getTimesheetDateBatches
 * - [ ] More optimizations?
 * - [ ] Add non-billables
 * - [ ] Get PTO balances
 */

/**
 * The handler for unanet timesheet data
 *
 * @param {Object} event - The lambda event
 * @returns Object - The timesheet data
 */
async function handler(event) {
  try {
    // pull out some vars
    let onlyPto = event.onlyPto;
    let startDate = event.periods[0].startDate;
    let endDate = event.periods[0].endDate;

    // log in to Unanet
    accessToken = await getAccessToken();
    let unanetPerson = await getUser(event.employeeNumber);

    // build the return body
    let { timesheets, supplementalData: timesheetsSupp } = await getTimesheets(startDate, endDate, unanetPerson.key);
    let { ptoBalances, supplementalData: ptoSupp } = await getPtoBalances(unanetPerson.key);
    let supplementalData = combineSupplementalData(timesheetsSupp, ptoSupp);

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
        login: { user: redact(LOGIN.username, 'email'), pass: redact(LOGIN.password, 'password') },
        api_key: redact(accessToken, 'apikey'),
        err: err ?? 'undefined'
      }
    });
  }
} // handler

/**
 * Helper to redact data
 * 
 * @param data (probably string) to redact
 * @param type what type of data it is: ['email', 'password', 'apikey']
 */
function redact(data, type) {
  if (!data) return data;

  let sliceHelper = (str, start, end, fill='***') => {
    return str.slice(0, start) + fill + str.slice(-end);
  }

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
}

/**
 * Returns an auth token for the API account.
 */
async function getAccessToken() {
  try {
    // get login info from parameter store
    const LOGIN = JSON.parse(await getSecret('/Unanet/login'));
    if (!LOGIN.username || !LOGIN.password) throw new Error('Could not get login info from parameter store');

    // set options for Unanet API call
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
}

/**
 * Gets a user from Unanet API based on Portal Employee Number
 * 
 * @param employeeNumber Portal Employee Number
 */
async function getUser(employeeNumber) {
  try {
    // set options for Unanet API call
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

    // check the data before returning it
    if (resp.data?.items?.length !== 1) throw new Error(`Could not distinguish employee ${employeeNumber} (${resp.data.length} options).`);
    return resp.data.items[0];
  } catch (err) {
    console.log(err);
    return err;
  }
}

/**
 * Combines any number of supplemental datas
 * 
 * @param supps the supplemental data objects
 */
function combineSupplementalData(...supps) {
  let combined = { today: 0, future: { days: 0, duration: 0 }, nonBillables: [] };
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
 * @returns 
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
  let timesheets = [];
  let timesheet;
  for (let month of filledTimesheets) {
    // fill in basic date stuff
    timesheet = {
      startDate: month.timePeriod.beginDate,
      endDate: month.timePeriod.endDate,
      title: dateUtils.format(month.timePeriod.beginDate, null, 'MMMM'),
      timesheets: {}
    }
    // loop through 'timeslips' and tally up for each job code
    for(let slip of month.timeslips) {
      let jobCode = getProjectName(slip.project.name);
      timesheet.timesheets[jobCode] ??= 0;
      timesheet.timesheets[jobCode] += hoursToSeconds(Number(slip.hoursWorked));
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

  return {
    timesheets,
    supplementalData
  };
} // getTimesheets

/**
 * Gets the project name, without any decimals or numbers.
 * Eg. converts "4828.12.96.PROJECT.OY1" to "PROJECT OY1"
 * 
 * @param projectName Name of the project, for converting
 */
function getProjectName(projectName) {
  // split up each part and remove any parts that are all digits
  let parts = projectName.split('.');
  for (let i = 0; i < parts.length; i++)
    if (/^\d+$/g.test(parts[i]))
      parts.splice(i--, 1); // post-decrement keeps i correct after splice
  return parts.join(' ').replaceAll(/ +/g, ' ');
} // getProjectName

/**
 * Gets the user's timesheets within a given time period.
 *
 * @param {String} startDate - The period start date
 * @param {String} endDate - The period end date
 * @param {Number} userId - The unanet personKey
 * @returns Array - All user timesheets within the given time period
 */
async function getRawTimesheets(startDate, endDate, userId) {
  try {
    let promises = [];
    let timesheets = [];
    let jobcodes = [];

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
    let resp = await axios(options);

    return resp.data.items
  } catch (err) {
    throw new Error(err);
  }
} // getRawTimesheets

/**
 * Fills the timesheets with jobcode data.
 * 
 * @param timesheets 
 */
async function fillTimesheetData(timesheets) {
  try {
    let promises = [];
    for (let timesheet of timesheets) {
      promises.push(
        axios.get(BASE_URL + `/rest/time/${timesheet.key}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        )
      );
    };
    let resp = await Promise.all(promises);
    let jobcodes = resp.map(res => res.data);
    return jobcodes;
  } catch (err) {
    throw new Error(err);
  }
} // fillTimesheetData

/**
 * Get's a user's PTO balances
 * 
 * @param 
 * 
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
