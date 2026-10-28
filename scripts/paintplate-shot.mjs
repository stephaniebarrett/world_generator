// Paint a plate across a boundary and check that the boundary moves.
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
await page.goto('http://localhost:5173/?seed=outlines&detail=draft', { waitUntil: 'networkidle0' });
await settle(1500);
await page.click('[data-tool="paintPlate"]'); // switches to the Plates layer
await page.click('#plateOutlines');
await settle(500);
await page.screenshot({ path: `${out}/pp-0-before.png`, clip: { x: 340, y: 90, width: 720, height: 720 } });
await page.$eval('#radius', (e) => { e.value = '0.14'; e.dispatchEvent(new Event('input')); });
// Start inside the big plate and sweep down across the yellow plate's territory.
await page.mouse.move(600, 380); await page.mouse.down();
for (const p of [[620, 470], [640, 540], [680, 600], [760, 620], [840, 580]]) await page.mouse.move(...p, { steps: 8 });
await page.screenshot({ path: `${out}/pp-1-while-dragging.png`, clip: { x: 340, y: 90, width: 720, height: 720 } });
await page.mouse.up(); await settle(500);
console.log('after:', await page.$eval('#info', (e) => e.textContent));
await page.screenshot({ path: `${out}/pp-2-after.png`, clip: { x: 340, y: 90, width: 720, height: 720 } });
await page.click('#undo'); await settle(400);
console.log('after undo:', await page.$eval('#info', (e) => e.textContent));
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
