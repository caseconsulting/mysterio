const axios = require('axios');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
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
  // get access token from parameter store
  console.info('Getting API key for Case Consulting BambooHR account');
  let key = await getSecret('/BambooHR/APIKey');
  let id = event.id;
  let body = event.body;

  const options = {
    method: 'POST',
    url: `https://api.bamboohr.com/api/gateway.php/consultwithcase/v1/employees/${id}/`,
    auth: {
      username: key,
      password: ''
    },
    data: body
  };
  let result = await axios(options);
  // return the result of updating a BambooHR employee
  console.info('Returning BambooHR employee update result');
  return { result };
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