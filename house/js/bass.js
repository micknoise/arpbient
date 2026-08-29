import { midiToFreq } from './theory.js';
import { createChorus } from './effects.js';

// House bass: two gently detuned saws + a sine sub, low Q lowpass, warm
// medium-decay plucks. The conductor sequences syncopated 16th patterns
// (offbeat 8ths, "the-and-a" syncopation, octave pops). This file is the
// voice only.
export class BassLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.08, delayAmount = 0.05 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.chorus = createChorus(ctx, { rateL: 0.11, rateR: 0.14, depth: 0.003, baseDelay: 0.016, wet: 0.4 });
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(this.chorus.input);
    this.chorus.output.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.6);
  }

  // Warm plucked house bass note.
  playNote(midi, startTime, {
    cutoffBase = 900,
    cutoffFloor = 90,
    q = 3,
    velocity = 0.8,
    decay = 0.22,
    subLevel = 0.6,
    detune = 9,
  } = {}) {
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

    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.5;
    const subGain = ctx.createGain();
    subGain.gain.value = subLevel;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    osc1.connect(oscGain);
    osc2.connect(oscGain);
    sub.connect(subGain);
    oscGain.connect(filter);
    subGain.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const attack = 0.005;
    const t0 = startTime;
    const sustainLevel = Math.max(0.0005, velocity * 0.3);
    const holdEnd = t0 + attack + decay;
    const stopTime = holdEnd + 0.12;

    filter.frequency.setValueAtTime(cutoffBase, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(55, cutoffFloor), t0 + attack + decay * 1.1);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.exponentialRampToValueAtTime(sustainLevel, t0 + attack + decay);
    env.gain.setValueAtTime(sustainLevel, holdEnd - 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, holdEnd);

    osc1.start(t0);
    osc1.stop(stopTime);
    osc2.start(t0);
    osc2.stop(stopTime);
    sub.start(t0);
    sub.stop(stopTime);
  }

  // Long sustained root for endings/breakdowns.
  sustain(midi, time, { attack = 0.6, hold = 3, release = 2.5, cutoffBase = 700, velocity = 0.5 } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = freq / 2;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoffBase;
    filter.Q.value = 2;
    const env = ctx.createGain();
    env.gain.value = 0.0001;
    osc.connect(filter);
    sub.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const t0 = time;
    const stopTime = t0 + attack + hold + release + 0.2;
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.setValueAtTime(velocity, t0 + attack + hold);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
    osc.start(t0);
    osc.stop(stopTime);
    sub.start(t0);
    sub.stop(stopTime);
  }
}
