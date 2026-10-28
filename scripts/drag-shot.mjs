// Paint a continent and drag its plate: before and after, elevation only.
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
const drag = async (pts) => { await page.mouse.move(...pts[0]); await page.mouse.down(); for (const p of pts.slice(1)) await page.mouse.move(...p, { steps: 10 }); await page.mouse.up(); await settle(500); };
await page.goto('http://localhost:5173/?seed=drag-demo&detail=default', { waitUntil: 'networkidle0' });
await settle(1500);
await page.$eval('#layer', (e) => { e.value = 'elevation'; });
await page.$eval('#water', (e) => { e.checked = false; e.dispatchEvent(new Event('change')); });
await page.click('[data-tool="land"]');
await page.$eval('#radius', (e) => { e.value = '0.4'; e.dispatchEvent(new Event('input')); });
await drag([[580, 380], [650, 400], [700, 450], [650, 500], [590, 460]]);
await page.click('[data-tool="orbit"]');
await page.screenshot({ path: `${out}/drag-0-before.png` });
await page.click('[data-tool="dragPlate"]');
await drag([[640, 440], [790, 500]]);
await page.$eval('#layer', (e) => { e.value = 'elevation'; e.dispatchEvent(new Event('change')); });
await settle(500);
await page.screenshot({ path: `${out}/drag-1-after.png` });
console.log('info:', await page.$eval('#info', (e) => e.textContent), '| errors:', errors.length ? errors : 'none');
await browser.close();
