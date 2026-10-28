// Plates and generated land together, from two sides, with plate outlines.
import puppeteer from 'puppeteer-core';
const [out = '.', port = '5173'] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await page.goto(`http://localhost:${port}/?seed=layout-demo&detail=default`, { waitUntil: 'networkidle0' });
await settle(1500);
await page.click('#water');
await page.select('#landStyle', 'continents'); await page.click('#generate'); await settle(2500);
await page.select('#layer', 'plates'); await settle(500);
await page.screenshot({ path: `${out}/layout-plates.png`, clip: { x: 340, y: 90, width: 720, height: 720 } });
await page.select('#layer', 'elevation'); await page.click('#plateOutlines'); await settle(500);
await page.screenshot({ path: `${out}/layout-land.png`, clip: { x: 340, y: 90, width: 720, height: 720 } });
await browser.close();
