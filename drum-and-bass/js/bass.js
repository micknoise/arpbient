import { midiToFreq } from './theory.js';
import { createChorus } from './effects.js';

// DnB bass: the Reese -- two heavily detuned saws through a resonant
// filter whose cutoff is amplitude-modulated (the "wobble"), plus a sine
// sub for weight. Long-decay syncopated notes; the conductor runs rolling
// 16th patterns and holds a phrase for 4-8 bars.
export class BassLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.1, delayAmount = 0.08 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.chorus = createChorus(ctx, { rateL: 0.1, rateR: 0.14, depth: 0.003, baseDelay: 0.016, wet: 0.35 });
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(this.chorus.input);
    this.chorus.output.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });

    // AM amount 0..1 (the "Reese" slider).
    this.reese = 0.5;
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.6);
  }

  setReese(v) {
    this.reese = Math.max(0, Math.min(1, v));
  }

  // Rolling Reese bass note. `wobble` = AM depth (0..1, defaults to the
  // layer's Reese setting), `wobbleRate` = AM frequency. `glide` =
  // portamento from the last note.
  playNote(midi, startTime, {
    cutoffBase = 900,
    cutoffFloor = 70,
    q = 7,
    velocity = 0.85,
    decay = 0.3,
    wobble = -1,
    wobbleRate = 5.5,
    glide = 0,
    subLevel = 0.8,
    detune = 22,
  } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const prevFreq = this._lastMidi != null ? midiToFreq(this._lastMidi) : freq;
    this._lastMidi = midi;
    if (wobble < 0) wobble = this.reese;

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.detune.value = detune;
    const sub = ctx.createOscillator();
    sub.type = 'sine';

    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.4;
    const subGain = ctx.createGain();
    subGain.gain.value = subLevel;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;

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

    const attack = 0.005;
    const t0 = startTime;
    const sustainLevel = Math.max(0.0005, velocity * 0.35);
    const stopTime = t0 + attack + decay + 0.25;

    // The wobble: an LFO on the filter cutoff (AM), depth from `wobble`.
    if (wobble > 0.01) {
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = wobbleRate;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = (cutoffBase - cutoffFloor) * 0.5 * wobble;
      lfo.connect(lfoDepth);
      lfoDepth.connect(filter.frequency);
      lfo.start(t0);
      lfo.stop(stopTime);
    }

    osc1.connect(oscGain);
    osc2.connect(oscGain);
    sub.connect(subGain);
    oscGain.connect(filter);
    subGain.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    filter.frequency.setValueAtTime(cutoffBase, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(55, cutoffFloor), t0 + attack + decay);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.exponentialRampToValueAtTime(sustainLevel, t0 + attack + decay * 0.6);
    env.gain.setValueAtTime(sustainLevel, t0 + attack + decay);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay + 0.06);

    osc1.start(t0);
    osc1.stop(stopTime);
    osc2.start(t0);
    osc2.stop(stopTime);
    sub.start(t0);
    sub.stop(stopTime);
  }

  // Deep sub drop for endings.
  subDrop(midi, time, { attack = 0.01, hold = 0.5, release = 1.4, velocity = 0.9 } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 4, time);
    osc.frequency.exponentialRampToValueAtTime(freq, time + 0.15);
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
