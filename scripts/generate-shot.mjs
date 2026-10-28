// Generate land in each style with plate outlines, then try the detail controls and the brush ring.
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
const info = () => page.$eval('#info', (e) => e.textContent);
const clip = { x: 340, y: 90, width: 720, height: 720 };

await page.goto('http://localhost:5173/?seed=gen-demo&detail=default', { waitUntil: 'networkidle0' });
await settle(1500);
await page.click('#plateOutlines');
await page.click('#water'); // rivers off for a clean look at the land
for (const style of ['continents', 'pangaea', 'two', 'archipelago']) {
  await page.click('#undo').catch(() => {});
  await page.select('#landStyle', style);
  await page.click('#generate');
  await settle(1500);
  console.log(style.padEnd(11), '->', await info());
  await page.screenshot({ path: `${out}/gen-${style}.png`, clip });
}

// Simulation detail: replays the same edits at a new detail instead of discarding the world.
const before = await info();
await page.select('#detail', 'draft');
await settle(1500);
console.log('sim detail ->', before, '=>', await info());

// Render detail: draws the same world on a different mesh.
await page.select('#renderDetail', 'default');
await settle(2500);
console.log('render detail ->', await info());
await page.screenshot({ path: `${out}/gen-render-finer.png`, clip });

// The brush ring.
await page.click('[data-tool="land"]');
await page.$eval('#radius', (e) => { e.value = '0.3'; e.dispatchEvent(new Event('input')); });
await page.mouse.move(690, 430); await page.mouse.move(700, 440);
await settle(400);
console.log('size readout:', await page.$eval('#sizeReadout', (e) => e.textContent));
await page.screenshot({ path: `${out}/gen-brush-ring.png`, clip });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
