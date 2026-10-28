// Look at the plates themselves at several times, with outlines.
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
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await page.goto('http://localhost:5173/?seed=outlines&detail=default', { waitUntil: 'networkidle0' });
await settle(1500);
await page.click('[data-tool="land"]');
await page.$eval('#radius', (e) => { e.value = '0.5'; e.dispatchEvent(new Event('input')); });
for (const pts of [[[560, 360], [650, 380], [700, 450]], [[790, 330], [830, 400]]]) {
  await page.mouse.move(...pts[0]); await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(...p, { steps: 8 });
  await page.mouse.up(); await settle(300);
}
await page.click('[data-tool="orbit"]');
await page.select('#layer', 'plates');
await page.click('#plateOutlines');
await page.click('#water'); // rivers off for a clean view
await page.click('#simulate');
await page.waitForFunction(() => document.querySelector('#simulate').textContent === 'Simulate', { timeout: 240000 });
for (const [i, label] of [[0, 't0'], [2, 't20'], [5, 't50'], [10, 't100'], [20, 't200']]) {
  await page.$eval('#scrub', (e, v) => { e.value = String(v * 10); e.dispatchEvent(new Event('input')); }, i);
  await settle(500);
  await page.screenshot({ path: `${out}/coh-${label}.png`, clip: { x: 340, y: 90, width: 720, height: 720 } });
}
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
