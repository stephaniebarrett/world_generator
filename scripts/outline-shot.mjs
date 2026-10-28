// Plate outlines on top of other layers, before and after a simulation.
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
await page.goto('http://localhost:5173/?seed=outlines&detail=draft', { waitUntil: 'networkidle0' });
await settle(1500);
await page.click('[data-tool="land"]');
await page.$eval('#radius', (e) => { e.value = '0.4'; e.dispatchEvent(new Event('input')); });
for (const pts of [[[560, 360], [650, 380], [700, 450]], [[760, 330], [820, 380]]]) {
  await page.mouse.move(...pts[0]); await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(...p, { steps: 8 });
  await page.mouse.up(); await settle(300);
}
await page.click('[data-tool="orbit"]');
await page.click('#plateOutlines');
await settle(500);
await page.screenshot({ path: `${out}/outline-1-elevation.png` });

await page.click('#simulate');
await page.waitForFunction(() => document.querySelector('#simulate').textContent === 'Simulate', { timeout: 120000 });
await page.select('#layer', 'biomes');
await settle(600);
await page.screenshot({ path: `${out}/outline-2-after-sim-biomes.png` });
await page.$eval('#scrub', (e) => { e.value = '40'; e.dispatchEvent(new Event('input')); });
await settle(500);
await page.screenshot({ path: `${out}/outline-3-scrubbed-to-80.png` });
await page.click('#plateOutlines'); // off again
await settle(300);
await page.screenshot({ path: `${out}/outline-4-off.png` });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
