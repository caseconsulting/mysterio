const axios = require('axios');
const _ = require('lodash');
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
 * Begin execution of Jobcodes Lambda Function
 */
async function start() {
  // get access token from parameter store
  let accessToken = await getSecret('/TSheets/accessToken');

  console.info('Obtaining job codes');

  let allJobCodes = {};
  let page = 1;
  let jobCodeData = {};
  do {
    // set options for TSheet API call
    let options = {
      method: 'GET',
      url: 'https://rest.tsheets.com/api/v1/jobcodes',
      params: {
        page: page
      },
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    };

    // request data from TSheet API
    let jobCodeRequest = await axios(options);
    jobCodeData = jobCodeRequest.data.results.jobcodes;

    allJobCodes = _.merge(allJobCodes, jobCodeData); // union job codes
    page++; // increment page
  } while (!_.isEmpty(jobCodeData)); // loop while more job codes exist

  console.info('Returning TSheets data');
  return {
    statusCode: 200,
    body: allJobCodes
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
