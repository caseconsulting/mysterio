const { handler: adpHandler } = require('./adp-timesheets');
const { handler: quickbooksHandler } = require('./quickbooks-timesheets');

/**
 * Begin execution of timesheet Lambda Function
 *
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 */
async function start(event) {
  try {
    let account = event.account;
    if (account === 'CYK') {
      return await adpHandler(event);
    } else {
      return await quickbooksHandler(event);
    }
  } catch (err) {
    console.log(err);
    return err;
  }
} // start

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
} // handler

module.exports = { handler };
