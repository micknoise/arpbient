import { midiToFreq } from './theory.js';
import { reclaim } from './effects.js';

// Metallic / glass layer: two distinct voices that produce the "uncomfortable,
// unsettling" high-end of a horror score.
//
//  1. A bell/eerie-melody note — inharmonic partials (not a clean harmonic
//     stack) plus a microtonal beat partner, so it wobbles and rings like a
//     detuned celesta/vibes over a low drone. Sparse and long-lived.
//
//  2. True ring modulation — a modulator oscillator drives a GainNode's gain,
//     so the output is carrier * modulator (zero-center AM). A non-integer
//     ratio yields inharmonic sum/difference partials: the metallic, glassy,
//     "not-quite-tuned" shimmer.
//
// Both ride a heavy reverb/delay so they read as something far away and
// slightly wrong.
export class MetallicLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.7, delayAmount = 0.3 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.4;
    this.bus.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.8);
  }

  // A high glassy bell note with a microtonal beat partner, plus an optional
  // ring-mod shimmer for metallic edge.
  strike(midi, time, { decay = 3, ringAmount = 0.35, beats = 8 } = {}) {
    const f = midiToFreq(midi);
    this._bell(f, time, decay, beats);
    if (ringAmount > 0) this._ring(f, time, 2.7 + Math.random() * 1.8, decay * 0.6, ringAmount, beats);
  }

  // A pure ring-mod metallic glint, not tied to a chord note.
  ringAccent(time, { freq = 660, ratio = 3.14, decay = 1.2, velocity = 0.12, beats = 6 } = {}) {
    this._ring(freq, time, ratio, decay, velocity, beats);
  }

  _bell(f, time, decay, beats) {
    const ctx = this.ctx;

    // Inharmonic bell partials (glassy, deliberately not a clean harmonic row).
    const partials = [
      [1.0, 1.0],
      [0.42, 2.76],
      [0.24, 3.93],
      [0.12, 5.42],
    ];

    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = f * 0.7;
    filter.Q.value = 0.5;

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    const t0 = time;
    const stopTime = t0 + decay + 0.3;

    const voices = [];
    partials.forEach(([amp, mult]) => {
      // Each partial gets a partner a few cents sharp -> slow beating.
      [0, beats].forEach((det) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f * mult;
        osc.detune.value = det;
        const g = ctx.createGain();
        g.gain.value = det === 0 ? amp : amp * 0.35;
        osc.connect(g);
        g.connect(filter);
        osc.start(t0);
        osc.stop(stopTime);
        voices.push(osc, g);
      });
    });

    filter.connect(env);
    env.connect(this.bus);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(0.5, t0 + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    reclaim(voices[0], ...voices, filter, env);
  }

  _ring(f, time, ratio, decay, velocity, beats) {
    const ctx = this.ctx;

    // carrier(s) * modulator, via a gain node driven by the modulator.
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = f;
    const carrier2 = ctx.createOscillator(); // microtonal partner -> beating
    carrier2.type = 'sine';
    carrier2.frequency.value = f;
    carrier2.detune.value = beats;

    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = f * ratio;

    const ring = ctx.createGain();
    ring.gain.value = 0; // zero-center: driven entirely by the modulator
    const modDepth = ctx.createGain();
    modDepth.gain.value = 1.0;
    mod.connect(modDepth);
    modDepth.connect(ring.gain);
    carrier.connect(ring);
    carrier2.connect(ring);

    const level = ctx.createGain(); // ring-mod product is small; scale it up
    level.gain.value = 2.0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = f * (ratio + 1);
    filter.Q.value = 1.1;

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    const t0 = time;
    const stopTime = t0 + decay + 0.3;

    ring.connect(level);
    level.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);

    [carrier, carrier2, mod].forEach((o) => {
      o.start(t0);
      o.stop(stopTime);
    });
    reclaim(carrier, carrier, carrier2, mod, ring, modDepth, level, filter, env);
  }
}
