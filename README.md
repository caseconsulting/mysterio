# mysterio

## Using the Key Management Store (KMS) console create a new Customer managed key

### TSheets

1. Create Key
2. Next
3. Alias: 'TSheets'
4. Description: 'Encryption key for secret config value for the TSheets API'
5. Tag key: 'Application' - Tag value: 'mysterio'
6. Next
7. Select key administrators
8. Ensure 'Allow key administrators to delete this key' is checked
9. Next
10. Select key users
11. Next
12. Finish

### Twitter

1. Create Key
2. Next
3. Alias: 'Twitter'
4. Description: 'Encryption key for secret config value for the Twitter API'
5. Tag key: 'Application' - Tag value: 'mysterio'
6. Next
7. Select key administrators
8. Ensure 'Allow key administrators to delete this key' is checked
9. Next
10. Select key users
11. Next
12. Finish

## Using the AWS Systems Manager (SSM) Console create a new parameter

### TSheets

1. Parameter Store
2. Create parameter
3. Name: '/TSheets/accessToken'
4. Description: 'TSheets access token'
5. SecureString
6. KMS Key ID: 'alias/TSheets'
7. Value: <TSheets Access Token>
8. Add Tag - Tag key: 'Application' - Tag value: 'mysterio'
9. Create parameter

### Twitter

1. Parameter Store
2. Create parameter
3. Name: '/Twitter/accessToken'
4. Description: 'Twitter access token'
5. SecureString
6. KMS Key ID: 'alias/Twitter'
7. Value: <Twitter Access Token>
8. Add Tag - Tag key: 'Application' - Tag value: 'mysterio'
9. Create parameter

## Deploy mysterio SAM application

```bash
npm run deploy:dev
```

## Using the KMS console, provide permissions for the lambda function role to use the CMK

### TSheets

1. TSheets
2. Key users - Add
3. Check mysterio-dev-PTOBalancesFunctionRole
4. Check mysterio-dev-MonthlyHoursFunctionRole
5. Check mysterio-dev-JobcodesFunctionRole
6. Add

### Basecamp

1. Basecamp
2. Key users - Add
3. Check mysterio-dev-BasecampTokenFunctionRole
4. Add

## Documentation

**AWS SAM**

https://docs.aws.amazon.com/serverless-application-model/

**AWS SDK V3:**

https://docs.aws.amazon.com/sdk-for-javascript/

**Axios:**

https://github.com/axios/axios

**Lodash:**

https://lodash.com/

**Day.js:**

https://day.js.org/docs/en/installation/installation

**Cloudformation:**

https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-template-resource-type-ref.html

**ADP API Central and Workforce Now**

https://api-central.adp.com/projects

https://developers.adp.com/build/api-explorer/hcm-offrg-wfn

**Amazon Incentives**

https://www.amazon.com/gc/corp/payments/dashboard

**BambooHR API**

https://documentation.bamboohr.com/docs/getting-started

**QuickBooks Timesheets API**

https://tsheetsteam.github.io/api_docs/#getting-started
