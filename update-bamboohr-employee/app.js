const axios = require('axios');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { asyncForEach } = require('utils');
const ssmClient = new SSMClient({ region: 'us-east-1' });

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
 * Begin execution of Update BambooHR Employee Lambda Function
 */
async function start(event) {
  try {
    // get access token from parameter store
    console.info('Getting API key for Case Consulting BambooHR account');
    let key = await getSecret('/BambooHR/APIKey');
    let id = event.id;
    let body = event.body;
    let tabularData = event.tabularData;

    const options = {
      method: 'POST',
      url: `https://api.bamboohr.com/api/gateway.php/consultwithcase/v1/employees/${id}/`,
      auth: {
        username: key,
        password: ''
      },
      data: body
    };
    let promises = [];
    promises.push(axios(options));
    // add a tabular data record from the object passed from the portal data sync function
    await asyncForEach(tabularData, async (tabularRecord) => {
      let table = tabularRecord.table;
      let body = tabularRecord.body;
      const options = {
        method: 'POST',
        url: `https://api.bamboohr.com/api/gateway.php/consultwithcase/v1/employees/${id}/tables/${table}`,
        auth: {
          username: key,
          password: ''
        },
        data: body
      };
      promises.push(axios(options));
    });
    let [result] = await Promise.all(promises);
    result = result.data;
    // return the result of updating a BambooHR employee
    console.info('Returning BambooHR employee update result');
    return { statusCode: 200, body: result };
  } catch (err) {
    if (err.response && err.response.headers && err.response.headers['x-bamboohr-error-message']) {
      throw new Error(err.response.headers['x-bamboohr-error-message']);
    } else {
      throw new Error(err);
    }
  }
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
