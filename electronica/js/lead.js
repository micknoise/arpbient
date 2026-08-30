import { midiToFreq, pick } from './theory.js';
import { createChorus } from './effects.js';

// Electronica lead: two jobs -- fast square/saw "plucks" that the
// conductor runs as dense 16th arpeggios (with optional random octave jumps
// and micro-repeats for the glitchy end), and long ringing tones for the
// odd sustained moment. Light chorus keeps the plucks wide without turning
// them into pads.
export class LeadLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.35, delayAmount = 0.3 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.chorus = createChorus(ctx, { rateL: 0.22, rateR: 0.29, depth: 0.0025, baseDelay: 0.014, wet: 0.4 });
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(this.chorus.input);
    this.chorus.output.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.6);
  }

  // Fast pluck. `jump` = extra semitones of random octave jump (glitch);
  // `repeat` = immediate micro-repeat of the note (glitch stutter).
  pluck(midi, time, {
    cutoffBase = 2600,
    cutoffFloor = 300,
    q = 4,
    velocity = 0.4,
    decay = 0.1,
    jump = 0,
    repeat = 0,
  } = {}) {
    const ctx = this.ctx;
    let m = midi;
    if (jump > 0) {
      const r = Math.random();
      if (r < 0.12 + jump * 0.25) m = midi + pick([12, -12, 19, -5]);
    }

    this._onePluck(m, time, { cutoffBase, cutoffFloor, q, velocity, decay });
    if (repeat > 0 && Math.random() < 0.08 + repeat * 0.3) {
      // Micro stutter: the same note twice more, fast, quieter.
      this._onePluck(m, time + 0.028, { cutoffBase, cutoffFloor, q, velocity: velocity * 0.6, decay: decay * 0.7 });
      this._onePluck(m, time + 0.056, { cutoffBase, cutoffFloor, q, velocity: velocity * 0.4, decay: decay * 0.5 });
    }
  }

  _onePluck(midi, time, { cutoffBase, cutoffFloor, q, velocity, decay }) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const osc1 = ctx.createOscillator();
    osc1.type = 'square';
    osc1.frequency.value = freq;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = freq;
    osc2.detune.value = 6;

    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.35;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    osc1.connect(oscGain);
    osc2.connect(oscGain);
    oscGain.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const attack = 0.003;
    const t0 = time;
    const stopTime = t0 + attack + decay + 0.08;

    filter.frequency.setValueAtTime(cutoffBase, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(120, cutoffFloor), t0 + attack + decay);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);

    osc1.start(t0);
    osc1.stop(stopTime);
    osc2.start(t0);
    osc2.stop(stopTime);
  }

  // Long ringing tone for breaks and the final chord.
  note(midi, time, { cutoffBase = 1800, q = 3, velocity = 0.3, decay = 1.2, vibrato = 0.25 } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = freq;
    osc2.detune.value = -9;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoffBase;
    filter.Q.value = q;

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 4.8;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0;
    lfo.connect(lfoDepth);
    lfoDepth.connect(osc.detune);
    lfoDepth.connect(osc2.detune);

    osc.connect(filter);
    osc2.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const attack = 0.02;
    const t0 = time;
    const sustainLevel = Math.max(0.0005, velocity * 0.6);
    const stopTime = t0 + attack + decay + 0.4;

    lfoDepth.gain.setValueAtTime(0, t0);
    lfoDepth.gain.linearRampToValueAtTime(vibrato * 25, t0 + 0.15);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.exponentialRampToValueAtTime(sustainLevel, t0 + attack + decay);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay + 0.2);

    lfo.start(t0);
    lfo.stop(stopTime);
    osc.start(t0);
    osc.stop(stopTime);
    osc2.start(t0);
    osc2.stop(stopTime);
  }

  // Final chord cluster.
  sustain(notes, time, { attack = 1.2, hold = 4, release = 4, cutoffBase = 2000, velocity = 0.3 } = {}) {
    const ctx = this.ctx;
    for (const midi of notes) {
      const freq = midiToFreq(midi);
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      const osc2 = ctx.createOscillator();
      osc2.type = 'sawtooth';
      osc2.frequency.value = freq;
      osc2.detune.value = 8;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cutoffBase;
      filter.Q.value = 2;
      const env = ctx.createGain();
      env.gain.value = 0.0001;
      osc.connect(filter);
      osc2.connect(filter);
      filter.connect(env);
      env.connect(this.bus);

      const t0 = time;
      const stopTime = t0 + attack + hold + release + 0.3;
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(velocity, t0 + attack);
      env.gain.setValueAtTime(velocity, t0 + attack + hold);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
      osc.start(t0);
      osc.stop(stopTime);
      osc2.start(t0);
      osc2.stop(stopTime);
    }
  }
}
