import { midiToFreq } from './theory.js';

// Electronica bass: a "noodle" -- a detuned saw pair through a snappy
// resonant filter, with optional portamento between notes (pitch glides in
// the Squarepusher/Aphex vein). Short decays, lots of movement; the
// conductor holds a phrase for 4-8 bars before re-noodling.
export class BassLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.1, delayAmount = 0.12 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });

    this._lastMidi = null;
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.6);
  }

  // One noodle note. `glide` seconds of portamento from the previous note
  // (0 = straight attack). `bend` adds a quick pitch dip on the way in.
  playNote(midi, startTime, {
    cutoffBase = 1200,
    cutoffFloor = 120,
    q = 6,
    velocity = 0.8,
    decay = 0.2,
    glide = 0,
    bend = 0,
    subLevel = 0.4,
    detune = 10,
  } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const prevFreq = this._lastMidi != null ? midiToFreq(this._lastMidi) : freq;
    this._lastMidi = midi;

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.detune.value = detune;
    const sub = ctx.createOscillator();
    sub.type = 'sine';

    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.5;
    const subGain = ctx.createGain();
    subGain.gain.value = subLevel;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    // Portamento: start on the previous pitch, glide to the target.
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

    // Quick pitch dip for the "noodle" wobble.
    if (bend > 0) {
      osc1.frequency.setValueAtTime(freq * (1 - bend), startTime + 0.01);
      osc1.frequency.exponentialRampToValueAtTime(freq, startTime + 0.06);
    }

    const attack = 0.004;
    const t0 = startTime;
    const sustainLevel = Math.max(0.0005, velocity * 0.25);
    const stopTime = t0 + attack + decay + 0.12;

    osc1.connect(oscGain);
    osc2.connect(oscGain);
    sub.connect(subGain);
    oscGain.connect(filter);
    subGain.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    filter.frequency.setValueAtTime(cutoffBase, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, cutoffFloor), t0 + attack + decay * 0.8);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.exponentialRampToValueAtTime(sustainLevel, t0 + attack + decay);
    env.gain.setValueAtTime(sustainLevel, t0 + attack + decay - 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay + 0.08);

    osc1.start(t0);
    osc1.stop(stopTime);
    osc2.start(t0);
    osc2.stop(stopTime);
    sub.start(t0);
    sub.stop(stopTime);
  }

  // Long low bed for breaks/endings.
  sustain(midi, time, { attack = 0.5, hold = 3, release = 2.5, cutoffBase = 500, velocity = 0.45 } = {}) {
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
