const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const ssmClient = new SSMClient({region: 'us-east-1'});

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
 * Begin execution of TwitterToken Lambda Function
 */
async function start(event) {
  // get access token from parameter store
  console.info('Getting access token for Case Consulting Twitter account')
  let accessToken = await getSecret('/Twitter/accessToken');

  // return the access token
  console.info('Returning access token for Case Consulting Twitter account')
  return {
    statusCode: 200,
    body: accessToken
  };
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
