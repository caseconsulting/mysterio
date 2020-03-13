# mysterio

Using the Key Management Store (KMS) console create a new Customer managed key
1) Create Key
2) Next
3) Alias: 'TSheets'
4) Description: 'Encryption key for secret config value for the TSheets API'
5) Tag key: 'Application' - Tag value: 'mysterio'
6) Next
7) Select key administrators
8) Ensure 'Allow key administrators to delete this key' is checked
9) Next
10) Select key users
11) Next
12) Finish

Using the AWS Systems Manager (SSM) Console create a new parameter
1) Parameter Store
2) Create parameter
3) Name: '/TSheets/accessToken'
4) Description: 'TSheets access token'
5) SecureString
6) KMS Key ID: 'alias/TSheets'
7) Value: <TSheets Access Token>
8) Add Tag - Tag key: 'Application' - Tag value: 'mysterio'
9) Create parameter
