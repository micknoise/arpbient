// Real-browser probe for the dropout (issue #4). Loads an engine page in
// headless Chrome, hooks AudioContext source creation to detect a dead
// scheduler, captures every console/page error, clicks PLAY, and samples
// state over time. Reports whether the scheduler keeps alive and whether
// the AudioContext stays 'running'.
//
// Usage: node tools/browser-probe.mjs <port> <engine> [seconds]
import { chromium } from 'playwright-core';

const [,, port, engine, secs = '16'] = process.argv;
const seconds = parseInt(secs, 10);
const url = `http://127.0.0.1:${port}/${engine}/`;

const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();

const errors = [];
const warnings = [];
page.on('pageerror', (e) =>
  errors.push('PAGEERROR: ' + (e.message || e) + (e.stack ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : ''))
);
page.on('console', (m) => {
  const t = m.type();
  const txt = m.text();
  if (t === 'error') errors.push('CONSOLE: ' + txt);
  else if (t === 'warning') warnings.push(txt);
});

// Hook source-creation so we can count "is the scheduler still alive?".
await page.addInitScript(() => {
  window.__stats = { osc: 0, src: 0, ac: null };
  const origOsc = window.AudioContext.prototype.createOscillator;
  window.AudioContext.prototype.createOscillator = function (...a) {
    window.__stats.osc++;
    return origOsc.apply(this, a);
  };
  const origSrc = window.AudioContext.prototype.createBufferSource;
  window.AudioContext.prototype.createBufferSource = function (...a) {
    window.__stats.src++;
    return origSrc.apply(this, a);
  };
  const OrigAC = window.AudioContext;
  window.AudioContext = function AC(...a) {
    const inst = new OrigAC(...a);
    window.__stats.ac = inst;
    return inst;
  };
  window.AudioContext.prototype = OrigAC.prototype;
  window.AudioContext.name = 'AudioContext';
});

await page.goto(url, { waitUntil: 'load' });
await page.click('#playBtn');

const t0 = Date.now();
const samples = [];
let lastTotal = 0;
let deadWindows = 0;
let maxDead = 0;

while (Date.now() - t0 < seconds * 1000) {
  await new Promise((r) => setTimeout(r, 1000));
  const s = await page.evaluate(() => {
    const st = window.__stats;
    const total = st.osc + st.src;
    return {
      total,
      delta: total - (window.__lastTotal || 0),
      acState: st.ac ? st.ac.state : 'none',
      acTime: st.ac ? st.ac.currentTime : -1,
      running: window.__running ?? null,
    };
  }).catch(() => ({ total: -1, delta: -1, acState: 'ERR', acTime: -1 }));
  // remember total for next delta
  await page.evaluate((t) => { window.__lastTotal = t; }, s.total);
  samples.push(s);
  if (s.acState === 'running' && s.delta === 0) { deadWindows++; maxDead = Math.max(maxDead, deadWindows); }
  else deadWindows = 0;
}

// Read final status text + button label.
const finalUI = await page.evaluate(() => ({
  status: document.querySelector('#status')?.textContent || '',
  btn: document.querySelector('#playBtn')?.textContent || '',
})).catch(() => ({}));

console.log(`=== ${engine} (${seconds}s) ===`);
console.log(`AudioContext state: ${samples[samples.length - 1].acState}`);
console.log(`Longest run of 'running-but-silent' 1s windows: ${maxDead}s`);
console.log(`Total sources created over run: ${samples[samples.length - 1].total}`);
console.log(`Button label at end: "${finalUI.btn}"`);
console.log(`Status text: "${finalUI.status}"`);
console.log(`\nPer-second (delta = new sources created):`);
samples.forEach((s, i) => console.log(`  t=${i + 1}s  delta=${String(s.delta).padStart(5)}  total=${String(s.total).padStart(6)}  state=${s.acState}  acTime=${s.acTime.toFixed(2)}`));
if (errors.length) {
  console.log(`\n--- ERRORS (${errors.length}) ---`);
  [...new Set(errors)].slice(0, 20).forEach((e) => console.log('  ' + e));
}
if (warnings.length) {
  console.log(`\n--- WARNINGS (${warnings.length}) ---`);
  [...new Set(warnings)].slice(0, 8).forEach((e) => console.log('  ' + e));
}
await browser.close();
