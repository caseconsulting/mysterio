const axios = require('axios');
const crypto = require('crypto');
const dateUtils = require('dateUtils'); // from shared lambda layer
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const ssmClient = new SSMClient({ region: 'us-east-1' });

// Process environment variables
const STAGE = process.env.STAGE;

// Static headers used in the request
const ACCEPT_HEADER = 'accept';
const CONTENT_HEADER = 'content-type';
const HOST_HEADER = 'host';
const XAMZDATE_HEADER = 'x-amz-date';
const XAMZTARGET_HEADER = 'x-amz-target';
const AUTHORIZATION_HEADER = 'Authorization';

// Static request type
const REQUEST_TYPE = 'POST';

// Static format parameters
const DATE_FORMAT = 'YYYYMMDDTHHmmss[Z]';

// Signature calculation related parameters
const KEY_QUALIFIER = 'AWS4';
const AWS_SHA256_ALGORITHM = `${KEY_QUALIFIER}-HMAC-SHA256`;
const TERMINATION_STRING = 'aws4_request';

// Service and target (API) parameters
const REGION_NAME = 'us-east-1'; // lowercase!  Ref http://docs.aws.amazon.com/general/latest/gr/rande.html
const SERVICE_NAME = 'AGCODService';

// Payload parameters
const AMOUNT = 50;
const CURRENCY_CODE = 'USD';

// Parameters that specify what format the payload should be in and what fields will
// be in the payload, based on the selected operation.
const METHOD = 'POST';
const CONTENT_TYPE = 'application/json';
const SERVICE_OPERATION = 'CreateGiftCard';

// Parameters used in the message header
// sandbox URL: agcod-v2-gamma.amazon.com  ||   prod URL: agcod-v2.amazon.com
const HOST = `agcod-v2${STAGE === 'prod' ? '' : '-gamma'}.amazon.com`;
const PROTOCOL = 'https';
const REQUEST_URI = '/' + SERVICE_OPERATION;
const SERVICE_TARGET = 'com.amazonaws.agcod.AGCODService' + '.' + SERVICE_OPERATION;
const HOST_NAME = PROTOCOL + '://' + HOST + REQUEST_URI;

/**
 * Builds the string representation of the HTTP request.
 *
 * @param {String} payload - The payload stringified
 * @param {String} dateTimeString - The date in simple ISO8601 format
 * @returns String - The canonical request
 */
function buildCanonicalRequest(payload, dateTimeString) {
  return [
    REQUEST_TYPE,
    encodeURI(REQUEST_URI),
    '',
    ACCEPT_HEADER + ':' + CONTENT_TYPE,
    HOST_HEADER + ':' + HOST,
    XAMZDATE_HEADER + ':' + dateTimeString,
    XAMZTARGET_HEADER + ':' + SERVICE_TARGET,
    '',
    `${ACCEPT_HEADER};${HOST_HEADER};${XAMZDATE_HEADER};${XAMZTARGET_HEADER}`,
    crypto.createHash('sha256').update(payload).digest('hex')
  ].join('\n');
} // buildCanonicalRequest

/**
 * Builds the signed authorization for the http request.
 *
 * @param {String} payload - The stringified payload
 * @param {String} dateTimeString - The date in simple ISO8601 format
 * @param {String} accessKey - The incentives access key
 * @param {String} secretKey - The incentives secret key
 * @returns String - The signed authorization request
 */
function buildSignedAuthorizationRequest(payload, dateTimeString, accessKey, secretKey) {
  let dateString = dateTimeString.substring(0, 8);
  let canonicalRequest = buildCanonicalRequest(payload, dateTimeString);
  let canonicalRequestHash = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  let stringToSign = buildStringToSign(canonicalRequestHash, dateTimeString, dateString);
  let signingKey = buildSigningKey(dateString, secretKey);
  let signature = hmac_binary(signingKey, stringToSign).toString('hex');
  return [
    AWS_SHA256_ALGORITHM,
    ` Credential=${accessKey}/`,
    `${dateString}/`,
    `${REGION_NAME}/`,
    `${SERVICE_NAME}/`,
    `${TERMINATION_STRING},`,
    ` SignedHeaders=`,
    `${ACCEPT_HEADER};`,
    `${HOST_HEADER};`,
    `${XAMZDATE_HEADER};`,
    `${XAMZTARGET_HEADER},`,
    ` Signature=${signature}`
  ].join('');
} // buildSignedAuthorizationRequest

/**
 * Builds a signing key that is scoped to the region and service as
 * authentication information for the http request.
 *
 * @param {String} dateString - The date in YYYYMMDD format
 * @param {String} secretKey - The incentives secret key
 * @returns Buffer - The signing key
 */
function buildSigningKey(dateString, secretKey) {
  let dateKey = hmac_binary(KEY_QUALIFIER + secretKey, dateString);
  let dateRegionKey = hmac_binary(dateKey, REGION_NAME);
  let dateRegionServiceKey = hmac_binary(dateRegionKey, SERVICE_NAME);
  return hmac_binary(dateRegionServiceKey, 'aws4_request');
} // buildSigningKey

/**
 * Builds a string comprised of data that will be signed.
 *
 * @param {String} canonicalRequestHash - The hash of the canonical request in hex format
 * @param {String} dateTimeString - The date in simple ISO8601 format
 * @param {String} dateString - The date in YYYYMMDD format
 * @returns String - The string to sign
 */
function buildStringToSign(canonicalRequestHash, dateTimeString, dateString) {
  return [
    AWS_SHA256_ALGORITHM,
    dateTimeString,
    `${dateString}/${REGION_NAME}/${SERVICE_NAME}/${TERMINATION_STRING}`,
    canonicalRequestHash
  ].join('\n');
} // buildStringToSign

/**
 * Gets payload parameters used for creating a giftcard.
 *
 * @param partnerId - The Incentives Partner ID
 * @returns String - The payload stringified
 */
function getPayload(partnerId) {
  return JSON.stringify({
    creationRequestId: partnerId + '::' + crypto.randomUUID().replaceAll('-', ''),
    partnerId: partnerId,
    value: { currencyCode: CURRENCY_CODE, amount: AMOUNT }
  });
} // getPayload

/**
 * Access system manager parameter store and return secret value of the given name.
 *
 * @param secretName - The parameter store secret name
 * @returns String - The value of the secret
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
 * Creates a cryptographic HMAC digest.
 *
 * @param {String} key - The key used to create the cryptographic HMAC hash
 * @param {String} data - The data to hash
 * @returns Buffer - The HMAC digest
 */
function hmac_binary(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
} // hmac_binary

/**
 * Entry point from the handler to process the creation of an Amazon gift card.
 *
 * @returns Promise - The gift card info if successful, otherwise the error recieved
 */
async function start() {
  try {
    const DATE_TIME_STRING = dateUtils.format(dateUtils.now('Etc/GMT'), null, DATE_FORMAT);
    console.info('Attempting to retrieve system parameter secrets');
    const [ACCESS_KEY, SECREY_KEY, PARTNER_ID] = await Promise.all([
      getSecret('/Amazon/Incentives/AccessKey'),
      getSecret('/Amazon/Incentives/SecretKey'),
      getSecret('/Amazon/Incentives/PartnerId')
    ]);
    console.info('Successfully retrieved system parameter secrets');
    let payload = getPayload(PARTNER_ID);
    console.info('Successfully set payload');
    let auth = buildSignedAuthorizationRequest(payload, DATE_TIME_STRING, ACCESS_KEY, SECREY_KEY);
    console.info('Successfully set auth');
    const options = {
      method: METHOD,
      url: HOST_NAME,
      headers: {
        [ACCEPT_HEADER]: CONTENT_TYPE,
        [CONTENT_HEADER]: CONTENT_TYPE,
        [HOST_HEADER]: HOST,
        [XAMZDATE_HEADER]: DATE_TIME_STRING,
        [XAMZTARGET_HEADER]: SERVICE_TARGET,
        [AUTHORIZATION_HEADER]: auth
      },
      data: payload
    };
    console.info('Attempting to generate gift card');
    let resp = await axios(options);
    console.info('Successfully generated gift card');
    return Promise.resolve(resp.data);
  } catch (err) {
    if (err && err.response && err.response.data) {
      console.info('Failed to generate gift card with error: ' + JSON.stringify(err.response.data));
      return Promise.reject(err.response.data);
    } else {
      console.info('Failed to generate gift card with error: ' + JSON.stringify(err.response) || err);
      return Promise.reject(err.response || err);
    }
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
async function handler() {
  try {
    let giftCardInfo = await start();
    return Promise.resolve(giftCardInfo);
  } catch (err) {
    return Promise.reject(err);
  }
} // handler

module.exports = { handler };
