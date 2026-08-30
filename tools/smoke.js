// Smoke test: instantiates each engine's AudioCore + Conductor against a
// mock AudioContext and drives the scheduler forward in simulated time,
// including forcing an ending and starting the next movement. Catches
// typos, missing methods, and bad API usage without a browser.
//
// Usage: node tools/smoke.js [engineDir ...]
import { pathToFileURL } from 'url';
import { statSync } from 'fs';

function makeParam(value = 0) {
  return {
    value,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
    setTargetAtTime() {},
    cancelScheduledValues() {},
    connect() {},
  };
}

function makeNode() {
  return {
    connect() {},
    disconnect() {},
    start() {},
    stop() {},
    frequency: makeParam(440),
    detune: makeParam(0),
    gain: makeParam(1),
    pan: makeParam(0),
    delayTime: makeParam(0.1),
    threshold: makeParam(-10),
    knee: makeParam(6),
    ratio: makeParam(12),
    attack: makeParam(0.003),
    release: makeParam(0.25),
    Q: makeParam(1),
    type: 'sine',
    curve: null,
    buffer: null,
    loop: false,
    playbackRate: makeParam(1),
    oversample: '2x',
  };
}

class FakeAudioContext {
  constructor() {
    this.sampleRate = 44100;
    this.currentTime = 0;
    this.state = 'running';
    this.destination = {};
    this.createGain = () => makeNode();
    this.createOscillator = () => makeNode();
    this.createBufferSource = () => makeNode();
    this.createBiquadFilter = () => makeNode();
    this.createWaveShaper = () => makeNode();
    this.createDynamicsCompressor = () => makeNode();
    this.createConvolver = () => makeNode();
    this.createStereoPanner = () => makeNode();
    this.createDelay = () => makeNode();
    this.createBuffer = (channels, length) => ({
      getChannelData: () => new Float32Array(length),
    });
    this.createAnalyser = () => ({
      fftSize: 2048,
      frequencyBinCount: 1024,
      getByteTimeDomainData: (a) => a.fill(128),
      connect() {},
    });
    this.resume = async () => {};
    this.suspend = async () => {};
  }
}

globalThis.window = {
  AudioContext: FakeAudioContext,
  devicePixelRatio: 1,
  addEventListener() {},
};

const args = process.argv.slice(2);
const engines = args.length ? args : [
  'techno', 'house', 'ambient-techno', 'electronic-dub',
  'electronica', 'glitchcore', 'drum-and-bass',
].filter((g) => {
  try {
    return statSync(g + '/js/conductor.js').isFile();
  } catch {
    return false;
  }
});

let failed = false;
for (const engine of engines) {
  try {
    const coreMod = await import(pathToFileURL(`${engine}/js/audioCore.js`).href);
    const condMod = await import(pathToFileURL(`${engine}/js/conductor.js`).href);
    const core = new coreMod.AudioCore({});
    const conductor = new condMod.Conductor(core);
    conductor.start();

    // Drive ~10 simulated seconds of audio (well past a bar boundary and
    // several pattern mutations).
    for (let i = 0; i < 400; i++) {
      core.ctx.currentTime += 0.025;
      conductor._scheduler();
    }

    // Force the ending, then push through the quiet phase into the next
    // movement.
    conductor.triggerEnding();
    for (let i = 0; i < 400; i++) {
      core.ctx.currentTime += 0.025;
      conductor._scheduler();
    }
    for (let i = 0; i < 1600; i++) {
      core.ctx.currentTime += 0.025;
      conductor._scheduler();
    }
    conductor.stop();
    console.log(`  ok  ${engine}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL  ${engine}`);
    console.error(err);
  }
}
process.exit(failed ? 1 : 0);
