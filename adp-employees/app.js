const axios = require('axios');
const fs = require('fs');
const https = require('https');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { invokeLambda } = require('utils');

const ssmClient = new SSMClient({ region: 'us-east-1' });
const STAGE = process.env.STAGE;

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
} // getSecret

/**
 * Gets the access token by invoking the get access token lambda functions
 * @returns
 */
async function getADPAccessToken(account, connector) {
  let payload = { account, connector };
  let params = {
    FunctionName: `mysterio-adp-token-${STAGE}`,
    Payload: JSON.stringify(payload),
    Qualifier: '$LATEST'
  };
  let result = await invokeLambda(params);
  return result.body;
} // getADPAccessToken

/*
 * Begin execution of BambooHR Employees Lambda Function
 */
async function start(event) {
  try {
    console.info('Getting ADP access token and SSL certificate for CASE API Central account');
    // get ADP credentials from aws parameter store
    // note: access token lasts 60 minutes
    let account = event.account;
    let connector = event.connector;
    let query = event.query || '';
    let [accessToken, cert, key] = await Promise.all([
      getADPAccessToken(account, connector),
      getSecret(`/ADP/${account}/SSLCert`),
      getSecret(`/ADP/${account}/SSLKey`)
    ]);

    // ADP requires certificate signing with each API call
    fs.writeFileSync('/tmp/ssl_cert.pem', cert);
    fs.writeFileSync('/tmp/ssl_key.key', key);

    const httpsAgent = new https.Agent({
      cert: fs.readFileSync('/tmp/ssl_cert.pem'),
      key: fs.readFileSync('/tmp/ssl_key.key')
    });

    const options = {
      method: 'GET',
      url: `https://api.adp.com/hr/v2/workers?$top=5000&${query}`,
      headers: { Authorization: `Bearer ${accessToken}` },
      httpsAgent: httpsAgent
    };

    const result = await axios(options);
    // return the ADP employees
    console.info('Returning all ADP employee data');
    return { statusCode: 200, body: result.data.workers };
  } catch (err) {
    console.info('Error retrieving ADP employees: ' + err?.response?.data || err);
    throw new Error(err);
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
}

module.exports = { handler };
