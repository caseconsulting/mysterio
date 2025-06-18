const { getSecret } = require('./secrets');
const puppeteer = require('puppeteer-core');
const chromium = require('chrome-aws-lambda');
const fs = require('fs');
const path = require('path');

async function getPtoCsv(options) {
    let { suffix } = options;
    const BASE_URL = `https://consultwithcase${suffix}.unanet.biz/consultwithcase${suffix}`;
    const LOGIN_URL = `${BASE_URL}/action/home`;
    const PTO_URL = `${BASE_URL}/action/reports/user/detail/accrual/search`;
    const DOWNLOAD_OPT = 'c_mo'; // dropdown to select for current month PTO info

    let browser = null;
    let csvData = '';
    try {
        // return 'got here';
        // get login secret
        let { username, password } = JSON.parse(await getSecret('/Unanet/login'));
        if (!username || !password) throw new Error('Could not get login info from parameter store.');

        // create browser and open a page to use
        console.log('Chromium executable path:', await chromium.executablePath);
        browser = await puppeteer.launch({
            args: chromium.args,
            executablePath: await chromium.executablePath,
            headless: chromium.headless
        });
        const page = await browser.newPage();

        // Setup download behavior to /tmp
        const downloadPath = '/tmp';
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath
        });

        // Log in
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
        await page.type('#username', login.username);
        await page.type('#password', login.password);
        await page.click('#button_ok');
        await page.waitForNavigation({ waitUntil: 'networkidle2' });

        // Download CSV
        await page.goto(PTO_URL, { waitUntil: 'networkidle2' });
        await page.select('#reportType', DOWNLOAD_OPT);
        await page.click('#download-button');
        await new Promise(res => setTimeout(res, 5000));

        // Load downloaded CSV
        const files = fs.readdirSync(downloadPath).filter(f => f.endsWith('.csv'));
        if (files.length === 0) throw new Error('No CSV downloaded');
        const filePath = path.join(downloadPath, files[0]);
        csvData = fs.readFileSync(filePath, 'utf8');

        // TODO: convert to array/object

        // return
        return csvData;
    } catch (err) {
        console.error(err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message }),
        };
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = {
  getPtoCsv
}