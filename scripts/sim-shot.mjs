// Paint, run the simulation to the end at draft detail, and screenshot the result.
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
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
await page.select('#detail', 'draft');
await page.click('#regen');
await new Promise((r) => setTimeout(r, 800));

const stroke = async (points) => {
  await page.mouse.move(...points[0]);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(...p, { steps: 4 });
  await page.mouse.up();
};
await page.click('[data-tool="land"]');
await page.$eval('#radius', (e) => { e.value = '0.55'; e.dispatchEvent(new Event('input')); });
// Continent-sized masses, roughly a quarter of the globe in total.
await stroke([[520, 330], [600, 350], [680, 330], [640, 420], [560, 430]]);
await stroke([[800, 300], [880, 360], [900, 450], [840, 520]]);
await stroke([[640, 620], [720, 650], [800, 610]]);
await page.click('[data-tool="orbit"]');
await page.screenshot({ path: `${out}/sim-0-painted.png` });

const t0 = Date.now();
await page.click('#simulate');
await page.waitForFunction(() => document.querySelector('#simulate').textContent === 'Simulate', { timeout: 120000 });
console.log(`simulation took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('time readout:', await page.$eval('#timeReadout', (e) => e.textContent));
await page.screenshot({ path: `${out}/sim-1-end.png` });

await page.select('#layer', 'plates');
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: `${out}/sim-2-end-plates.png` });

// Climate layers at the end of the run, then recompute with a different tilt.
for (const layer of ['temperature', 'rainfall', 'biomes']) {
  await page.select('#layer', layer);
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `${out}/sim-4-${layer}.png` });
}
await page.$eval('#tilt', (e) => { e.value = '0'; e.dispatchEvent(new Event('input')); });
await page.click('#recompute');
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: `${out}/sim-5-rainfall-no-tilt.png` });

// Scrub back to the middle.
await page.select('#layer', 'elevation');
await page.$eval('#scrub', (e) => { e.value = '100'; e.dispatchEvent(new Event('input')); });
await new Promise((r) => setTimeout(r, 500));
console.log('mid readout:', await page.$eval('#timeReadout', (e) => e.textContent));
await page.screenshot({ path: `${out}/sim-3-mid.png` });

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
