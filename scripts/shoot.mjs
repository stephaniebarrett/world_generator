// Drive the dev server in headless Chrome and save screenshots.
// Usage: node scripts/shoot.mjs <outDir>   (dev server must be running on :5173)
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
await new Promise((r) => setTimeout(r, 1500));

const stroke = async (points) => {
  await page.mouse.move(...points[0]);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(...p, { steps: 4 });
  await page.mouse.up();
};

await page.click('[data-tool="land"]');
await stroke([[560, 380], [640, 360], [720, 400], [780, 470], [700, 520], [600, 500], [560, 380]]);
await stroke([[800, 300], [850, 320], [860, 380]]);
await page.click('[data-tool="orbit"]');
await page.screenshot({ path: `${out}/painted.png` });

await page.select('#layer', 'plates');
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: `${out}/plates.png` });

// Orbit around to see the far side.
await page.mouse.move(700, 700);
await page.mouse.down();
await page.mouse.move(1250, 700, { steps: 20 });
await page.mouse.up();
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: `${out}/plates-back.png` });

console.log('info:', await page.$eval('#info', (e) => e.textContent));
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
