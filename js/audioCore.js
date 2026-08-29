import { createSaturationCurve, createReverbImpulse, createDelay } from './effects.js';

// Owns the AudioContext and the master bus: dry sum -> saturation ->
// limiter -> master gain -> destination, plus shared reverb/delay sends and
// a heavier "grit" send that layers can push through for localized
// distortion/crackle. Tuned for a dark, dread-soaked horror mix rather than
// a clean Juno ambient wash.
export class AudioCore {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = this.ctx;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0; // fades in on start()

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -14;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 10;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    // A touch more drive on the whole bus so the mix sits in a slightly
    // gritty, "tape" place by default; layers can push harder via the grit bus.
    this.saturation = ctx.createWaveShaper();
    this.saturation.curve = createSaturationCurve(0.2);
    this.saturation.oversample = '2x';

    this.busSum = ctx.createGain();
    this.busSum.gain.value = 1;

    this.busSum.connect(this.saturation);
    this.saturation.connect(this.limiter);
    this.limiter.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.masterGain.connect(this.analyser);

    // Reverb send/return — a darker, longer "cellar/cathedral" tail.
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = createReverbImpulse(ctx, 6.0, 3.1);
    this.reverbDark = ctx.createBiquadFilter();
    this.reverbDark.type = 'lowpass';
    this.reverbDark.frequency.value = 2400;
    this.reverbDark.Q.value = 0.3;
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.62;
    this.reverbSend.connect(this.convolver);
    this.convolver.connect(this.reverbDark);
    this.reverbDark.connect(this.reverbReturn);
    this.reverbReturn.connect(this.busSum);

    // Delay send/return — longer, darker, more cavernous repeats.
    const del = createDelay(ctx, { time: 0.58, feedback: 0.44, cutoff: 1500 });
    this.delayNode = del;
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 0.6;
    this.delaySend.connect(del.input);
    del.output.connect(this.busSum);

    // Grit bus — a hard waveshaper side-path for localized distortion/crackle.
    // Layers route a share of their output through it for an aggressive edge
    // without driving the whole master bus into the limiter.
    this.gritSend = ctx.createGain();
    this.gritSend.gain.value = 1;
    this.gritShaper = ctx.createWaveShaper();
    this.gritShaper.curve = createSaturationCurve(0.7);
    this.gritShaper.oversample = '2x';
    this.gritSend.connect(this.gritShaper);
    this.gritShaper.connect(this.busSum);
  }

  // Routes a layer's output node into the dry bus plus optional reverb/delay sends.
  connectLayerOutput(node, { reverbAmount = 0.3, delayAmount = 0.0 } = {}) {
    node.connect(this.busSum);
    if (reverbAmount > 0) {
      const g = this.ctx.createGain();
      g.gain.value = reverbAmount;
      node.connect(g);
      g.connect(this.reverbSend);
    }
    if (delayAmount > 0) {
      const g = this.ctx.createGain();
      g.gain.value = delayAmount;
      node.connect(g);
      g.connect(this.delaySend);
    }
  }

  // Routes a share of a node's output through the heavy grit bus.
  connectGrit(node, amount = 0.5) {
    if (amount <= 0) return;
    const g = this.ctx.createGain();
    g.gain.value = amount;
    node.connect(g);
    g.connect(this.gritSend);
  }

  async start() {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
    this.masterGain.gain.linearRampToValueAtTime(0.85, now + 3.5);
  }

  async stop() {
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
    this.masterGain.gain.linearRampToValueAtTime(0.0001, now + 2.5);
    setTimeout(() => {
      if (this.ctx.state === 'running') this.ctx.suspend();
    }, 2700);
  }

  setMasterVolume(v) {
    const now = this.ctx.currentTime;
    this.masterGain.gain.setTargetAtTime(Math.max(0.0001, v * 0.85), now, 0.3);
  }
}
