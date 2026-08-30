// Strict stress driver: runs each engine's Conductor through many simulated
// minutes of audio against a mock AudioContext that VALIDATES AudioParam
// scheduling the way a real browser does (exponential ramps to <= 0, non-
// finite values, etc. all throw), and drives the scheduler tick-by-tick.
// The goal is to surface the intermittent exception that stops playback
// (issue #4) with a full stack and the exact step/time it happened at.
//
// Usage: node tools/stress.js [engine ...] [--iters N]
import { pathToFileURL } from 'url';
import { statSync } from 'fs';

let SEED = 12345;
function rand() {
  // deterministic LCG so failures are reproducible
  SEED = (SEED * 1103515245 + 12345) & 0x7fffffff;
  return SEED / 0x7fffffff;
}

function makeParam(initial = 0) {
  let v = initial;
  const p = {
    get value() { return v; },
    // A real browser throws on non-finite .value writes too (the dnb
    // arp-index bug slipped past the *AtTime checks above because it
    // assigned directly to .value).
    set value(x) {
      if (!Number.isFinite(x)) throw new Error(`param.value(non-finite ${x})`);
      v = x;
    },
    _events: [],
    setValueAtTime(v, t) {
      if (!Number.isFinite(v) || !Number.isFinite(t)) throw new Error(`setValueAtTime(non-finite) v=${v} t=${t}`);
      this._events.push(['set', v, t]);
    },
    linearRampToValueAtTime(v, t) {
      if (!Number.isFinite(v) || !Number.isFinite(t)) throw new Error(`linearRamp(non-finite) v=${v} t=${t}`);
      this._events.push(['lin', v, t]);
    },
    exponentialRampToValueAtTime(v, t) {
      if (!Number.isFinite(v) || !Number.isFinite(t)) throw new Error(`expRamp(non-finite) v=${v} t=${t}`);
      if (v === 0) throw new Error(`exponentialRampToValueAtTime(0) at t=${t}`);
      this._events.push(['exp', v, t]);
    },
    setTargetAtTime(v, t, tc) {
      if (!Number.isFinite(v) || tc <= 0) throw new Error(`setTargetAtTime v=${v} t=${t} tc=${tc}`);
      this._events.push(['tgt', v, t, tc]);
    },
    cancelScheduledValues() { this._events = []; },
    connect() {},
  };
  return p;
}

let nodeCount = 0;
function makeNode() {
  nodeCount++;
  const started = [];
  const n = {
    connect() {}, disconnect() {},
    start(t) { if (t != null && !Number.isFinite(t)) throw new Error(`start(non-finite ${t})`); started.push('s'); },
    stop(t) { if (t != null && !Number.isFinite(t)) throw new Error(`stop(non-finite ${t})`); started.push('p'); },
    frequency: makeParam(440), detune: makeParam(0), gain: makeParam(1), pan: makeParam(0),
    delayTime: makeParam(0.1), threshold: makeParam(-10), knee: makeParam(6), ratio: makeParam(12),
    attack: makeParam(0.003), release: makeParam(0.25), Q: makeParam(1),
    type: 'sine', curve: null, buffer: null, loop: false, playbackRate: makeParam(1), oversample: '2x',
  };
  return n;
}

class FakeAudioContext {
  constructor() {
    this.sampleRate = 44100;
    this.currentTime = 0;
    this.state = 'running';
    this.destination = {};
    const mk = () => makeNode();
    this.createGain = mk; this.createOscillator = mk; this.createBufferSource = mk;
    this.createBiquadFilter = mk; this.createWaveShaper = mk; this.createDynamicsCompressor = mk;
    this.createConvolver = mk; this.createStereoPanner = mk; this.createDelay = mk;
    this.createBuffer = (ch, len) => ({ getChannelData: () => new Float32Array(Math.min(len, 88200)) });
    this.createAnalyser = () => ({ fftSize: 2048, frequencyBinCount: 1024, getByteTimeDomainData: (a) => a && a.fill && a.fill(128), connect() {} });
    this.resume = async () => {}; this.suspend = async () => {};
  }
}

globalThis.window = { AudioContext: FakeAudioContext, devicePixelRatio: 1, addEventListener() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
// Deterministic randomness for reproducibility.
Math.random = rand;

const argv = process.argv.slice(2);
const itIdx = argv.indexOf('--iters');
const iters = itIdx >= 0 ? (parseInt(argv[itIdx + 1], 10) || 6) : 6;
const itersVal = itIdx >= 0 ? argv[itIdx + 1] : null;
const argEngines = argv.filter((a) => !a.startsWith('--') && a !== itersVal);
const engines = argEngines.length
  ? argEngines
  : ['techno', 'house', 'ambient-techno', 'electronic-dub', 'electronica', 'glitchcore', 'drum-and-bass']
      .filter((g) => { try { return statSync(g + '/js/conductor.js').isFile(); } catch { return false; } });

const TICK = 0.025;
const STEPS_PER_RUN = Math.round((3 * 60) / TICK); // ~3 simulated minutes

let anyFail = false;
for (const engine of engines) {
  for (let it = 0; it < iters; it++) {
    nodeCount = 0;
    try {
      const coreMod = await import(pathToFileURL(`${engine}/js/audioCore.js`).href);
      const condMod = await import(pathToFileURL(`${engine}/js/conductor.js`).href);
      const core = new coreMod.AudioCore({});
      const conductor = new condMod.Conductor(core);
      conductor.start();

      let steps = 0;
      for (let i = 0; i < STEPS_PER_RUN; i++) {
        core.ctx.currentTime += TICK;
        conductor._scheduler();
        steps++;
        // Periodically exercise live-control paths (the slider handlers).
        if (i % 500 === 0) {
          conductor.setTempo(120);
        }
      }
      // Force the ending + a new movement + then stop/start again.
      conductor.triggerEnding();
      for (let i = 0; i < STEPS_PER_RUN; i++) { core.ctx.currentTime += TICK; conductor._scheduler(); }
      conductor.stop();
      console.log(`  ok   ${engine}  (iter ${it}, ${steps + STEPS_PER_RUN} ticks)`);
    } catch (err) {
      anyFail = true;
      console.error(`  FAIL ${engine}  (iter ${it})`);
      console.error('       ' + (err.stack || err).split('\n').slice(0, 8).join('\n       '));
      break; // stop retrying this engine once it fails
    }
  }
}
process.exit(anyFail ? 1 : 0);
