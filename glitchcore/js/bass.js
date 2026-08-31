import { midiToFreq } from './theory.js';

// Glitchcore bass: hard, short, punchy hits -- a saw + square stack through
// a tight resonant filter with a fast exponential decay and a sine sub drop.
// The conductor runs syncopated 16th patterns (and glides on the "noodle"
// style), so the voice stays fast-attack and short-tail.
export class BassLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.06, delayAmount = 0.08 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });

    this._lastMidi = null;

    // Shared slow timbral LFO -- the bass filter keeps drifting over
    // seconds so even the hard hits keep evolving. The conductor's texture
    // drift steers its rate/depth (see setFilterRate).
    this.filterLFO = ctx.createOscillator();
    this.filterLFO.type = 'sine';
    this.filterLFO.frequency.value = 0.05;
    this.filterLFODepth = ctx.createGain();
    this.filterLFODepth.gain.value = 220;
    this.filterLFO.connect(this.filterLFODepth);
    this.filterLFO.start();
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.6);
  }

  setFilterRate(hz) {
    this.filterLFO.frequency.setTargetAtTime(hz, this.ctx.currentTime, 2);
  }
  setFilterDepth(hz) {
    this.filterLFODepth.gain.setTargetAtTime(hz, this.ctx.currentTime, 2);
  }

  // Punchy bass hit. `glide` = seconds of portamento from the last note;
  // `bend` = quick pitch dip on the way in.
  playNote(midi, startTime, {
    cutoffBase = 1400,
    cutoffFloor = 90,
    q = 8,
    velocity = 0.9,
    decay = 0.14,
    glide = 0,
    bend = 0,
    subLevel = 0.7,
    detune = 8,
  } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const prevFreq = this._lastMidi != null ? midiToFreq(this._lastMidi) : freq;
    this._lastMidi = midi;

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.detune.value = detune;
    const sub = ctx.createOscillator();
    sub.type = 'sine';

    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.45;
    const subGain = ctx.createGain();
    subGain.gain.value = subLevel;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;
    this.filterLFODepth.connect(filter.frequency);

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    if (glide > 0) {
      osc1.frequency.setValueAtTime(prevFreq, startTime);
      osc1.frequency.exponentialRampToValueAtTime(freq, startTime + glide);
      osc2.frequency.setValueAtTime(prevFreq, startTime);
      osc2.frequency.exponentialRampToValueAtTime(freq, startTime + glide);
    } else {
      osc1.frequency.setValueAtTime(freq, startTime);
      osc2.frequency.setValueAtTime(freq, startTime);
    }
    sub.frequency.setValueAtTime(freq / 2, startTime);

    if (bend > 0) {
      osc1.frequency.setValueAtTime(freq * (1 - bend), startTime + 0.008);
      osc1.frequency.exponentialRampToValueAtTime(freq, startTime + 0.05);
    }

    const attack = 0.003;
    const t0 = startTime;
    const sustainLevel = Math.max(0.0005, velocity * 0.2);
    const stopTime = t0 + attack + decay + 0.1;

    osc1.connect(oscGain);
    osc2.connect(oscGain);
    sub.connect(subGain);
    oscGain.connect(filter);
    subGain.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    filter.frequency.setValueAtTime(cutoffBase, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(55, cutoffFloor), t0 + attack + decay * 0.9);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.exponentialRampToValueAtTime(sustainLevel, t0 + attack + decay);
    env.gain.setValueAtTime(sustainLevel, t0 + attack + decay);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay + 0.08);

    osc1.start(t0);
    osc1.stop(stopTime);
    osc2.start(t0);
    osc2.stop(stopTime);
    sub.start(t0);
    sub.stop(stopTime);
  }

  // Sub drop for the final hit / endings.
  subDrop(midi, time, { attack = 0.01, hold = 0.4, release = 1.2, velocity = 0.9 } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 4, time);
    osc.frequency.exponentialRampToValueAtTime(freq, time + 0.12);
    const env = ctx.createGain();
    env.gain.value = 0.0001;
    osc.connect(env);
    env.connect(this.bus);

    const t0 = time;
    const stopTime = t0 + attack + hold + release + 0.2;
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.setValueAtTime(velocity, t0 + attack + hold);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
    osc.start(t0);
    osc.stop(stopTime);
  }
}
