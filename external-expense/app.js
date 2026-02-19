const { handler: unanetHandler } = require('./unanet');
const dateUtils = require('dateUtils'); // from shared lambda layer
const { getSecret } = require('./secrets');

let accessToken;
const STAGE = process.env.STAGE;
const IS_PROD = STAGE === 'prod';
const URL_SUFFIX = IS_PROD ? '' : '-sand';
const BASE_URL = `https://consultwithcase${URL_SUFFIX}.unanet.biz/platform`;

/**
 * The handler for unanet timesheet data
 *
 * @param {Object} event - The lambda event
 * @returns Object - The timesheet data
 */
async function handler(event) {
  try {
    return await unanetHandler(event);
  } catch (err) {
    console.log(err);
    return Promise.reject({
      statusCode: 500,
      body: {
        stage: STAGE ?? 'undefined',
        is_prod: IS_PROD ?? 'undefined',
        url: BASE_URL ?? 'undefined',
        // login: { user: redact(LOGIN.username, 'email'), pass: redact(LOGIN.password, 'password') },
        api_key: redact(accessToken, 'apikey'),
        err: err ?? 'undefined'
      }
    });
  }
} // handler


module.exports = {
  handler
};
