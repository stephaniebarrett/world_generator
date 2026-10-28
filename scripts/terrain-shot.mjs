// Generate land with terrain and look at it as elevation, geology and plates.
import puppeteer from 'puppeteer-core';
const out = process.argv[2] ?? '.';
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = { x: 340, y: 90, width: 720, height: 720 };
await page.goto('http://localhost:5173/?seed=terrain-demo&detail=default', { waitUntil: 'networkidle0' });
await settle(1500);
await page.click('#water');
await page.$eval('#exaggeration', (e) => { e.value = '70'; e.dispatchEvent(new Event('input')); });
await page.click('#generate');
await settle(3000);
console.log('info:', await page.$eval('#info', (e) => e.textContent));
await page.screenshot({ path: `${out}/terrain-elevation.png`, clip });
await page.select('#layer', 'geology');
await settle(600);
await page.screenshot({ path: `${out}/terrain-geology.png`, clip });
await page.select('#layer', 'elevation');
await page.click('#plateOutlines');
await settle(500);
await page.screenshot({ path: `${out}/terrain-plates.png`, clip });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
