import { midiToFreq } from './theory.js';
import { createChorus } from './effects.js';

// Dub bass: a detuned saw pair + sine sub through a resonant lowpass, with a
// fast attack and a LONG tail -- the classic one-drop bass note. The echo
// trail isn't here; it's the shared delay send this layer rides hard (set in
// the conductor), so the "Echo" slider shapes it globally.
export class BassLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.08, delayAmount = 0.5 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.chorus = createChorus(ctx, { rateL: 0.09, rateR: 0.13, depth: 0.0028, baseDelay: 0.015, wet: 0.3 });
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(this.chorus.input);
    this.chorus.output.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.6);
  }

  // Long-decay one-drop bass note. `decay` is the tail length in seconds --
  // the dub groove lives in these tails overlapping the next note.
  playNote(midi, startTime, {
    cutoffBase = 420,
    cutoffFloor = 65,
    q = 2.5,
    velocity = 0.9,
    decay = 1.0,
    subLevel = 0.4,
    detune = 8,
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

    const attack = 0.004;
    const t0 = startTime;
    const sustainLevel = Math.max(0.0005, velocity * 0.12);
    const release = 0.25;
    const end = t0 + attack + decay;
    const stopTime = end + release + 0.15;

    // Filter opens on the hit then sinks -- the note's body is the tail.
    filter.frequency.setValueAtTime(cutoffBase, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(55, cutoffFloor), t0 + attack + decay);

    // Click-safe ADSR -- every ramp flows into the next, no mid-ramp
    // setValueAtTime snaps.
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.exponentialRampToValueAtTime(sustainLevel, t0 + attack + decay);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay + release);

    osc1.start(t0);
    osc1.stop(stopTime);
    osc2.start(t0);
    osc2.stop(stopTime);
    sub.start(t0);
    sub.stop(stopTime);
  }

  // Long sustained root for endings -- a wall of low end underneath the
  // final chord.
  sustain(midi, time, { attack = 0.8, hold = 4, release = 3, cutoffBase = 500, velocity = 0.5 } = {}) {
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
    // Click-safe: the hold is a whisper-sagging swell instead of a flat
    // setValueAtTime hold, so the release ramp starts from a smooth value.
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0005, velocity * 0.96), t0 + attack + hold);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
    osc.start(t0);
    osc.stop(stopTime);
    sub.start(t0);
    sub.stop(stopTime);
  }
}
