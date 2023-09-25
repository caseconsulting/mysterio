const axios = require('axios');
const fs = require('fs');
const https = require('https');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

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
 * Invokes lambda function with given params
 *
 * @param params - params to invoke lambda function with
 * @return object if successful, error otherwise
 */
async function invokeLambda(params) {
  const client = new LambdaClient();
  const command = new InvokeCommand(params);
  const resp = await client.send(command);
  return JSON.parse(Buffer.from(resp.Payload));
} // invokeLambda

/**
 * Gets the access token by invoking the get access token lambda functions
 * @returns
 */
async function getADPAccessToken() {
  let params = {
    FunctionName: `mysterio-adp-token-${STAGE}`,
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
    let [accessToken, cert, key] = await Promise.all([
      getADPAccessToken(),
      getSecret('/ADP/SSLCert'),
      getSecret('/ADP/SSLKey')
    ]);

    let updatesToMake = event.updates;

    if (updatesToMake && updatesToMake.length > 0) {
      // ADP requires certificate signing with each API call
      fs.writeFileSync('/tmp/ssl_cert.pem', cert);
      fs.writeFileSync('/tmp/ssl_key.key', key);

      const httpsAgent = new https.Agent({
        cert: fs.readFileSync('/tmp/ssl_cert.pem'),
        key: fs.readFileSync('/tmp/ssl_key.key')
      });

      let promises = [];
      updatesToMake.forEach((update) => {
        const options = {
          method: 'POST',
          url: 'https://api.adp.com' + update.path,
          headers: { Authorization: `Bearer ${accessToken}` },
          data: update.data,
          httpsAgent: httpsAgent
        };
        promises.push(axios(options));
      });

      try {
        const [result] = await Promise.all(promises);
        // return the data from updating an employee
        console.info('Returning ADP employee update response');
        return { statusCode: 200, body: result.data };
      } catch (err) {
        console.info('Error retrieving ADP employees: ' + JSON.stringify(err.response.data));
        let errMessage = err.response.data.confirmMessage.resourceMessages[0].processMessages[0].userMessage.messageTxt;
        throw new Error(errMessage);
      }
    }
  } catch (err) {
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
