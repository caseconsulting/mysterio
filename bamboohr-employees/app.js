const axios = require('axios');
const { SSMClient, GetParamterCommand } = require('@aws-sdk/client-ssm');
const ssmClient = new SSMClient({region: 'us-east-1'});

/*
 * Access system manager parameter store and return secret value of the given name.
 */
async function getSecret(secretName) {
  const params = {
    Name: secretName,
    WithDecryption: true
  };
  const result = await ssmClient.send(new GetParamterCommand(params));
  return result.Parameter.Value;
}

/*
 * Begin execution of BambooHR Employees Lambda Function
 */
async function start(event) {
  // get access token from parameter store
  console.info('Getting API key for Case Consulting BambooHR account');
  let key = await getSecret('/BambooHR/APIKey');
  let fields = event.fields;

  const options = {
    method: 'POST',
    url: 'https://api.bamboohr.com/api/gateway.php/consultwithcase/v1/reports/custom',
    params: { format: 'JSON', onlyCurrent: 'true' },
    auth: {
      username: key,
      password: ''
    },
    data: { fields }
  };
  const employeeData = await axios(options);
  // return the BambooHR Employees
  console.info('Returning BambooHR employees');
  return { statusCode: 200, body: employeeData.data.employees };
}

/**
 *
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Context doc: https://docs.aws.amazon.com/lambda/latest/dg/nodejs-prog-model-context.html
 * @param {Object} context
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 *
 */
async function handler(event, context) {
  return start(event);
}

module.exports = { handler };
