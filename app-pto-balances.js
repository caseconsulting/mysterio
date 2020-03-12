const request = require("request");
const rp = require('request-promise');
const _ = require('lodash');

function getTSheetData() {
  return {
   "results": {
    "users": {
     "1705972": {
      "id": 1705972,
      "first_name": "Paul",
      "last_name": "Correll",
      "group_id": 224108,
      "active": true,
      "employee_number": 10008,
      "salaried": true,
      "exempt": true,
      "username": "pcorrell",
      "email": "pcorrell@consultwithcase.com",
      "email_verified": false,
      "payroll_id": "pcorrell",
      "hire_date": "0000-00-00",
      "term_date": "0000-00-00",
      "last_modified": "2020-03-03T15:29:00+00:00",
      "last_active": "2020-03-05T19:07:27+00:00",
      "created": "2014-09-29T08:24:43+00:00",
      "client_url": "caseconsulting",
      "company_name": "Case Consulting",
      "profile_image_url": "https:\/\/www.gravatar.com\/avatar\/ce28e42974014fcfab09c5d9acbd9238",
      "display_name": "",
      "pronouns": "",
      "mobile_number": "",
      "pto_balances": {
       "8690392": 201600,
       "8690424": 86400,
       "8690434": 149088,
       "47183149": 28800,
       "55968713": 14400
      },
      "submitted_to": "2020-03-01",
      "approved_to": "2020-03-01",
      "manager_of_group_ids": [
       220936
      ],
      "require_password_change": false,
      "permissions": {
       "admin": true,
       "mobile": true,
       "status_box": false,
       "reports": false,
       "manage_timesheets": false,
       "manage_authorization": true,
       "manage_users": false,
       "manage_my_timesheets": true,
       "manage_jobcodes": false,
       "pin_login": false,
       "approve_timesheets": false,
       "manage_schedules": false,
       "external_access": false,
       "manage_my_schedule": false,
       "manage_company_schedules": false,
       "view_company_schedules": false,
       "view_group_schedules": false,
       "manage_no_schedules": false,
       "view_my_schedules": false,
       "view_projects": false,
       "manage_projects": false,
       "time_tracking": false
      },
      "customfields": ""
     }
    }
   },
   "more": false,
   "supplemental_data": {
    "groups": {
     "224108": {
      "id": 224108,
      "active": true,
      "name": "Anaconda",
      "last_modified": "2017-12-26T17:31:57+00:00",
      "created": "2017-12-26T17:31:57+00:00",
      "manager_ids": [

      ]
     },
     "220936": {
      "id": 220936,
      "active": true,
      "name": "Interns",
      "last_modified": "2017-05-22T13:09:45+00:00",
      "created": "2017-05-22T13:09:31+00:00",
      "manager_ids": [
       "1705972"
      ]
     }
    },
    "jobcodes": {
     "8690392": {
      "id": 8690392,
      "parent_id": 0,
      "assigned_to_all": true,
      "billable": false,
      "active": true,
      "type": "pto",
      "has_children": false,
      "billable_rate": 0,
      "short_code": "",
      "name": "Holiday",
      "last_modified": "2012-09-13T01:25:42+00:00",
      "created": "2012-09-13T01:25:42+00:00",
      "filtered_customfielditems": "",
      "required_customfields": [

      ],
      "locations": [

      ],
      "geofence_config_id": 0,
      "project_id": 0
     },
     "8690424": {
      "id": 8690424,
      "parent_id": 0,
      "assigned_to_all": true,
      "billable": false,
      "active": true,
      "type": "pto",
      "has_children": false,
      "billable_rate": 0,
      "short_code": "",
      "name": "Training",
      "last_modified": "2012-09-13T01:31:45+00:00",
      "created": "2012-09-13T01:31:45+00:00",
      "filtered_customfielditems": "",
      "required_customfields": [

      ],
      "locations": [

      ],
      "geofence_config_id": 0,
      "project_id": 0
     },
     "8690434": {
      "id": 8690434,
      "parent_id": 0,
      "assigned_to_all": true,
      "billable": false,
      "active": true,
      "type": "pto",
      "has_children": false,
      "billable_rate": 0,
      "short_code": "",
      "name": "PTO",
      "last_modified": "2014-11-07T21:54:57+00:00",
      "created": "2012-09-13T01:36:08+00:00",
      "filtered_customfielditems": "",
      "required_customfields": [

      ],
      "locations": [

      ],
      "geofence_config_id": 0,
      "project_id": 0
     },
     "47183149": {
      "id": 47183149,
      "parent_id": 0,
      "assigned_to_all": true,
      "billable": false,
      "active": true,
      "type": "pto",
      "has_children": false,
      "billable_rate": 0,
      "short_code": "",
      "name": "Case Cares",
      "last_modified": "2018-11-15T20:27:24+00:00",
      "created": "2018-11-15T20:26:22+00:00",
      "filtered_customfielditems": "",
      "required_customfields": [

      ],
      "locations": [

      ],
      "geofence_config_id": 0,
      "project_id": 0
     },
     "55968713": {
      "id": 55968713,
      "parent_id": 0,
      "assigned_to_all": true,
      "billable": false,
      "active": true,
      "type": "pto",
      "has_children": false,
      "billable_rate": 0,
      "short_code": "",
      "name": "Case Connections",
      "last_modified": "2020-01-27T12:52:49+00:00",
      "created": "2020-01-27T12:52:19+00:00",
      "filtered_customfielditems": "",
      "required_customfields": [

      ],
      "locations": [

      ],
      "geofence_config_id": 0,
      "project_id": 0
     }
    }
   }
 };
}

// INCLUDE THE ACCESS TOKEN HERE
var accessToken = '';

//employee numbers to filter tsheets api query on
var employeeNumbers = [10008]; //10020

var options = {
  method: 'GET',
  url: 'https://rest.tsheets.com/api/v1/users',
  qs: {
    employee_numbers: employeeNumbers
  },
  headers: {
    'Authorization': `Bearer ${accessToken}`
  }
};

async function start() {
  // make request to tsheet api
  //let tSheetData = JSON.parse(await rp(options));
  let tSheetData = getTSheetData(); // use this dataset while token is not protected

  // create a map from job code to job name
  let jobCodesMap = _.cloneDeep(tSheetData.supplemental_data.jobcodes);
  _.each(jobCodesMap, jobCode => {jobCodesMap[jobCode.id] = jobCode.name});

  // translate balances code with the code-name map
  _.each(tSheetData.results.users, user => {
    let ptoBalancesCode = user.pto_balances;
    let ptoBalancesName = {};

    _.each(ptoBalancesCode, (value, code) => {
      ptoBalancesName[jobCodesMap[code]] = value;
    });

    tSheetData.results.users[user.id] = {
      pto_balances: ptoBalancesName
    };
  });

  // return the filtered dataset
  return tSheetData;
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
async function lambdaHandler(event, context) {
  return start();
}

module.exports = { lambdaHandler };
