// Generate land, simulate nothing, and look closely at the rivers (climate is computed for the static world).
import puppeteer from 'puppeteer-core';
const [out = '.', seed = 'first-world'] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await page.goto(`http://localhost:5173/?seed=${seed}&detail=default`, { waitUntil: 'networkidle0' });
await settle(1500);
await page.select('#landStyle', 'continents'); await page.click('#generate'); await settle(7000);
await page.mouse.move(700, 450);
for (let i = 0; i < 2; i++) { await page.mouse.wheel({ deltaY: -300 }); await settle(150); }
await settle(1000);
await page.screenshot({ path: `${out}/rivers-zoom.png` });
await browser.close();
