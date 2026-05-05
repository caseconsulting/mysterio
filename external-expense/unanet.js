
/**
 * Status mapping:
 *     UNANET         PORTAL
 * INUSE       ->  CREATED
 * COMPLETED   ->  CREATED
 * SUBMITTED*  ->  CREATED
 * APPROVING   ->  APPROVED
 * DENIED      ->  RETURNED
 * EXTRACTED   ->  REIMBURSED
 * LOCKED*     ->  REIMBURSED
 * 
 * Not use:
 * REQUEST_SUBMITTED  ->  
 * PENDING_REVIEW     ->  
 * PREAPPROVING       ->  
 * DISAPPROVED        ->  
 * REQUESTING         ->  
 * PREAPPROVED        ->  
 * 
 */

// utils
var fs = require('fs');
const axios = require('axios');
const mime = require('mime-types');
const dateUtils = require('dateUtils'); // from shared lambda layer
const hoursToSeconds = (hours) => hours * 60 * 60;

// AWS things
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);
const ssmClient = new SSMClient({ region: 'us-east-1' });
const s3Client = new S3Client({ apiVersion: '2006-03-01' });

// stage
const STAGE = process.env.STAGE;
const IS_PROD = process.env.STAGE === 'prod';
const URL_SUFFIX = IS_PROD ? '' : '-sand';
const BASE_URL = `https://consultwithcase${URL_SUFFIX}.unanet.biz/platform`;
const PROD_FORMAT = IS_PROD ? 'consulting-' : ''; // TODO: still needed?
const RECEIPTS_BUCKET = `case-${PROD_FORMAT}expense-app-attachments-${STAGE}`;

// inter-function variables
let accessToken;
let errors = []; // list of non-critical errors for debugging/tracking

// consts
// some unanet keys/codes happen to be the same but may change
const TEAM_LEADS_KEY = IS_PROD ? 178 : 178;
const EMPLOYEE_PAY_KEY = 1;
const COMPANY_CARD_KEY = 2;
const USD_CODE = IS_PROD ? 119 : 119;

/**
 * Handler for Unanet timesheet data
 *
 * @param event - The lambda event
 * @returns Object - The timesheet data
 */
async function handler(event) {
  try {
    console.info('Starting...')
    // pull out vars from the event
    console.info('Pulling out actions and options from event: ' + JSON.stringify(event));
    let { action, options, params } = event;
    eventOptions = options ?? {};
    
    // login
    accessToken = await getAccessToken();

    // build the response object
    console.info('Running given function: ' + action);
    let body;
    switch (action) {
      // gets all expense types
      case 'getExpenseTypes':
        body = await getUnanetExpenseTypes();
        break;
      // gets specific expense types
      case 'getExpenseType':
        body = await getUnanetExpenseType(params?.keys);
        break;
      // gets all projects
      case 'getProjects':
        body = await getUnanetProjects();
        break;
      // gets specific projects
      case 'getProject':
        body = await getUnanetProject(params?.keys);
        break;
      // pushes an expense from Portal to Unanet
      case 'portalSync':
        body = await syncPortalToUnanet(params?.expense);
        break;
      // graceful not found error
      default:
        body = notImplemented();
        break;
    }

    // return everything together
    console.info('Done! Returning 200');
    console.info('Return body: ' + JSON.stringify(body));
    return { status: 200, body };
  } catch (err) {
    return await handleError(err);
  }
}

/**
 * For testing. Delete.
 */
async function test(params) {
  console.info('Begin test');
  let { expense } = params;

  // let { expenseKey, detailsKeys } = await createUnanetExpense(expense);
  // await submitUnanetExpense(expenseKey, 'comment!');

  await syncPortalToUnanet(expense);

  console.info('End test');
  return { status: 200 };
}

// |----------------------------------------------------|
// |                                                    |
// |                   SYNC FUNCTIONS                   |
// |                                                    |
// |----------------------------------------------------|

/**
 * Syncs a Portal expense to Unanet. Will create expense or update
 * as needed.
 * 
 * @param expense - Portal expense to sync
 */
async function syncPortalToUnanet(expense) {
  console.info('Syncing a Portal expense to Unanet, id ' + expense?.id);
  if (!expense?.id) throw new Error('Expense object required for sync');

  // no unanet data - create expense in Unanet
  if (!expense.unanetData) {
    console.info('No Unanet info, submitting for first time');
    let { expenseKey, detailsKeys } = await createUnanetExpense(expense);
    let { expense: newExpense } = await updateDynamoExpenseDetails(expense, expenseKey, detailsKeys);
    expense = newExpense;
  }
  
  // fetch Unanet data
  console.info('Fetching Unanet data for sync');
  let { expenseKey, detailsKeys } = expense.unanetData;
  let { [expenseKey]: unanetExpense } = await getUnanetExpense(expenseKey);
  // let details = await getUnanetDetails(expenseKey, detailsKeys);

  // update status if needed
  const UNANET_STATES = {
    USER_CONTROL: new Set(['INUSE', 'COMPLETED']),
    ADMIN_CONTROL: new Set(['SUBMITTED', 'APPROVING', 'DENIED', 'EXTRACTED', 'LOCKED'])
  }
  const PORTAL_STATES = {
    USER_CONTROL: new Set(['CREATED', 'APPROVED', 'REJECTED', 'RETURNED', 'REVISED']),
    ADMIN_CONTROL: new Set(['REIMBURSED', 'REJECTED'])
  }
  // we can only put Unanet expenses in INUSE and APPROVING
  if (UNANET_STATES.USER_CONTROL.has(unanetExpense.status) && PORTAL_STATES.ADMIN_CONTROL.has(expense.state)) {
    console.info('Unanet expense is in ' + unanetExpense.status + ' status, submitting to match Portal state ' + expense.state);
    await submitUnanetExpense(expenseKey, 'Auto-submitted by via Portal API connection');
  } else if (UNANET_STATES.ADMIN_CONTROL.has(unanetExpense.status) && PORTAL_STATES.USER_CONTROL.has(expense.state)) {
    console.info('Unanet expense is in ' + unanetExpense.status + ' status, editing Portal expense to be state ' + expense.state);

  } else {
    console.info('Doing nothing: Unanet expense is in ' + unanetExpense.status + ' status, which already matches Portal state ' + expense.state);
  }

  // return the new Portal expense in case it's changed
  return expense;

  // TODO: whatever else can be done? Might not be anything tbh
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
  console.info('Getting attribute(s) from db with for employee ' + employeeNumber + ': ' + attrs.join(', '));
  // build command
  const TableName = `${STAGE}-employees`;
  const scanCommand = new ScanCommand({
    ProjectionExpression: attrs.join(','),
    FilterExpression: 'employeeNumber = :n OR employeeNumber = :s OR id = :d',
    ExpressionAttributeValues: { ':n': Number(employeeNumber) || 0, ':s': String(employeeNumber), ':d': String(employeeNumber) },
    TableName
  });

  // send command
  console.info('Sending scan command to database');
  let resp = await docClient.send(scanCommand);
  console.info('Scan command returnd without error');

  // throw error or return object
  if (resp.Count !== 1)
    throw new Error(`Could not distinguish Portal employee ${employeeNumber} (${resp.Count} options).`);
  console.info('Found one employee and returned requested data');
  return resp.Items[0];
}

/**
 * Gets an expense from DynamoDB. Also fetches the receipts unless disabled.
 *
 * @param employeeNumber employee to retrieve data for
 * @param fetchReceipts whether or not to download receipts
 * @return An object with keys matching attrs
 */
async function getPortalExpense(id, fetchReceipts = true) {
  console.info('Fetching a Portal expense from Dynamo');
  // build command
  const TableName = `${STAGE}-expenses`;
  const scanCommand = new ScanCommand({
    KeyConditionExpression: 'id = :d',
    ExpressionAttributeValues: { ':d': id },
    TableName
  });

  // send command and check for error
  console.info('Sending command');
  let resp = await docClient.send(scanCommand);
  if (resp.Count !== 1) throw new Error(`Could not find Portal expense type ${id}`);
  console.info('Command returned successfully');

  // get expense, return if not fetching receipts
  let expense = resp.Items[0];
  if (!fetchReceipts) {
    console.info('No receipts requested, returning expense by itself');
    return { expense };
  }

  // fetch receipts (function logs)
  let receipts = getAttachmentFromS3(expense);
  
  // return both
  console.info('Receipts fetched, returning expense and receipts');
  return { expense, receipts };
}

/**
 * Get expense type from DynamoDB
 *
 * @param id id in Dynamo of expense to fetch
 * @return Object of portal expense
 */
async function getPortalExpenseType(id) {
  console.info('Getting Portal expense type with ID ' + id);
  // build command
  const TableName = `${STAGE}-expense-types`;
  const scanCommand = new ScanCommand({
    FilterExpression: 'id = :d',
    ExpressionAttributeValues: { ':d': id },
    TableName
  });

  // send command
  console.info('Sending command');
  let resp = await docClient.send(scanCommand);
  console.info('Command returned without error');

  // throw error or return object
  if (resp.Count !== 1) throw new Error(`Could not find Portal expense type ${id}`);
  console.info('Found Portal expense type');
  return resp.Items[0];
}

/**
 * Patches expense data with new information
 * 
 * @param id id of expense 
 * @param newData object of new data to patch
*/
async function updateDynamoExpense(id, newData) {
  // Build the UpdateExpression and ExpressionAttributeValues dynamically
  const updateExpressionParts = [];
  const expressionAttributeValues = {};
  const expressionAttributeNames = {};

  Object.keys(newData).forEach((key, index) => {
    updateExpressionParts.push(`#key${index} = :value${index}`);
    expressionAttributeNames[`#key${index}`] = key;
    expressionAttributeValues[`:value${index}`] = newData[key];
  });

  const updateExpression = `SET ${updateExpressionParts.join(", ")}`;

  const params = {
    TableName: `${STAGE}-expenses`,
    Key: { id },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: "ALL_NEW",
  };

  const command = new UpdateCommand(params);
  const response = await docClient.send(command);
  return response.Attributes;
}

/**
 * Updates an expense in the expenses table.
 *
 * @param oldExpense full old expense object
 * @param expenseKey key of unanet expense
 * @param detailsKeys keys of all details
 */
async function updateDynamoExpenseDetails(oldExpense, expenseKey, detailsKeys) {
  console.info('Updating expense details');
  try {
    // build expression and attributes
    console.info('Building expense...');
    let data = { expenseKey };
    if (detailsKeys) {
      if (!Array.isArray(detailsKeys)) detailsKeys = [detailsKeys];
      data.detailsKeys = [
        ...(oldExpense.unanetData?.detailsKeys ?? []),
        ...detailsKeys
      ];
      data.detailsKeys = Array.from(new Set(data.detailsKeys))
    }
    console.info('Finished building expense, running update command...');

    let info = {
      TableName: `${STAGE}-expenses`,
      Key: { id: oldExpense.id },
      UpdateExpression: 'SET #col = :data',
      ExpressionAttributeNames: { '#col': 'unanetData' },
      ExpressionAttributeValues: { ':data': data }
    }
    const updateCommand = new UpdateCommand(info);
    let resp = await docClient.send(updateCommand);
    console.info('Update command success, returning success');

    let newExpense = { ...oldExpense, unanetData: data };
    return { status: resp.$metadata.httpStatusCode, detailsKeys: data.detailsKeys, expense: newExpense };
  } catch (err) {
    console.log(err);
    errors.push(serializeError(err));
  }
}

/**
 * Gets an attachment from S3.

  * @param expense - expense object for which to get receipts
  * @return Object - file read from s3
  */
async function getAttachmentFromS3(expense) {
  console.info('Fetching attachment from S3');
  // ensure expense receipts is an array
  if (!expense.receipt) {
    console.info('No receipt on expense, returning empty');
    return [];
  }
  let receipts = Array.isArray(expense.receipt) ? expense.receipt : [expense.receipt];
  
  // fill in base64 receipts
  let base64Receipts = [];
  let [method, responseType] = ['GET', 'arraybuffer']
  for (let i = 0; i < receipts.length; i++) {
    console.info(`Fetching receipt ${i + 1}/${receipts.length}`);
    // set params
    let fileName = receipts[i];
    let filePath = `${expense.employeeId}/${expense.id}/${fileName}`;
    let params = { Bucket: RECEIPTS_BUCKET, Key: filePath };
    // get URL with decryption info
    console.info('Building signed URL and fetching...');
    let command = new GetObjectCommand(params);
    let url = await getSignedUrl(s3Client, command, { expiresIn: 60 });
    // fetch receipt from URL and encode into base64
    let response = await axios({ method, url, responseType });
    console.info('Fetched! Converting to base64 and continuing');
    base64Receipts[i] = {
      name: fileName,
      data: Buffer.from(response.data, 'binary').toString('base64'),
    }
  }

  // return base64 encoded receipts
  console.info('All receipts fetched');
  return base64Receipts;
} // getAttachmentFromS3

// |----------------------------------------------------|
// |                                                    |
// |                     API GETS                       |
// |                                                    |
// |----------------------------------------------------|

/**
 * Gets all expense types for individual expenses
 */
async function getUnanetExpenseTypes(keys) {
  console.info('Getting Unanet expense types');
  if (keys && !Array.isArray(keys)) {
    keys = [keys];
    console.log('... for keys ' + keys.join(', '));
  }

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
  console.info('Sending request to Unanet...');
  let resp = await axios(options);
  console.info('Request returned successfully, mapping into useful format...');

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
  console.info('Map success, returning');
  return types;
}

/**
 * Gets all projects for mapping to Portal expense types
 */
async function getUnanetProjects(keys) {
  console.info('Getting Unanet projects');
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
  console.info('Sending request to Unanet...');
  let resp = await axios(options);

  // map the items to a more direct usage format
  console.info('Request returned successfully, mapping into useful format...');
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
  console.info('Map success, returning');
  return projects;
}

/**
 * Gets Unanet expense attachments
 * 
 * @param keys keys or expenses to get
 * @returns object of attachments, indexed by expense ID
 */
async function getUnanetExpenseAttachments(keys) {
  if (!Array.isArray(keys)) keys = [keys];
  console.info('Getting Unanet expense attachments for key(s) ' + keys.join(', '));

  // build options
  let base = {
    method: 'GET',
    url: BASE_URL + '/rest/expenses/',
    headers: { Authorization: `Bearer ${accessToken}` }
  };

  // get attachment IDs for each item
  let promises = [];
  for (let key of keys) promises.push(axios({ ...base, url: base.url + key + '/attachments' }));
  console.info('Getting attachment IDs for expenses...');
  let resps = await Promise.all(promises);
  console.info('All promises returned, parsing attachment IDs...');
  let attachmentIds = {};
  for (let i in keys) attachmentIds[keys[i]] = resps[i].data.items.map(item => item.key);

  // fetch attachment data per receipt
  let attachments = {};
  let i = 0;
  for (let key of keys) {
    console.info(`Fetching attachments for expense ${key} (${++i}/${keys.length})`);
    promises = [];
    for (let attId of attachmentIds[key]) {
      promises.push(axios({ ...base, url: base.url + key + '/attachments/' + attId }));
    }
    resps = await Promise.all(promises);
    attachments[key] = resps.map(r => r.data);
    console.info('Fetched successfully');
  }

  // :)
  console.info('Done, returning all attachments');
  return attachments;
}

/**
 * Gets unanet expenses based on key
 * 
 * @param keys key or array of keys to get
 * @returns expense object
 */
async function getUnanetExpense(keys) {
  if (!Array.isArray(keys)) keys = [keys];
  console.info('Getting Unanet expenses with key(s) ' + keys.join(', '));

  // build options to find expenses
  let base = {
    method: 'GET',
    url: BASE_URL + '/rest/expenses/',
    headers: { Authorization: `Bearer ${accessToken}` }
  };

  let promises = [];
  for (let k of keys) promises.push(axios({ ...base, url: base.url + k }));
  let resps = await Promise.all(promises);
  console.info('Expenses fetched, extracting info...');

  // map expenses to be useful format
  let expenses = {};
  for (let exp of resps) {
    expenses[exp.data.key] = {
      // references to other Unanet data
      key: exp.data.key,
      creator: exp.data.creatorKey,
      controller: exp.data.controller.key,
      owner: {
        key: exp.data.owner.key,
        username: exp.data.owner.username,
        email: exp.data.owner.email
      },
      expenseTypes: [], // filled out below
      // other data
      cost: exp.data.reimbursableAmount,
      created: exp.data.createdDate,
      purpose: exp.data.purpose, // often Portal expense type name, but no guarantee
      location: exp.data.location,
      status: exp.data.status,
      pendingReview: exp.data.pendingReview,
      attachmentCount: exp.data.attachmentCount,
    };
    // fill out expense types from details (could be multiple)
    for (let detail of exp.data.expenseDetails) {
      expenses[exp.data.key].expenseTypes.push(detail.expenseType.key);
    }
  }

  console.info('Expense info extracted, returning');

  // return just the array of expenses
  return expenses;
}

/**
 * Gets Unanet details
 * 
 * @param expenseKey Unanet key of expense
 * @param keys keys of details
 */
async function getUnanetDetails(expenseKey, keys) {
  if (!Array.isArray(keys)) keys = [keys];
  console.info('Getting details for expense ' + expenseKey + ' with ID(s) ' + keys.join(', '));

  // build options to find expenses
  let base = {
    method: 'GET',
    url: BASE_URL + `/rest/expenses/${expenseKey}/details/`,
    headers: { Authorization: `Bearer ${accessToken}` }
  };

  console.info('Sending promises...');
  let promises = [];
  for (let k of keys) promises.push(axios({ ...base, url: base.url + k }));
  let resps = await Promise.all(promises);
  console.info('Promises returned successfully, mapping into useful format...');

  // map expenses to be useful format
  let details = {};
  for (let detail of resps) {
    details[detail.data.key] = {
      // references to other Unanet data
      key: detail.data.key,
      expenseType: detail.data.expenseType.key,
      // other data
      cost: detail.data.amount,
      created: detail.data.expenseDate,
    };
  }

  // return just the array of expenses
  console.info('Mapping complete, returning');
  return details;
}

/**
 * Gets specific expense type or types based on Unanet keys
 * 
 * @param keys - array of keys to get expese types for
 */
async function getUnanetExpenseType(keys) {
  if (!Array.isArray(keys)) keys = [keys];
  console.info('Getting Unanet expense type with of key(s) ' + keys.join(', '));

  // build options to find expense types
  let base = {
    method: 'GET',
    url: BASE_URL + '/rest/expense-types/',
    headers: { Authorization: `Bearer ${accessToken}` }
  };

  console.info('Building and sending promises...');
  let promises = [];
  for (let k of keys) promises.push(axios({ ...base, url: base.url + k }));
  let resps = await Promise.all(promises);
  console.info('Promises returned successfully, mapping into useful format...');

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
  console.info('Map success, returning');
  return types;
}

/**
 * Gets specific project or projects based on Unanet keys
 * 
 * @param keys - array of keys to get projects for
 */
async function getUnanetProject(keys) {
  if (!Array.isArray(keys)) keys = [keys];
  console.info('Getting Unanet projects with key(s) ' + keys.join(', '));

  // build options to find project
  let base = {
    method: 'GET',
    url: BASE_URL + '/rest/projects/',
    headers: { Authorization: `Bearer ${accessToken}` }
  };

  console.info('Running promises...');
  let promises = [];
  for (let k of keys) promises.push(axios({ ...base, url: base.url + k }));
  let resps = await Promise.all(promises);
  console.info('Promise(s) returned successfully, mapping to useful format...');

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
  console.info('Map success, returning');
  return projects;
}

/**
 * Returns an auth token for the API account
 *
 * @returns the auth token
 */
async function getAccessToken() {
  console.info('Getting Unanet access token');
  // get login info from parameter store
  console.info('Getting login info from Parameter Store...');
  const params = { Name: '/Unanet/login', WithDecryption: true };
  const secret = await ssmClient.send(new GetParameterCommand(params));
  let { username, password } = JSON.parse(secret.Parameter.Value);
  if (!username || !password) throw new Error('Could not get login info from parameter store.');
  console.info('Login info retrieved, making request...');

  // build options to log in with user/pass from parameter store
  let options = {
    method: 'POST',
    url: BASE_URL + '/rest/login',
    data: { username, password }
  };

  // request and return token from Unanet API
  try {
    let resp = await axios(options);
    console.info('Token received, returning');
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
  console.info(`Getting Unanet person key for Portal employee number ${employeeNumber}`);
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
  console.info('Sending request to Unanet...');
  let resp = await axios(options);
  let items = resp.data?.items ?? [];
  console.info('Found ' + items.length + ' items matching employee number.')

  // pull out the employee's key
  if (items.length !== 1)
    throw new Error(`Could not distinguish Unanet employee ${employeeNumber} (${items.length || undefined} options).`);
  let personKey = items[0].key;

  // update user's DynamoDB object and return for usage now
  // await updateUserPersonKey(employeeNumber, personKey);
  console.info(`Person key retrieved: ${personKey}, returning`);
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
  console.info('Creating Unanet expense for Portal expense ' + portalExpense.id);
  // company card vs employee paid
  let paymentMethod = portalExpense.companyCard ? COMPANY_CARD_KEY : EMPLOYEE_PAY_KEY;
  // get expense type
  let expenseType = await getPortalExpenseType(portalExpense.expenseTypeId);
  if (!expenseType?.unanetExpenseType) throw new Error(`No Unanet Expense Type associated with Portal Expense Type ${expenseType.budgetName}`)
  // get employee Unanet key
  let { employeeNumber } = await getEmployeeAttrFromDb(portalExpense.employeeId, 'employeeNumber');
  let employeeKey = await getUnanetPersonKey(employeeNumber);
  // task key is only set for 'Team Leads'
  let taskKey = expenseType.budgetName.toLowerCase().includes('team lead') ? TEAM_LEADS_KEY : undefined;

  // build expense (report)
  console.info('Building expense and details...');
  let expense = {
    purpose: portalExpense.budgetName,
    expenseProjectAllocations: [
      {
        projectKey: expenseType.unanetProject,
        allocation: 100,
        taskKey
      }
    ],
    voucherType: "EXPENSE_REPORT"
  };

  // build details
  let details = {
    expenseTypeKey: expenseType.unanetExpenseType,
    paymentMethodKey: paymentMethod,
    expenseDate: portalExpense.purchaseDate,
    amount: Number(portalExpense.cost),
    expenseAmount: Number(portalExpense.cost),
    exchangeRate: 1, // USD -> USD
    transactionCurrency: USD_CODE,
    comments: portalExpense.humandId ?? undefined
  }
  
  // create expense report and submit details
  console.info('Creating Unanet expense and details...');
  let expenseKey = await postUnanetExpense(expense, employeeKey);
  let detailsKey = await submitUnanetExpenseDetails(details, expenseKey);
  console.info('Success creating Unanet expense and details, uploading any attachments...');
  
  // get receipts from S3 and upload to expense
  let receipts = await getAttachmentFromS3(portalExpense);
  for (let rec of receipts) await attachToUnanetExpense(expenseKey, rec.name, rec.data, detailsKey);
  console.info('Done uploading attachment(s), updating in Dynamo');

  // update Portal expense in AWS
  let { detailsKeys } = await updateDynamoExpenseDetails(portalExpense, expenseKey, detailsKey);

  console.info('Update in Dynamo Success, returning expenseKey and detailsKeys');
  return { expenseKey, detailsKeys };
}

/**
 * Creates initial expense report.
 * 
 * @param expense basic expense details
 * @returns unanet key of submitted expense
 */
async function postUnanetExpense(expense, ownerKey) {
  console.info('Posting a Unanet expense via API');
  // build options to submit expense
  let options = {
    method: 'POST',
    url: BASE_URL + '/rest/expenses',
    params: { ownerKey },
    data: expense,
    headers: { Authorization: `Bearer ${accessToken}` }
  };

  // request data from Unanet API
  console.info('Sendint expense to API...');
  let resp = await axios(options);
  
  // pull out the employee's key
  if (!resp.data?.key) throw new Error(`Failed to submit expense to Unanet.`);
  console.info('Success! Returning returned key');
  return resp.data.key;
}

/**
 * Adds actual expense details to expense report
 * 
 * @param details of expense
 * @returns unanet key of details
 */
async function submitUnanetExpenseDetails(details, expenseKey) {
  console.info('Submitting expense details to Unanet for expense ' + expenseKey);
  // build options to submit details to expense report
  let options = {
    method: 'POST',
    url: BASE_URL + `/rest/expenses/${expenseKey}/details`,
    data: details,
    headers: { Authorization: `Bearer ${accessToken}` }
  };

  // request data from Unanet API
  let resp = await axios(options);

  // pull out the employee's key
  if (!resp.data?.key) throw new Error(`Failed to submit expense details to Unanet.`);
  console.info('Success, returning key');
  return resp.data.key;
}

/**
 * Uploads an attachment to a Unanet expense
 * 
 * @param expenseKey key of expense in Unanet
 * @param name name of attachment
 * @param attachment stringified version of attachment (base64)
 * @param detailId (optional) specific expense detail to link to
 * @return Unanet key of attachment
 */
async function attachToUnanetExpense(expenseKey, name, attachment, detailId) {
  console.info(`Attaching ${name} to ${expenseKey} and detail key ${detailId}`);
  let options = {
    method: 'POST',
    url: BASE_URL + `/rest/expenses/${expenseKey}/attachments`,
    data: {
      name,
      length: Buffer.byteLength(attachment, 'base64'),
      mimeType: mime.lookup(name),
      data: attachment
    },
    headers: { Authorization: `Bearer ${accessToken}` }
  }
  if (detailId) options.params = { detailId };

  console.info('Sending attachment');
  let resp = await axios(options);

  if (!resp.data?.key) throw new Error(`Failed to attach items to Unanet expense ${expenseKey} (and detail ${detailId})`);
  console.info('Success attaching, returning');
  return resp.data.key;
}

/**
 * Extracts an expense (and all its details by proxy)
 * 
 * @param expenseKey key of expense in Unanet
 * @param date (optional) date of extract (ie, reimbursedDate). Defaults to today if not supplied.
 */
async function extractUnanetExpense(expenseKey, date = null) {

  throw new Error('ERROR: Unanet expenses cannot be extracted except by admin. ' + 
    'The Unanet API account is not set as admin at the time of this code being written. ' +
    'If are confident that extraction should work, then remove this error and continue.');

  console.info('Extracting Unanet expense ' + expenseKey);
  date ??= dateUtils.getTodaysDate('YYYY-MM-DD');
  let options = {
    method: 'POST',
    url: BASE_URL + `/rest/expenses/${expenseKey}/extract`,
    headers: { Authorization: `Bearer ${accessToken}` }
  };
  if (date) options.data = { postDate: date };

  console.info('Sending extract via API');
  let resp = await axios(options);
  console.info('Success extracting, returning');

  return { status: resp.status, data: resp.data }
}

/**
 * Submits an expense for reimbursement
 * 
 * @param expenseKey key of expense in Unanet
 * @param comment (optiona) comment to add to expense
 */
async function submitUnanetExpense(expenseKey, comment = null) {
  console.info('Submitting Unanet expense ' + expenseKey);
  let data = undefined;
  if (comment) data = { comment };

  let options = {
    method: 'POST',
    url: BASE_URL + `/rest/expenses/${expenseKey}/submit`,
    data,
    headers: { Authorization: `Bearer ${accessToken}` }
  };

  console.info('Submitting to API');
  let resp = await axios(options);
  console.info('Submit success, returning');
  return { status: resp.status, data: resp.data }
}

// |----------------------------------------------------|
// |                                                    |
// |                       HELPERS                      |
// |                                                    |
// |----------------------------------------------------|

/**
 * Converts a file (eg. image) into base64
 * 
 * @param file raw file data
 * @returns base64 string of file
 */
function base64(file) {
  console.info('Converting file to Base64...');
  // read binary data
  var bitmap = fs.readFileSync(file);
  // convert binary data to base64 encoded string
  let buff = new Buffer(bitmap).toString('base64');
  console.info('Done, returninng');
  return buff;
}

/**
 * Returns the not implemented response
 */
function notImplemented() {
  console.info('Returning 501 Not Implemented')
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
  console.info('Serializing error')
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
  console.info('Redacting data')
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
  console.info('Handling error');

  // check if Unanet is down
  let ping = await axios.get(BASE_URL + '/rest/ping');
  if (ping?.status !== 200) {
    console.log('Unanet did not respond to ping, returning 503');
    return {
      status: 503,
      message: 'Unanet API failed to respond.',
      code: 'ERR_UNANET_DOWN',
      body
    };
  };

  // make sure the error function doesn't error
  err ??= new Error('Unknown error occurred.');

  // pull out error from local error structure
  let body = {
    stage: STAGE ?? null,
    url: BASE_URL ?? null,
    api_key: redact(accessToken, 8, 8),
    err: serializeError(err)
  };

  // pull out error messages from Unanet error structure
  if (err.response?.data?.messages) {
    body.messages = err.response.data.messages;
  }

  let error = {
    status: 500,
    message: err.message,
    code: err.code,
    body
  }

  // log for log searching
  console.log('Extracted error, returning');
  console.log(JSON.stringify(error))

  return error;

}

// |----------------------------------------------------|
// |                                                    |
// |                        EXPORT                      |
// |                                                    |
// |----------------------------------------------------|

module.exports = {
  handler
};
