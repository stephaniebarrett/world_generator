// Raise terrain pass by pass and read the height; then rivers and guide lines.
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
const drag = async (pts, steps = 8) => { await page.mouse.move(...pts[0]); await page.mouse.down(); for (const p of pts.slice(1)) await page.mouse.move(...p, { steps }); await page.mouse.up(); await settle(350); };
const readout = async () => { await page.mouse.move(690, 440); await page.mouse.move(692, 442); await settle(400); return page.$eval('#pointerInfo', (e) => e.textContent); };

await page.goto('http://localhost:5173/?seed=feedback&detail=default', { waitUntil: 'networkidle0' });
await settle(1500);
await page.click('[data-tool="land"]');
await page.$eval('#radius', (e) => { e.value = '0.5'; e.dispatchEvent(new Event('input')); });
await drag([[560, 340], [660, 330], [780, 380], [800, 480], [700, 560], [580, 500]]);
await page.click('[data-tool="orbit"]');
await settle(800);
console.log('painted land      :', await readout());

await page.click('[data-tool="raise"]');
await page.$eval('#radius', (e) => { e.value = '0.2'; e.dispatchEvent(new Event('input')); });
const heights = [];
for (let pass = 1; pass <= 12; pass++) {
  await drag([[640, 420], [690, 440], [740, 460]], 5);
  await page.click('[data-tool="orbit"]');
  const text = await readout();
  heights.push(text.match(/: (-?[\d,]+) m/)?.[1] ?? text);
  await page.click('[data-tool="raise"]');
}
console.log('height after each raise pass (m):', heights.join(' -> '));
await page.click('[data-tool="orbit"]');
await settle(7000); // climate and rivers
await page.screenshot({ path: `${out}/fb-1-terrain-rivers.png` });
// Look at the relief edge-on: turn the globe so the continent is at the limb, and exaggerate.
await page.$eval('#exaggeration', (e) => { e.value = '60'; e.dispatchEvent(new Event('input')); });
await page.mouse.move(700, 700); await page.mouse.down(); await page.mouse.move(930, 640, { steps: 12 }); await page.mouse.up();
await settle(800);
await page.screenshot({ path: `${out}/fb-3-relief-limb.png` });
await page.mouse.move(930, 640); await page.mouse.down(); await page.mouse.move(700, 700, { steps: 12 }); await page.mouse.up();
await page.$eval('#exaggeration', (e) => { e.value = '30'; e.dispatchEvent(new Event('input')); });

for (const id of ['#guideAxis', '#guideEquator', '#guideTropics', '#guidePolar']) await page.click(id);
await settle(500);
await page.screenshot({ path: `${out}/fb-2-guides.png` });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
