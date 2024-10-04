const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { add, getIsoWeekday, isAfter, DEFAULT_ISOFORMAT } = require('dateUtils');

const ssmClient = new SSMClient({ region: 'us-east-1' });

function getHoursRequired(employee, startDate, endDate) {
  let workDays = 0;
  let hireDate = employee.hireDate;
  if (isAfter(hireDate, startDate, 'day')) {
    startDate = hireDate;
  }
  while (!isAfter(startDate, endDate, 'day')) {
    let isoWeekDay = getIsoWeekday(startDate);
    if (isoWeekDay > 0 && isoWeekDay < 6) {
      workDays += 1;
    }
    // increment to the next day
    startDate = add(startDate, 1, 'day', DEFAULT_ISOFORMAT);
  }
  return workDays * (8 * (employee.workStatus / 100));
}

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

module.exports = {
  getHoursRequired,
  getSecret
};
