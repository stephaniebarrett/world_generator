// Paint a continent, then add, remove and drag plates, and simulate the edited world.
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
const drag = async (pts) => { await page.mouse.move(...pts[0]); await page.mouse.down(); for (const p of pts.slice(1)) await page.mouse.move(...p, { steps: 8 }); await page.mouse.up(); await settle(400); };

await page.goto('http://localhost:5173/?seed=plates-demo&detail=draft', { waitUntil: 'networkidle0' });
await settle(1500);
await page.click('[data-tool="land"]');
await page.$eval('#radius', (e) => { e.value = '0.5'; e.dispatchEvent(new Event('input')); });
await drag([[600, 360], [700, 380], [760, 440], [700, 520], [620, 480]]);
await page.click('[data-tool="addPlate"]'); // switches to the Plates layer
await settle(600);
console.log('0 painted      :', await info(), '| layer:', await page.$eval('#layer', (e) => e.value));
await page.screenshot({ path: `${out}/plates-0-before.png` });

// Add a plate: press, then drag to set its direction and speed.
await page.$eval('#radius', (e) => { e.value = '0.25'; e.dispatchEvent(new Event('input')); });
await drag([[880, 300], [930, 360]]);
console.log('1 add plate    :', await info());
await page.screenshot({ path: `${out}/plates-1-added.png` });

// Remove a plate (default: reset its ground to seafloor).
await page.click('[data-tool="removePlate"]');
await page.mouse.click(480, 600);
await settle(500);
console.log('2 remove plate :', await info());
await page.screenshot({ path: `${out}/plates-2-removed.png` });

// Drag the continent's plate to a new place.
await page.click('[data-tool="dragPlate"]');
await drag([[680, 430], [760, 540]]);
console.log('3 drag plate   :', await info());
await page.select('#layer', 'elevation');
await settle(600);
await page.screenshot({ path: `${out}/plates-3-dragged-elevation.png` });

// Undo the last three edits, one by one.
for (let i = 0; i < 3; i++) await page.click('#undo');
await settle(400);
console.log('4 undo x3      :', await info());

// Redo them by hand is too long; instead simulate the edited world: add the plate again and run.
await page.click('[data-tool="addPlate"]');
await page.$eval('#layer', (e) => { e.value = 'elevation'; e.dispatchEvent(new Event('change')); });
await drag([[880, 300], [930, 360]]);
await page.click('#simulate');
await page.waitForFunction(() => document.querySelector('#simulate').textContent === 'Simulate', { timeout: 120000 });
console.log('5 simulated    :', await page.$eval('#timeReadout', (e) => e.textContent));
await page.screenshot({ path: `${out}/plates-4-simulated.png` });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
