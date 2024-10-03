const axios = require('axios');
const _filter = require('lodash/filter');
const _sumBy = require('lodash/sumBy');
const { getSecret } = require('./secrets.js');
const {
  getTodaysDate,
  startOf,
  endOf,
  format,
  getIsoWeekday,
  add,
  subtract,
  isSame,
  isAfter,
  DEFAULT_ISOFORMAT
} = require('dateUtils');
let accessToken;

function _isCaseReminderDay() {
  let today = getTodaysDate(DEFAULT_ISOFORMAT);
  let lastDay = endOf(today, 'month');
  let isoWeekDay = getIsoWeekday(lastDay);
  let daysToSubtract = Math.max(isoWeekDay - 5, 0);
  let lastWorkDay = subtract(lastDay, daysToSubtract, 'day', DEFAULT_ISOFORMAT);
  return true;
  return isSame(today, lastWorkDay, 'day');
}

async function _shouldSendCaseEmployeeReminder(employee) {
  await _getAccessToken();
  let qbUser = await _getUser(employee.employeeNumber);
  let userId = Object.keys(qbUser)?.[0];
  let hoursSubmitted = await _getHoursSubmitted(userId);
  let hoursRequired = _getHoursRequired(employee);
  return hoursRequired > hoursSubmitted;
}

async function _getAccessToken() {
  if (!accessToken) accessToken = await getSecret('/TSheets/accessToken');
  return accessToken;
}

async function _getUser(employeeNumber) {
  try {
    // set options for TSheet API call
    let options = {
      method: 'GET',
      url: 'https://rest.tsheets.com/api/v1/users',
      params: {
        employee_numbers: employeeNumber
      },
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    };

    // request data from TSheet API
    let userRequest = await axios(options);
    let user = userRequest.data.results.users;
    if (user?.length === 0) throw { status: 400, message: 'Invalid employee number: ' + employeeNumber };
    // attach supplemental data to the user object (this contains PTO data)
    return Promise.resolve(user);
  } catch (err) {
    return Promise.reject(err);
  }
}

function _getHoursRequired(employee) {
  let workDays = 0;
  let today = getTodaysDate();
  let startDate = startOf(today, 'month');
  let endDate = endOf(today, 'month');
  let hireDate = employee.hireDate;
  if (isAfter(hireDate, startDate, 'day')) {
    startDate = hireDate;
  }
  while (!isAfter(startDate, endDate, 'day')) {
    let isoWeekDay = getIsoWeekday(startDate);
    if (isoWeekDay > 0 && isoWeekDay < 6) {
      workDays += 1;
    }
    // increment to the next day
    startDate = add(startDate, 1, 'day', DEFAULT_ISOFORMAT);
  }
  return workDays * (8 * (employee.workStatus / 100));
}

/**
 * Gets the user's timesheets within a given time period.
 *
 * @param {String} startDate - The period start date
 * @param {String} endDate - The period end date
 * @param {Number} userId - The QuickBooks user ID
 * @returns Array - All user timesheets within the given time period
 */
async function _getHoursSubmitted(userId) {
  try {
    let today = getTodaysDate();
    let startDate = startOf(today, 'month');
    let endDate = endOf(today, 'month');
    // set options for TSheet API call
    let options = {
      method: 'GET',
      url: 'https://rest.tsheets.com/api/v1/timesheets',
      params: {
        start_date: format(startDate, null, DEFAULT_ISOFORMAT),
        end_date: format(endDate, null, DEFAULT_ISOFORMAT),
        user_ids: userId
      },
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    };
    // request data from TSheet API
    let timesheetResponse = await axios(options);
    let timesheets = timesheetResponse.data.results.timesheets;
    timesheets = _filter(timesheets, (t) => t.state === 'APPROVED' || t.state === 'SUBMITTED');
    let hoursSubmitted = _sumBy(timesheets, (t) => t.duration) / 60 / 60; // convert from seconds to hours
    return Promise.resolve(hoursSubmitted);
  } catch (err) {
    return Promise.reject(err);
  }
} // getTimesheets

module.exports = {
  _isCaseReminderDay,
  _shouldSendCaseEmployeeReminder
};
