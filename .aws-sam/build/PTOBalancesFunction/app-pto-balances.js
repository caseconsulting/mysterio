const _ = require('lodash');

async function start() {
  let response;

  try {
      // const ret = await axios(url);
      response = {
          'statusCode': 200,
          'body': JSON.stringify({
              message: 'this is a pto-balances test string',
              // location: ret.data.trim()
          })
      }
  } catch (err) {
      console.log(err);
      return err;
  }
  return response;
}

async function handler(event) {
  console.info(JSON.stringify(event)); // eslint-disable-line no-console

  return start();
}

module.exports = { start, handler };
