import { midiToFreq } from './theory.js';
import { createChorus } from './effects.js';

// Juno-style pad layer: detuned saws + sub-square per note, lowpass filter
// with shared slow LFO ("breathing" cutoff movement), stereo chorus on the bus.
export class PadLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.45, delayAmount = 0.05 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.chorus = createChorus(ctx, { rateL: 0.09, rateR: 0.12, depth: 0.004, baseDelay: 0.02, wet: 0.55 });
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.5;
    // Fast on/off chop stage, separate from the slow-moving bus level --
    // lets a rhythmic gate mode ride on top of the normal fades.
    this.gateGain = ctx.createGain();
    this.gateGain.gain.value = 1.0;
    this.bus.connect(this.gateGain);
    this.gateGain.connect(this.chorus.input);
    this.chorus.output.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });

    // Shared filter LFO -- all currently-sounding pad voices breathe together.
    this.filterLFO = ctx.createOscillator();
    this.filterLFO.type = 'sine';
    this.filterLFO.frequency.value = 0.045;
    this.filterLFODepth = ctx.createGain();
    this.filterLFODepth.gain.value = 650;
    this.filterLFO.connect(this.filterLFODepth);
    this.filterLFO.start();
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 1.2);
  }

  setFilterRate(hz) {
    this.filterLFO.frequency.setTargetAtTime(hz, this.ctx.currentTime, 2);
  }

  // Hard on/off chop for the gated pad mode -- a short ramp avoids a click
  // but is fast enough to read as a rhythmic gate rather than a fade.
  setGate(open, time) {
    const target = open ? 1.0 : 0.0001;
    this.gateGain.gain.cancelScheduledValues(time);
    this.gateGain.gain.setValueAtTime(this.gateGain.gain.value, time);
    this.gateGain.gain.linearRampToValueAtTime(target, time + 0.012);
  }

  // holdDuration: plateau time at full volume, after the attack ramp.
  playChord(midiNotes, startTime, holdDuration, fadeTime, { cutoffBase = 900, q = 5, velocity = 0.22 } = {}) {
    midiNotes.forEach((midi, idx) => {
      this._playVoice(midi, startTime, holdDuration, fadeTime, cutoffBase + idx * 80, q + Math.random() * 3, velocity);
    });
  }

  _playVoice(midi, startTime, holdDuration, fadeTime, cutoffBase, q, velocity) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = freq;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = freq;
    osc2.detune.value = 8;
    const sub = ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.value = freq / 2;

    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.55;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.28;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoffBase;
    filter.Q.value = q;
    this.filterLFODepth.connect(filter.frequency);

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    osc1.connect(oscGain);
    osc2.connect(oscGain);
    sub.connect(subGain);
    oscGain.connect(filter);
    subGain.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const t0 = startTime;
    const attackEnd = t0 + fadeTime;
    const releaseStart = t0 + fadeTime + holdDuration;
    const releaseEnd = releaseStart + fadeTime * 1.6;
    const stopTime = releaseEnd + 0.5;

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, attackEnd);
    env.gain.setValueAtTime(velocity, releaseStart);
    env.gain.exponentialRampToValueAtTime(0.0001, releaseEnd);

    [osc1, osc2, sub].forEach((o) => {
      o.start(t0);
      o.stop(stopTime);
    });
  }
}
