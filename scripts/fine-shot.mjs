// Load a high detail preset, generate land, and look at biomes.
import puppeteer from 'puppeteer-core';
const [out = '.', detail = 'detailed'] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
await page.goto(`http://localhost:5173/?seed=first-world&detail=${detail}`, { waitUntil: 'networkidle0', timeout: 120000 });
await settle(2000);
await page.click('#generate'); await settle(15000);
await page.select('#layer', 'biomes'); await settle(20000);
await page.screenshot({ path: `${out}/fine-biomes.png`, clip: { x: 340, y: 90, width: 720, height: 720 } });
console.log('seconds', (Date.now() - t0) / 1000, await page.$eval('#info', (e) => e.textContent), errors);
await browser.close();
