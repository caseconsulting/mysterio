const { handler: adpHandler } = require('./adp-timesheets');
const { handler: quickbooksHandler } = require('./quickbooks-timesheets');
const dateUtils = require('dateUtils'); // from shared lambda layer

/**
 * Begin execution of timesheet Lambda Function
 *
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 */
async function start(event) {
  try {
    // set to true to not get data from the Legacy CYK ADP account
    const DISABLE_LEGACY_ADP = true;
    
    // split up periods if needed
    let adpEvent;
    let qbEvent = event;
    let splitForADP = !DISABLE_LEGACY_ADP && event.periods && event.legacyADP;
    if (splitForADP) {
      let year2024 = dateUtils.setYear(dateUtils.getTodaysDate(), '2024');
      if (dateUtils.isSame(year2024, event.periods[0].startDate, 'year')) {
        adpYear = event.periods[0];
        adpEvent = {
          ...event,
          periods: [event.periods[0]]
        }
        qbEvent = {
          ...event,
          periods: [event.periods[1]]
        }
      }
    }

    // get ADP if needed
    let adpResults = [];
    if (splitForADP) adpResults = await adpHandler(adpEvent)
    
    // get QB always
    let results = await quickbooksHandler(qbEvent);

    // await ADP if it's being fetched
    if (splitForADP && adpResults?.body) {
      results = {
        ...results,
        body: {
          ...results.body,
          timesheets: [
            ...adpResults.body.timesheets,
            ...results.body.timesheets
          ],
          nonBillables: Array.from(new Set([
            ...adpResults.body.nonBillables || [],
            ...results.body.nonBillables || []
          ]))
        }
      }
    }

    // return
    if (DISABLE_LEGACY_ADP && event.legacyADP) results.body.warning = 'Timesheets do not include CYK ADP data before 01/01/2025';
    return results;

  } catch (err) {
    console.log(err);
    return err;
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
} // handler

module.exports = { handler };
