const dateUtils = require('dateUtils'); // from shared lambda layer

/**
 * Gets an array of time period batches to allow for efficient API calls. Goes 2 months
 * at a time until todays month has been met. When todays date has been met, get todays month through
 * the end date provided.
 *
 * @param {String} startDate - The time period start date
 * @param {String} endDate  - The time period end date
 * @returns Array - The list of start and end date batches to recieve timesheets data for
 */
function getTimesheetDateBatches(startDate, endDate) {
  let batches = [];
  // get start month and the next month
  let startBatchDate = dateUtils.startOf(startDate, 'day');
  let endBatchDate = dateUtils.endOf(dateUtils.add(startDate, 1, 'month', dateUtils.DEFAULT_ISOFORMAT), 'month');
  let today = dateUtils.getTodaysDate(dateUtils.DEFAULT_ISOFORMAT);
  while (dateUtils.isBefore(startBatchDate, endDate, 'day')) {
    batches.push({ startDate: startBatchDate, endDate: endBatchDate });
    // get next 2 months
    startBatchDate = dateUtils.startOf(dateUtils.add(endBatchDate, 1, 'month', dateUtils.DEFAULT_ISOFORMAT), 'month');
    endBatchDate = dateUtils.endOf(dateUtils.add(endBatchDate, 2, 'month', dateUtils.DEFAULT_ISOFORMAT), 'month');
    if (
      dateUtils.isSameOrAfter(startBatchDate, today, 'month') &&
      dateUtils.isBefore(startBatchDate, endDate, 'month')
    ) {
      // push this or next month all the way thoughout the end month
      batches.push({ startDate: startBatchDate, endDate: endDate });
      return batches;
    }
  }
  return batches;
} // getTimesheetDateBatches

module.exports = {
  getTimesheetDateBatches
};
