// Decisive repro of the stop->restart dropout. core.stop() schedules
// ctx.suspend() via setTimeout(...,2700). Restarting within that window lets
// the delayed suspend fire on the *new* playback and kill it. Timeline:
//   start -> 1.0s -> STOP -> 0.5s -> START -> fine-grained 0.3s sampling.
// If state flips to 'suspended' (or activity drops to 0) during the post-
// restart window, the bug is confirmed.
//
// Usage: node tools/browser-stopstart.mjs <port> <engine>
import { chromium } from 'playwright-core';
const [,, port, engine] = process.argv;
const url = `http://127.0.0.1:${port}/${engine}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.message || e)));
page.on('console', (m) => m.type() === 'error' && errors.push('CONSOLE: ' + m.text()));
await page.addInitScript(() => {
  window.__stats = { osc: 0, src: 0, ac: null };
  const oO = window.AudioContext.prototype.createOscillator;
  window.AudioContext.prototype.createOscillator = function (...a) { window.__stats.osc++; return oO.apply(this, a); };
  const oS = window.AudioContext.prototype.createBufferSource;
  window.AudioContext.prototype.createBufferSource = function (...a) { window.__stats.src++; return oS.apply(this, a); };
  const O = window.AudioContext;
  window.AudioContext = function (...a) { const i = new O(...a); window.__stats.ac = i; return i; };
  window.AudioContext.prototype = O.prototype;
});
await page.goto(url, { waitUntil: 'load' });

const sample = () => page.evaluate(() => ({ t: window.__stats.osc + window.__stats.src, state: window.__stats.ac?.state || 'none' }));
const mark = async () => { const { t } = await sample(); await page.evaluate((x) => { window.__lastTotal = x; }, t); };

await page.click('#playBtn'); // PLAY -> start
await sleep(1000);
await mark();
console.log(`t=+1.0s after start: alive, state=${(await sample()).state}`);

await page.click('#playBtn'); // STOP
console.log('t=+1.5s: STOPPED');
await sleep(500);

await page.click('#playBtn'); // PLAY again (within the 2.7s suspend window)
console.log('t=+2.0s: RE-STARTED (0.5s after stop)');
await mark();

const timeline = [];
let prev = (await sample()).t;
for (let i = 0; i < 14; i++) {
  await sleep(300);
  const s = await sample();
  timeline.push(`  +${(i + 1) * 0.3}s  delta=${s.t - prev}  state=${s.state}`);
  prev = s.t;
}
console.log('\nPost-restart timeline (restart at t=0 of this list):');
console.log(timeline.join('\n'));

if (errors.length) { console.log('\nERRORS:'); [...new Set(errors)].slice(0, 12).forEach((e) => console.log('  ' + e)); }
await browser.close();
