// Generated land at three sea levels.
import puppeteer from 'puppeteer-core';
const [out = '.', port = '5173'] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await page.goto(`http://localhost:${port}/?seed=first-world&detail=default`, { waitUntil: 'networkidle0' });
await settle(1500);
await page.click('#water');
await page.select('#landStyle', 'continents'); await page.click('#generate'); await settle(2500);
for (const level of [-500, 0, 700]) {
  await page.$eval('#seaLevel', (e, v) => { e.value = String(v); e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); }, level);
  await settle(1500);
  await page.screenshot({ path: `${out}/sea-${level}.png`, clip: { x: 340, y: 90, width: 720, height: 720 } });
  console.log(level, await page.$eval('#seaReadout', (e) => e.textContent));
}
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
