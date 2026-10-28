// Generate on a given seed, simulate, and look at elevation (with plate outlines) and plates at several times.
import puppeteer from 'puppeteer-core';
const [out = '.', port = '5173', seed = 'first-world', style = 'continents'] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1400,900'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = { x: 340, y: 90, width: 720, height: 720 };
await page.goto(`http://localhost:${port}/?seed=${seed}&detail=default`, { waitUntil: 'networkidle0' });
await settle(1500);
await page.click('#water');
await page.select('#landStyle', style); await page.click('#generate'); await settle(2500);
await page.click('#plateOutlines');
await page.screenshot({ path: `${out}/fw-t0.png`, clip });
await page.click('#simulate');
await page.waitForFunction(() => document.querySelector('#simulate').textContent === 'Simulate', { timeout: 400000 });
for (const [i, label] of [[5, 't50'], [20, 't200']]) {
  await page.$eval('#scrub', (e, v) => { e.value = String(v * 10); e.dispatchEvent(new Event('input')); }, i);
  await settle(600);
  await page.screenshot({ path: `${out}/fw-${label}.png`, clip });
  console.log(label, await page.$eval('#info', (e) => e.textContent));
}
await browser.close();
