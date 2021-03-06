const axios = require('axios');
// const _ = require('lodash');
const ssm = require('./aws-client');

/*
 * Access system manager parameter store and return secret value of the given name.
 */
async function getSecret(secretName) {
  const params = {
    Name: secretName,
    WithDecryption: true
  };
  const result = await ssm.getParameter(params).promise();
  return result.Parameter.Value;
}

/*
 * Begin execution of Basecamp Lambda Function
 */
async function start() {
  // get basecamp token params from aws parameter store
  let clientID = await getSecret('/Basecamp/ClientID');
  let clientSecret = await getSecret('/Basecamp/ClientSecret');
  let redirectURI = await getSecret('/Basecamp/RedirectURI');
  let refreshToken = await getSecret('/Basecamp/RefreshToken');
  let type = 'refresh';

  let refreshOptions = {
    method: 'POST',
    url: 'https://launchpad.37signals.com/authorization/token',
    params: {
      client_id: clientID,
      client_secret: clientSecret,
      redirect_uri: redirectURI,
      refresh_token: refreshToken,
      type: type
    }
  };

  // request new access token
  let accessTokenRequest = await axios(refreshOptions);
  let accessTokenData = accessTokenRequest.data;

  // return access token
  console.info('Returning Case info basecamp access token');
  return {
    statusCode: 200,
    body: accessTokenData
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
async function handler() {
  return start();
}

module.exports = { handler };
