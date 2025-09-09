# mysterio

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
