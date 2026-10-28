// Paint a big continent with a mountain spine, and look at its rivers and lakes (no simulation).
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
await page.goto('http://localhost:5173/?seed=river-test&detail=default', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1500));
const stroke = async (pts) => { await page.mouse.move(...pts[0]); await page.mouse.down(); for (const p of pts.slice(1)) await page.mouse.move(...p, { steps: 6 }); await page.mouse.up(); };
await page.click('[data-tool="land"]');
await page.$eval('#radius', (e) => { e.value = '0.45'; e.dispatchEvent(new Event('input')); });
await stroke([[560, 330], [650, 360], [760, 340], [820, 420], [760, 520], [640, 540], [560, 460]]);
await page.click('[data-tool="raise"]');
await page.$eval('#radius', (e) => { e.value = '0.12'; e.dispatchEvent(new Event('input')); });
for (let pass = 0; pass < 3; pass++) await stroke([[600, 380], [660, 410], [720, 440], [740, 480]]);
await page.click('[data-tool="orbit"]');
await new Promise((r) => setTimeout(r, 6000)); // climate + water in the helper worker
await page.screenshot({ path: `${out}/rivers-elevation.png` });
await page.select('#layer', 'biomes');
await new Promise((r) => setTimeout(r, 800));
await page.click('#winds'); await new Promise((r) => setTimeout(r, 800)); await page.screenshot({ path: `${out}/rivers-winds.png` });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
