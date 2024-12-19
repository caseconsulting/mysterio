/////////////////////////////////////////////////////////////
// READ NOTE ABOVE TEST_EMPLOYEE_NUMBERS BEFORE DEVELOPING //
/////////////////////////////////////////////////////////////
const _filter = require('lodash/filter');
const _find = require('lodash/find');
const _forEach = require('lodash/forEach');
const _map = require('lodash/map');

const { SNSClient, ListPhoneNumbersOptedOutCommand, PublishCommand } = require('@aws-sdk/client-sns');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const { _isCaseReminderDay, _shouldSendCaseEmployeeReminder } = require('./case-helpers.js');
const { _isCykReminderDay, _shouldSendCykEmployeeReminder } = require('./cyk-helpers.js');
const { asyncForEach } = require('utils');

const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);
const snsClient = new SNSClient({});
const STAGE = process.env.STAGE;

// only use your own employee number or people you know (don't send messages to random people/employees)
// make sure the phone number attached to the employee number is your own number
const TEST_EMPLOYEE_NUMBERS = [10066];

/**
 * Start of the timesheet submission reminder process.
 *
 * @param {Number} day - 1 or 2, 1 being first reminder day 2 being second reminder day
 * @returns Array - The array from employee numbers to send reminders to
 */
async function start(day) {
  let employeesReminded = [];
  let portalEmployees = await _getPortalEmployees();
  await _manageEmployeesOptOutList(portalEmployees);
  let isCykReminderDay = _isCykReminderDay(day);
  let isCaseReminderDay = _isCaseReminderDay(day);
  if (isCykReminderDay || isCaseReminderDay) {
    await asyncForEach(portalEmployees, async (e) => {
      try {
        if (e.isCyk && isCykReminderDay) {
          let shouldSendReminder = await _shouldSendCykEmployeeReminder(e);
          if (shouldSendReminder) {
            _sendReminder(e);
            employeesReminded.push(e.employeeNumber);
          }
        }
        if (!e.isCyk && isCaseReminderDay) {
          let shouldSendReminder = await _shouldSendCaseEmployeeReminder(e);
          if (shouldSendReminder) {
            _sendReminder(e);
            employeesReminded.push(e.employeeNumber);
          }
        }
      } catch (err) {
        console.log(`An error occurred for employee number ${e.employeeNumber}: ${JSON.stringify(err)}`);
      }
    });

    return employeesReminded;
  }
} // start

/**
 * Gets the portal employees objects.
 *
 * @returns Array - The array of portal employees
 */
async function _getPortalEmployees() {
  const basicCommand = new ScanCommand({
    ProjectionExpression: 'id, employeeNumber, publicPhoneNumbers, workStatus, hireDate, cykAoid',
    TableName: `${STAGE}-employees`
  });
  const sensitiveCommand = new ScanCommand({
    ProjectionExpression: 'id, privatePhoneNumbers',
    TableName: `${STAGE}-employees-sensitive`
  });
  const tagCommand = new QueryCommand({
    IndexName: 'tagName-index',
    KeyConditionExpression: `tagName = :queryKey`,
    ExpressionAttributeValues: {
      ':queryKey': 'CYK'
    },
    TableName: `${STAGE}-tags`
  });

  const [basicEmployees, sensitiveEmployees, cykTag] = await Promise.all([
    docClient.send(basicCommand),
    docClient.send(sensitiveCommand),
    docClient.send(tagCommand)
  ]);

  // merge and organize data
  let employees = _map(basicEmployees.Items, (basicEmployee) => {
    let sensitiveEmployee = _find(sensitiveEmployees.Items, (e) => e.id === basicEmployee.id);
    let phoneNumbers = [...basicEmployee.publicPhoneNumbers, ...sensitiveEmployee.privatePhoneNumbers];
    let phone = _find(phoneNumbers, (p) => p.type === 'Cell');
    let phoneNumber = _getSMSPhoneNumber(phone);
    let isOptedOut = phone?.smsOptedOut;
    return {
      ...basicEmployee,
      ...sensitiveEmployee,
      phoneNumber,
      isOptedOut,
      isCyk: cykTag.Items?.[0].employees.includes(basicEmployee.id)
    };
  });
  // get only active employees
  employees = _filter(employees, (e) => e.workStatus > 0);

  return employees;
} // _getPortalEmployees

/**
 * Formats a phone number from how it is stored in the portal, to SMS format.
 *
 * @param {String} phone - The Portal formatted phone number
 * @returns - The SMS formatted phone number
 */
function _getSMSPhoneNumber(phone) {
  return phone?.number ? `+1${phone.number?.replace(/-/g, '')}` : null;
} // _getSMSPhoneNumber

/**
 * Gets the list of opted out phone numbers, and updates an employees phone number object to be opted-out
 * if they are listed as opted-in. This essentially serves as a data sync.
 *
 * @param {Array} portalEmployees - The array of portal employee objects
 */
async function _manageEmployeesOptOutList(portalEmployees) {
  const command = new ListPhoneNumbersOptedOutCommand({});
  const response = await snsClient.send(command);
  let promises = [];
  _forEach(portalEmployees, async (e) => {
    let pubNum = _find(e.publicPhoneNumbers, (phone) => response?.phoneNumbers?.includes(_getSMSPhoneNumber(phone)));
    let privNum = _find(e.privatePhoneNumbers, (phone) => response?.phoneNumbers?.includes(_getSMSPhoneNumber(phone)));
    if (pubNum && !pubNum.smsOptedOut) {
      pubNum.smsOptedOut = true;
      e.isOptedOut = true;
      promises.push(_updateAttributeInDB(e, 'publicPhoneNumbers', `${STAGE}-employees`));
    } else if (privNum && !privNum.smsOptedOut) {
      privNum.smsOptedOut = true;
      e.isOptedOut = true;
      promises.push(_updateAttributeInDB(e, 'privatePhoneNumbers', `${STAGE}-employees-sensitive`));
    }
  });
  if (promises.length > 0) await Promise.all(promises);
} // _manageEmployeesOptOutList

/**
 * Sends an SMS reminder to an employee.
 *
 * @param {Object} employee - The employee to send a reminder to
 * @returns Object - The SNS client response
 */
async function _sendReminder(employee) {
  try {
    if (STAGE === 'prod' || (STAGE !== 'prod' && TEST_EMPLOYEE_NUMBERS.includes(employee.employeeNumber))) {
      if (!employee.phoneNumber)
        throw { message: `Phone number does not exist for employee number ${employee.employeeNumber}` };
      if (employee.isOptedOut) {
        console.log(`Employee number ${employee.employeeNumber} has opted-out of receiving text messages`);
        return;
      }
      let publishCommand = new PublishCommand({
        PhoneNumber: employee.phoneNumber,
        Message:
          'CASE Alerts: This is a reminder that you have not yet met the timesheet hour requirements for this pay period. Please be sure to submit your hours as soon as possible to keep payroll running smoothly.'
      });
      console.log(`Attempting to send message to employee number ${employee.employeeNumber}`);
      let resp = await snsClient.send(publishCommand);
      console.log(`Successfully sent text message to employee number ${employee.employeeNumber}`);
      return resp;
    }
  } catch (err) {
    console.log(`Failed to send text message to employee number ${employee.employeeNumber}`);
    return err;
  }
} // _sendReminder

/**
 * Updates an entry in the dynamodb table.
 *
 * @param newDyanmoObj - object to update dynamodb entry to
 * @return Object - object updated in dynamodb
 */
async function _updateAttributeInDB(dynamoObj, attribute, tableName) {
  let params = { TableName: tableName, Key: { id: dynamoObj.id } };
  if (dynamoObj[attribute]) {
    params['UpdateExpression'] = `set ${attribute} = :a`;
    params['ExpressionAttributeValues'] = { ':a': dynamoObj[attribute] };
  } else {
    params['UpdateExpression'] = `remove ${attribute}`;
  }

  const updateCommand = new UpdateCommand(params);
  try {
    let retVal = await docClient.send(updateCommand);
    console.log(`Successfully updated entry attribute ${attribute} in ${tableName} with ID ${dynamoObj.id}`);
    return retVal;
  } catch (err) {
    // log error
    console.log(`Failed to update entry attribute ${attribute} in ${tableName} with ID ${dynamoObj.id}`);

    // throw error
    return err;
  }
} // updateEntryInDB

/**
 *
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 *
 */
async function handler(event) {
  try {
    console.log(`Handler Event: ${JSON.stringify(event)}`);
    // only send reminders on last work day at 8pm
    // only send reminders on day after last work day at 7am and 4pm
    let resourceArr = event.resources?.[0]?.split('-');
    let reminderDay = Number(resourceArr?.[resourceArr.length - 1]);
    return await start(reminderDay);
  } catch (err) {
    return err;
  }
}

module.exports = { handler };