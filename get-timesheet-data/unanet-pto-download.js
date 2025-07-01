// const test = require("node:test");
// const assert = require("node:assert");
// const puppeteer = require("puppeteer-core");
// const chromiumPath = './chromium';

// async function getPtoCsv() {
//   await test("Check the page title of example.com", async (t) => {
//     console.log('a')
//     const { default: chromium } = await import("@sparticuz/chromium");
//     chromium.setGraphicsMode = false;

//     console.log('b')
//     const viewport = {
//       deviceScaleFactor: 1,
//       hasTouch: false,
//       height: 1080,
//       isLandscape: true,
//       isMobile: false,
//       width: 1920,
//     };

//     console.log('c')
//     console.log('Executable Path:', chromiumPath);
//     const browser = await puppeteer.launch({
//       args: puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
//       defaultViewport: viewport,
//       executablePath: chromiumPath,
//       headless: "shell",
//     });

//     console.log('d')
//     const page = await browser.newPage();
//     console.log('e')
//     await page.goto("https://example.com");
//     console.log('f')
//     const pageTitle = await page.title();
//     console.log('g')
//     await browser.close();

//     console.log('h')
//     assert.strictEqual(pageTitle, "Example Domain");
//   });
// }


// module.exports = {
//   getPtoCsv
// }