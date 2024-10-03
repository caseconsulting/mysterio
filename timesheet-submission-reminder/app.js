const _filter = require('lodash/filter');
const _find = require('lodash/find');
const _forEach = require('lodash/forEach');
const _map = require('lodash/map');

const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const { _isCaseReminderDay, _shouldSendCaseEmployeeReminder } = require('./case-helpers.js');
const { _isCykReminderDay, _shouldSendCykEmployeeReminder } = require('./cyk-helpers.js');
const { asyncForEach } = require('utils');

const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);
const snsClient = new SNSClient({});
const STAGE = process.env.STAGE;

async function start() {
  let employeesReminded = [];
  let isCykReminderDay = _isCykReminderDay();
  let isCaseReminderDay = _isCaseReminderDay();
  if (isCykReminderDay || isCaseReminderDay) {
    let portalEmployees = await _getPortalEmployees();

    await asyncForEach(portalEmployees, async (e) => {
      try {
        if (e.isCyk && isCykReminderDay) {
          let shouldSendReminder = await _shouldSendCykEmployeeReminder(e);
          if (shouldSendReminder) {
            //_sendReminder(e);
            employeesReminded.push(e);
          }
        }
        if (!e.isCyk && isCaseReminderDay) {
          let shouldSendReminder = await _shouldSendCaseEmployeeReminder(e);
          if (shouldSendReminder) {
            if (e.employeeNumber === 10066) {
              _sendReminder(e);
              employeesReminded.push(e);
            }
          }
        }
      } catch (err) {
        console.log(`An error occurred for employee number ${e.employeeNumber}: ${JSON.stringify(err)}`);
      }
    });

    return employeesReminded;
  }
}

async function _getPortalEmployees() {
  const basicCommand = new ScanCommand({
    ProjectionExpression: 'id, employeeNumber, publicPhoneNumbers, workStatus, hireDate',
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
    delete basicEmployee.publicPhoneNumbers;
    delete sensitiveEmployee.privatePhoneNumbers;
    let phoneNumber = _find(phoneNumbers, (p) => p.type === 'Cell')?.number;
    return {
      ...basicEmployee,
      ...sensitiveEmployee,
      phoneNumber,
      isCyk: cykTag.Items?.[0].employees.includes(basicEmployee.id)
    };
  });
  // get only active employees
  employees = _filter(employees, (e) => e.workStatus > 0);

  return employees;
}

async function _sendReminder(employee) {
  let phoneNumber = employee.phoneNumber?.replace(/-/g, '');
  if (!phoneNumber) return;
  let publishCommand = new PublishCommand({
    PhoneNumber: `+1${phoneNumber}`,
    Message: 'hi'
  });
  let resp = await snsClient.send(publishCommand);
  console.log(resp);
  return resp;
}

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

    return await start(event);
  } catch (err) {
    return err;
  }
}

module.exports = { handler };
