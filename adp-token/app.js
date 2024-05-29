const axios = require('axios');
const fs = require('fs');
const https = require('https');
const qs = require('qs');
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
} // getSecret

/*
 * Begin execution of BambooHR Employees Lambda Function
 */
async function start(event) {
  try {
    console.info('Getting ADP credentials from API Central account');
    let account = event.account;
    let connector = event.connector;
    // get ADP credentials from aws parameter store
    let [clientID, clientSecret, cert, key] = await Promise.all([
      getSecret(`/ADP/${account}/${connector}/ClientID`),
      getSecret(`/ADP/${account}/${connector}/ClientSecret`),
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
    let data = qs.stringify({
      grant_type: 'client_credentials',
      client_id: clientID,
      client_secret: clientSecret
    });
    const options = {
      method: 'POST',
      url: 'https://accounts.adp.com/auth/oauth/v2/token',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: data,
      httpsAgent: httpsAgent
    };
    const result = await axios(options);
    // return the ADP access token data
    console.info('Returning ADP access token');
    return { statusCode: 200, body: result.data.access_token }; // note: access token lasts 60 minutes
  } catch (err) {
    console.info('Error retrieving ADP access token: ' + err);
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
