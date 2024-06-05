const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const lambdaClient = new LambdaClient();

/**
 * Async function to loop an array.
 *
 * @param array - Array of elements to iterate over
 * @param callback - callback function
 */
async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
} // asyncForEach

/**
 * Invokes lambda function with given params
 *
 * @param params - params to invoke lambda function with
 * @return object if successful, error otherwise
 */
async function invokeLambda(params) {
  const command = new InvokeCommand(params);
  const resp = await lambdaClient.send(command);
  return JSON.parse(Buffer.from(resp.Payload));
} // invokeLambda

module.exports = {
  asyncForEach,
  invokeLambda
};
