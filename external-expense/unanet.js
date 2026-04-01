// utils
const axios = require('axios');
const dateUtils = require('dateUtils'); // from shared lambda layer
const hoursToSeconds = (hours) => hours * 60 * 60;

// AWS things
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);
const ssmClient = new SSMClient({ region: 'us-east-1' });

// stage
const STAGE = process.env.STAGE;
const URL_SUFFIX = STAGE === 'prod' ? '' : '-sand';
const BASE_URL = `https://consultwithcase${URL_SUFFIX}.unanet.biz/platform`;

// inter-function variables
let accessToken;
let errors = []; // list of non-critical errors for debugging/tracking

// consts
const TEAM_LEADS_KEY = STAGE === 'prod' ? 1 : 0; // TODO
const EMPLOYEE_PAY_KEY = 1;
const COMPANY_CARD_KEY = 2;
const USD_CODE = 119; // TODO check prod vs sandbox key

/**
 * Handler for Unanet timesheet data
 *
 * @param event - The lambda event
 * @returns Object - The timesheet data
 */
async function handler(event) {
  try {
    // pull out vars from the event
    let { actions, options } = event;
    console.log(event);
    eventOptions = options ?? {};
    
    // login
    accessToken = await getAccessToken();

    // map event.actions to functions with titles
    let map = {
      getExpenseTypes: {
        func: getUnanetExpenseTypes,
        name: 'expenseTypes'
      },
      getProjects: {
        func: getUnanetProjects,
        name: 'projects'
      },
      getExpenseType: {
        func: getUnanetExpenseTypes,
        name: 'expenseTypes'
      },
      getProject: {
        func: getUnanetProjects,
        name: 'projects'
      },
      createExpense: {
        func: createUnanetExpense,
        name: 'createExpense'
      }
    };
    let getMap = (key) => map[key] ?? { func: notImplemented, name: key };

    // build the response object
    if (!Array.isArray(actions)) actions = [actions];
    let body = {};
    for (let action of actions) {
      let { func, name } = getMap(action);
      body[name] = await func(options?.params ?? undefined);
    }

    // return everything together
    return { status: 200, body };
  } catch (err) {
    return await handleError(err);
  }
}

// |----------------------------------------------------|
// |                                                    |
// |                  AWS CONNECTIONS                   |
// |                                                    |
// |----------------------------------------------------|

/**
 * Gets a specific employee attribute from the database
 * Usage eg: const { id, email } = await getEmployeeAttrFromDb(10001, 'id', 'email');
 *
 * @param employeeNumber employee to retrieve data for
 * @param attrs attributes to fetch
 * @return An object with keys matching attrs
 */
async function getEmployeeAttrFromDb(employeeNumber, ...attrs) {
  // build command
  const TableName = `${STAGE}-employees`;
  const scanCommand = new ScanCommand({
    ProjectionExpression: attrs.join(','),
    FilterExpression: 'employeeNumber = :n OR employeeNumber = :s',
    ExpressionAttributeValues: { ':n': Number(employeeNumber), ':s': String(employeeNumber) },
    TableName
  });

  // send command
  console.log(scanCommand);
  resp = await docClient.send(scanCommand);

  // throw error or return object
  if (resp.Count !== 1)
    throw new Error(`Could not distinguish Portal employee ${employeeNumber} (${resp.Count} options).`);
  return resp.Items[0];
}

/**
 * Gets a specific employee attribute from the database
 * Usage eg: const { id, email } = await getEmployeeAttrFromDb(10001, 'id', 'email');
 *
 * @param employeeNumber employee to retrieve data for
 * @param attrs attributes to fetch
 * @return An object with keys matching attrs
 */
async function getPortalExpenseType(id) {
  // build command
  const TableName = `${STAGE}-expense-types`;
  const scanCommand = new ScanCommand({
    FilterExpression: 'id = :d',
    ExpressionAttributeValues: { ':d': id },
    TableName
  });

  // send command
  console.log(scanCommand);
  resp = await docClient.send(scanCommand);

  // throw error or return object
  if (resp.Count !== 1) throw new Error(`Could not find Portal expense type ${id}`);
  return resp.Items[0];
}

/**
 * Updates a user's personKey in DynamoDB for future use.
 * 
 * On error, this function will not stop the code from returning.
 *
 * @param employeeNumber user's portal employee number
 * @param personKey from Unanet to add to user's profile
 */
async function updateUserPersonKey(employeeNumber, personKey) {
  try {
    // common table for both commands
    const TableName = `${STAGE}-employees`;

    // find the user's ID
    const { id } = await getEmployeeAttrFromDb(employeeNumber, 'id');

    // use their ID to update the personKey
    const updateCommand = new UpdateCommand({
      TableName,
      Key: { id },
      UpdateExpression: `SET unanetPersonKey = :k`,
      ExpressionAttributeValues: { ':k': `${personKey}` }
    });
    await docClient.send(updateCommand);
  } catch (err) {
    errors.push(serializeError(err));
  }
}

/**
 * Updates an expense in the expenses table.
 *
 * @param obj object of expense, including the old id and the new/changed attributes
 */
async function updateExpenseDetails(obj) {
  try {
    if (!obj?.id || Object.keys(obj).length === 1)
      throw new Error('updateExpenseDetails requires an object with id and at least one attribute to update. Got keys '
                        + Object.keys(obj).join(', '));

    // build expression and attributes
    let expressions = [];
    let values = {};
    for (let [k, v] of obj) {
      expressions.push(`${k} = :${k}`);
      values[`:${k}`] = v;
    }
    let expression = 'SET ' + expressions.join(',');

    // use their ID to update the personKey
    const updateCommand = new UpdateCommand({
      TableName: `${STAGE}-expenses`,
      Key: { id: obj.id },
      UpdateExpression: expression,
      ExpressionAttributeValues: values
    });
    await docClient.send(updateCommand);
  } catch (err) {
    errors.push(serializeError(err));
  }
}

// |----------------------------------------------------|
// |                                                    |
// |                     API GETS                       |
// |                                                    |
// |----------------------------------------------------|

/**
 * Gets all expense types for individual expenses
 */
async function getUnanetExpenseTypes(keys) {
  if (keys && !Array.isArray(keys)) keys = [keys];

  // build options to find expense types
  let options = {
    method: 'GET',
    url: BASE_URL + '/rest/expense-types',
    params: {
      page: 1,
      pageSize: 2000, // get all
      enabled: true, // only active
      excludeOverage: true, // not including overage-allowed ETs
      excludeAdvanceAndCashReturn: true // exclude 'ADVANCE' and 'CASH RETURN'
    },
    headers: { Authorization: `Bearer ${accessToken}` }
  };

  // request data from Unanet API
  let resp = await axios(options);

  // map the items to a more direct usage format
  let types = [];
  for (let et of resp.data.items) {
    if (keys && !keys.includes(et.key)) continue;
    types.push({
      key: et.key,
      name: et.name,
      code: et.code
    })
  }

  // return just the array of expense types
  return types;
}

/**
 * Gets specific expense type or types based on Unanet keys
 * 
 * @param keys - array of keys to get expese types for
 */
async function getUnanetExpenseType(keys) {
  if (!Array.isArray(keys)) keys = [keys];

  // build options to find expense types
  let base = {
    method: 'GET',
    url: BASE_URL + '/rest/expense-types/',
    headers: { Authorization: `Bearer ${accessToken}` }
  };

  let promises = [];
  for (let k of keys) {
    promises.push(axios({ ...base, url: base.url + k }));
  }
  let resps = await Promise.all(promises);

  // map types to be useful format
  let types = {};
  for (let et of resps) {
    types[et.data.key] = {
      key: et.data.key,
      name: et.data.expenseTypeName,
      code: et.data.expenseType
    };
  }

  // return just the array of expense types
  return types;
}

/**
 * Gets all projects for mapping to Portal expense types
 */
async function getUnanetProjects(keys) {
  if (keys && !Array.isArray(keys)) keys = [keys];

  // build options to find projects
  let options = {
    method: 'POST',
    url: BASE_URL + '/rest/projects/search',
    params: { page: 1, pageSize: 2000 }, // get all in one query
    data: {}, // no search, just get all
    headers: { Authorization: `Bearer ${accessToken}` }
  };

  // request data from Unanet API
  let resp = await axios(options);

  // map the items to a more direct usage format
  let projects = [];
  for (let p of resp.data.items) {
    if (keys && !keys.includes(p.key)) continue;
    projects.push({
      key: p.key, // internal Unanet key
      orgCode: p.projectOrg.code, // Org, eg I_CASE
      name: p.title, // human-friendly name
      code: p.code, // computer/spreadsheet name
      open: p.status.name === 'Open' // whether the project is active in Unanet
    })
  }

  // return array of projects
  return projects;
}

/**
 * Gets specific project or projects based on Unanet keys
 * 
 * @param keys - array of keys to get projects for
 */
async function getUnanetProject(keys) {
  if (!Array.isArray(keys)) keys = [keys];

  // build options to find project
  let base = {
    method: 'GET',
    url: BASE_URL + '/rest/projects/',
    headers: { Authorization: `Bearer ${accessToken}` }
  };

  let promises = [];
  for (let k of keys) {
    promises.push(axios({ ...base, url: base.url + k }));
  }
  let resps = await Promise.all(promises);

  // map types to be useful format
  let projects = {};
  for (let et of resps) {
    projects[et.data.key] = {
      key: et.data.key,
      name: et.data.title,
      code: et.data.code
    };
  }

  // return just the array of projects
  return projects;
}

/**
 * Returns an auth token for the API account
 *
 * @returns the auth token
 */
async function getAccessToken() {
  // get login info from parameter store
  const params = { Name: '/Unanet/login', WithDecryption: true };
  const secret = await ssmClient.send(new GetParameterCommand(params));
  let { username, password } = JSON.parse(secret.Parameter.Value);
  if (!username || !password) throw new Error('Could not get login info from parameter store.');

  // build options to log in with user/pass from parameter store
  let options = {
    method: 'POST',
    url: BASE_URL + '/rest/login',
    data: { username, password }
  };

  // request and return token from Unanet API
  try {
    let resp = await axios(options);
    return resp.data.token;
  } catch (err) {
    throw new Error(`Login to Unanet failed: ${err.message}`);
  }
}

/**
 * Gets a user's key from Unanet API based on Portal employeeNumber
 *
 * @param employeeNumber Portal Employee Number
 * @returns Unanet personKey
 */
async function getUnanetPersonKey(employeeNumber) {
  // build options to find employee based on employeeNumber
  let options = {
    method: 'POST',
    url: BASE_URL + '/rest/people/search',
    data: {
      idCode1: employeeNumber
    },
    headers: { Authorization: `Bearer ${accessToken}` }
  };

  // request data from Unanet API
  let resp = await axios(options);

  // pull out the employee's key
  if (resp.data?.items?.length !== 1)
    throw new Error(`Could not distinguish Unanet employee ${employeeNumber} (${resp.data.length} options).`);
  let personKey = resp.data.items[0].key;

  // update user's DynamoDB object and return for usage now
  // await updateUserPersonKey(employeeNumber, personKey);
  return personKey;
}

// |----------------------------------------------------|
// |                                                    |
// |                     API POSTS                      |
// |                                                    |
// |----------------------------------------------------|

/**
 * Creates an expense
 */
async function createUnanetExpense(portalExpense) {
  // company card vs employee paid
  let paymentMethod = portalExpense.companyCard ? COMPANY_CARD_KEY : EMPLOYEE_PAY_KEY;
  // get expense type
  let expenseType = await getPortalExpenseType(portalExpense.expenseTypeId);
  if (!expenseType?.unanetExpenseType) throw new Error(`No Unanet Expense Type associated with Portal Expense Type ${expenseType.budgetName}`)
  // get employee Unanet key
  let employeeKey = await getUnanetPersonKey(portalExpense.employeeId);
  // task key is only set for 'Team Leads'
  let taskKey = expenseType.name === 'Team Leads' ? TEAM_LEADS_KEY : undefined;

  // build expense (report)
  let expense = {
    purpose: portalExpense.budgetName,
    expenseProjectAllocations: [
      {
        projectKey: expenseType.unanetExpenseTypeKey,
        allocation: 100,
        taskKey
      }
    ],
    voucherType: "EXPENSE_REPORT"
  };

  // build details
  let details = {
    expenseTypeKey: expenseType.unanetExpenseTypeKey, // TODO: is this right?
    paymentMethodKey: paymentMethod,
    expenseDate: portalExpense.purchaseDate,
    amount: Number(portalExpense.cost),
    expenseAmount: Number(portalExpense.cost),
    exchangeRate: 1, // USD -> USD
    transactionCurrency: USD_CODE,
    comments: portalExpense.humandId ?? undefined
  }

  // create expense report and submit details
  let expenseKey = await submitUnanetExpense(expense);
  let detailsKey = await submitUnanetExpenseDetails(details, expenseKey);

  // update Portal expense in AWS
  let detailsKeys = (portalExpense.unanetExpenseDetailsKeys ?? []).push(detailsKey);
  let newExp = {
    id: portalExpense.id,
    unanetExpenseKey: expenseKey,
    unanetExpenseDetailsKeys: detailsKeys,
    state: 'PROCESSED'
  }
  await updateExpenseDetails(newExp);
}

/**
 * Creates initial expense report.
 * 
 * @param expense basic expense details
 * @returns unanet key of submitted expense
 */
async function submitUnanetExpense(expense) {
  // build options to submit expense
  let options = {
    method: 'POST',
    url: BASE_URL + '/rest/expenses',
    params: { ownerKey: 9 },
    data: expense,
    headers: { Authorization: `Bearer ${accessToken}` }
  };

  // request data from Unanet API
  let resp = await axios(options);

  // pull out the employee's key
  if (!resp.data?.key) throw new Error(`Failed to submit expense to Unanet.`);
  return resp.data.key;
}

/**
 * Adds actual expense details to expense report
 * 
 * @param details of expense
 * @returns unanet key of details
 */
async function submitUnanetExpenseDetails(details, expenseId) {
  // build options to submit details to expense report
  let options = {
    method: 'POST',
    url: BASE_URL + `/rest/expenses/${expenseId}/details`,
    data: details,
    headers: { Authorization: `Bearer ${accessToken}` }
  };

  // request data from Unanet API
  let resp = await axios(options);

  // pull out the employee's key
  if (!resp.data?.key) throw new Error(`Failed to submit expense details to Unanet.`);
  return resp.data.key;
}

// |----------------------------------------------------|
// |                                                    |
// |                       HELPERS                      |
// |                                                    |
// |----------------------------------------------------|

/**
 * Returns the not implemented response
 */
function notImplemented() {
  return {
    status: 501,
    message: "Action not found or not provided."
  }
}

/**
 * Helper to seralize an error
 *
 * @param err the error to seralized
 * @returns object of serialized data for printing/returning
 */
function serializeError(err) {
  if (!err) return null;
  if (typeof err === 'string') return err;
  return {
    name: err.name ?? null,
    message: err.message ?? null,
    stack: err.stack ?? null
  };
}

/**
 * Helper to redact data from a string
 *
 * @param str string to redact
 * @param start how many characters to keep on the start
 * @param end how many characters to keep on the end
 * @param fill (optional) characters to fill in place of redacted data
 * @returns The redacted string
 */
function redact(str, start, end, fill = '***') {
  if ([str, start, end, fill].some((v) => v == null)) return null;
  return str.slice(0, start) + fill + str.slice(-end);
}

/**
 * Builds an object to use in Promise rejections based on whether
 * or not Unanet is down, or if it was the code that errored.
 *
 * @param err Error object
 * @returns object to use for Promise.reject()
 */
async function handleError(err) {
  // make sure the error function doesn't error
  err ??= new Error('Unknown error occurred.');

  // body to return either way
  let body = {
    stage: STAGE ?? null,
    url: BASE_URL ?? null,
    api_key: redact(accessToken, 8, 8),
    err: serializeError(err)
  };

  // return codes based on result of ping
  let ping = await axios.get(BASE_URL + '/rest/ping');
  if (ping?.status < 300 && ping?.status >= 200) {
    // Unanet is up
    return {
      status: 500,
      message: err.message,
      code: err.code,
      body
    };
  } else {
    // Unanet is down
    return {
      status: 503,
      message: 'Unanet API failed to respond.',
      code: 'ERR_UNANET_DOWN',
      body
    };
  }
}

// |----------------------------------------------------|
// |                                                    |
// |                        EXPORT                      |
// |                                                    |
// |----------------------------------------------------|

module.exports = {
  handler
};
