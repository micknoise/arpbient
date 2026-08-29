import { midiToFreq } from './theory.js';
import { createChorus } from './effects.js';

// Ambient-techno pad: wide, slow, evolving. Detuned saws + sub through a
// low Q lowpass with a slow shared filter LFO, and a stereo chorus. The
// conductor sustains a chord for 1-2 bars at a time with long attack and
// release, so the harmony breathes and cross-fades.
export class PadLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.8, delayAmount = 0.3 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.chorus = createChorus(ctx, { rateL: 0.06, rateR: 0.08, depth: 0.005, baseDelay: 0.024, wet: 0.6 });
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(this.chorus.input);
    this.chorus.output.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });

    // Shared slow filter LFO so all voices breathe together.
    this.filterLFO = ctx.createOscillator();
    this.filterLFO.type = 'sine';
    this.filterLFO.frequency.value = 0.03;
    this.filterLFODepth = ctx.createGain();
    this.filterLFODepth.gain.value = 500;
    this.filterLFO.connect(this.filterLFODepth);
    this.filterLFO.start();
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 2.0);
  }

  setFilterRate(hz) {
    this.filterLFO.frequency.setTargetAtTime(hz, this.ctx.currentTime, 4);
  }

  setFilterDepth(v) {
    this.filterLFODepth.gain.setTargetAtTime(v, this.ctx.currentTime, 4);
  }

  // attack/hold/release in seconds. Wide, slow.
  sustain(midiNotes, startTime, { attack = 2.5, hold = 3, release = 4, cutoffBase = 900, q = 1.4, velocity = 0.3, detune = 12 } = {}) {
    midiNotes.forEach((midi, i) => {
      this._voice(midi, startTime, {
        cutoffBase: cutoffBase + i * 40,
        q,
        velocity: velocity / Math.sqrt(midiNotes.length),
        attack,
        hold,
        release,
        detune,
      });
    });
  }

  _voice(midi, startTime, { cutoffBase, q, velocity, attack, hold, release, detune }) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = freq;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = freq;
    osc2.detune.value = detune;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = freq / 2;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.4;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;
    filter.frequency.value = cutoffBase;
    this.filterLFODepth.connect(filter.frequency);

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    osc1.connect(filter);
    osc2.connect(filter);
    sub.connect(subGain);
    subGain.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const t0 = startTime;
    const sustainLevel = velocity;
    const stopTime = t0 + attack + hold + release + 0.3;

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(sustainLevel, t0 + attack);
    env.gain.setValueAtTime(sustainLevel, t0 + attack + hold);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);

    [osc1, osc2, sub].forEach((o) => {
      o.start(t0);
      o.stop(stopTime);
    });
  }
}
