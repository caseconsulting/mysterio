const axios = require('axios');
const _filter = require('lodash/filter');
const _sumBy = require('lodash/sumBy');
const { getHoursRequired, getSecret } = require('./shared.js');
const {
  getTodaysDate,
  startOf,
  endOf,
  format,
  getIsoWeekday,
  add,
  subtract,
  isSame,
  DEFAULT_ISOFORMAT
} = require('dateUtils');

let accessToken;

/**
 * Checks to see if today is the last work day of the month or 1 day after the last work day.
 *
 * @param {Number} day - 1 or 2, 1 being first reminder day 2 being second reminder day
 * @returns Boolean - True if employees should be notified today
 */
function _isCaseReminderDay(day) {
  let todaySubtracted = false;
  let today = getTodaysDate(DEFAULT_ISOFORMAT);
  if (isSame(today, startOf(today, 'month'), 'day')) {
    today = subtract(today, 1, 'day', DEFAULT_ISOFORMAT);
    todaySubtracted = true;
  }
  let lastDay = endOf(today, 'month');
  let isoWeekDay = getIsoWeekday(lastDay);
  let daysToSubtract = Math.max(isoWeekDay - 5, 0);
  let lastWorkDay = subtract(lastDay, daysToSubtract, 'day', DEFAULT_ISOFORMAT);
  let lastWorkDayPlusOne = add(lastWorkDay, 1, 'day', DEFAULT_ISOFORMAT);
  let isReminderDay =
    (isSame(today, lastWorkDay, 'day') && !todaySubtracted && day === 1) ||
    (isSame(today, lastWorkDayPlusOne, 'day') && !todaySubtracted && day === 2) ||
    (isSame(today, lastWorkDay, 'day') && todaySubtracted && day === 2);
  if (isReminderDay) console.log('Today is CASE reminder day');
  return isReminderDay;
} // _isCaseReminderDay

/**
 * Checks if an employee has not submitted the correct amount of timesheet hours for the
 * pay period.
 *
 * @param {Object} employee - The employee to check
 * @returns Boolean - True if the employee has not met their pay period hours
 */
async function _shouldSendCaseEmployeeReminder(employee) {
  await _getAccessToken();
  let qbUser = await _getUser(employee.employeeNumber);
  let userId = Object.keys(qbUser)?.[0];
  let today = getTodaysDate();
  if (isSame(today, startOf(today, 'month'), 'day')) {
    today = subtract(today, 1, 'day', DEFAULT_ISOFORMAT);
  }
  let startDate = startOf(today, 'month');
  let endDate = endOf(today, 'month');
  let hoursSubmitted = await _getHoursSubmitted(userId, startDate, endDate);
  let hoursRequired = getHoursRequired(employee, startDate, endDate);
  return hoursRequired > hoursSubmitted;
} // _shouldSendCaseEmployeeReminder

/**
 * Gets the QuickBooks access token.
 *
 * @returns String - The QuickBooks access token
 */
async function _getAccessToken() {
  if (!accessToken) accessToken = await getSecret('/TSheets/accessToken');
  return accessToken;
} // _getAccessToken

/**
 * Gets the QuickBooks user object from an employee number.
 *
 * @param {Number} employeeNumber - The employee number
 * @returns Object - The QuickBooks user
 */
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
} // _getUser

/**
 * Gets the user's timesheets within a given time period.
 *
 * @param {String} startDate - The period start date
 * @param {String} endDate - The period end date
 * @param {Number} userId - The QuickBooks user ID
 * @returns Array - All user timesheets within the given time period
 */
async function _getHoursSubmitted(userId, startDate, endDate) {
  try {
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
