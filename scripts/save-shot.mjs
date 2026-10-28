// Check autosave across a reload, ?seed= links, and the PNG and JSON downloads.
import puppeteer from 'puppeteer-core';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';

const out = process.argv[2] ?? '.';
const downloads = `${out}/downloads`;
rmSync(downloads, { recursive: true, force: true });
mkdirSync(downloads, { recursive: true });

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
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

const info = () => page.$eval('#info', (e) => e.textContent);
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
await settle(1200);
await page.select('#detail', 'draft');
await page.$eval('#seed', (e) => { e.value = 'saved-seed'; });
await page.click('#regen');
await settle(500);
await page.click('[data-tool="land"]');
await page.$eval('#radius', (e) => { e.value = '0.5'; e.dispatchEvent(new Event('input')); });
await page.mouse.move(600, 400);
await page.mouse.down();
await page.mouse.move(700, 450, { steps: 6 });
await page.mouse.up();
await page.$eval('#tilt', (e) => { e.value = '10'; e.dispatchEvent(new Event('input')); });
await settle(1200); // autosave debounce
console.log('before reload:', await info());

// Reload with no seed in the URL: the autosaved world should come back.
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
await settle(1500);
console.log('after reload :', await info());
console.log('seed box     :', await page.$eval('#seed', (e) => e.value), '| tilt:', await page.$eval('#tilt', (e) => e.value));

// A shared seed link gives a fresh world.
await page.goto('http://localhost:5173/?seed=shared-link&detail=draft', { waitUntil: 'networkidle0' });
await settle(1200);
console.log('seed link    :', await info(), '| seed box:', await page.$eval('#seed', (e) => e.value));

// The link must not have overwritten the saved world: opening the bare URL brings the painted one back.
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
await settle(1500);
console.log('bare url again (should be the painted world):', await info(), '| seed box:', await page.$eval('#seed', (e) => e.value));

await page.select('#projection', 'robinson');
await page.select('#mapWidth', '1024');
await page.click('#exportPng');
await page.click('#saveWorld');
await settle(4000);
const files = readdirSync(downloads);
console.log('downloads    :', files.map((f) => `${f} (${statSync(`${downloads}/${f}`).size} bytes)`));
const png = files.find((f) => f.endsWith('.png'));
if (png) {
  const head = readFileSync(`${downloads}/${png}`).subarray(0, 8);
  console.log('png signature ok:', head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
}
const json = files.find((f) => f.endsWith('.json'));
if (json) {
  const parsed = JSON.parse(readFileSync(`${downloads}/${json}`, 'utf8'));
  console.log('json         :', parsed.format, 'v' + parsed.version, 'seed', parsed.recipe.seed, 'edits', parsed.recipe.edits.length, 'tilt', parsed.planet.tiltDegrees);
}

// Open a world file: a bad one is refused with a message, a good one loads.
await page.$eval('#openFile', (el) => { el.hidden = false; });
const input = await page.$('#openFile');
const bad = `${out}/bad.json`;
(await import('node:fs')).writeFileSync(bad, '{"format":"nope"}');
await input.uploadFile(bad);
await settle(500);
console.log('bad file     :', await info());
if (json) {
  await input.uploadFile(`${downloads}/${json}`);
  await settle(1200);
  console.log('good file    :', await info());
}
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
