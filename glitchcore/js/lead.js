import { midiToFreq, pick } from './theory.js';

// Glitchcore lead: the "stutter" -- a square blip that the conductor
// schedules in rapid micro-repeats and with random octave jumps, plus short
// detuned stab chords and rare long ringing tones. Everything short and
// hard; the chaos is in the scheduling, not long envelopes.
export class LeadLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.3, delayAmount = 0.25 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.6);
  }

  // One hard square blip.
  blip(midi, time, { cutoffBase = 3200, q = 2, velocity = 0.4, decay = 0.07, detune = 0 } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    osc.detune.value = detune;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoffBase;
    filter.Q.value = q;
    const env = ctx.createGain();
    env.gain.value = 0.0001;
    osc.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const attack = 0.002;
    const t0 = time;
    const stopTime = t0 + attack + decay + 0.06;
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    osc.start(t0);
    osc.stop(stopTime);
  }

  // Stutter: the signature glitch -- the same note fired N times at
  // shrinking offsets (scheduled micro-repeats), each quieter.
  stutter(midi, time, { repeats = 3, cutoffBase = 3200, q = 2, velocity = 0.45, decay = 0.07 } = {}) {
    const step = 0.045;
    for (let i = 0; i < repeats; i++) {
      this.blip(midi, time + i * step, {
        cutoffBase,
        q,
        velocity: velocity * Math.pow(0.72, i),
        decay: decay * Math.pow(0.85, i),
        detune: i % 2 ? 12 : -8,
      });
    }
  }

  // Short detuned stab chord.
  stab(notes, time, { cutoffBase = 2800, q = 2.5, velocity = 0.45, decay = 0.12 } = {}) {
    const ctx = this.ctx;
    for (const midi of notes) {
      const freq = midiToFreq(midi);
      const osc1 = ctx.createOscillator();
      osc1.type = 'sawtooth';
      osc1.frequency.value = freq;
      const osc2 = ctx.createOscillator();
      osc2.type = 'square';
      osc2.frequency.value = freq;
      osc2.detune.value = pick([-12, 10]);
      const oscGain = ctx.createGain();
      oscGain.gain.value = 0.3;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cutoffBase;
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
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(velocity, t0 + attack);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
      osc1.start(t0);
      osc1.stop(stopTime);
      osc2.start(t0);
      osc2.stop(stopTime);
    }
  }

  // Rare long ringing tone (the odd breath of melody in the chaos).
  note(midi, time, { cutoffBase = 2200, q = 4, velocity = 0.3, decay = 1.4, vibrato = 0.3 } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = freq;
    osc2.detune.value = -10;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoffBase;
    filter.Q.value = q;
    const env = ctx.createGain();
    env.gain.value = 0.0001;

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5.6;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0;
    lfo.connect(lfoDepth);
    lfoDepth.connect(osc.detune);
    lfoDepth.connect(osc2.detune);

    osc.connect(filter);
    osc2.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const attack = 0.015;
    const t0 = time;
    const sustainLevel = Math.max(0.0005, velocity * 0.55);
    const stopTime = t0 + attack + decay + 0.4;

    lfoDepth.gain.setValueAtTime(0, t0);
    lfoDepth.gain.linearRampToValueAtTime(vibrato * 28, t0 + 0.12);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.exponentialRampToValueAtTime(sustainLevel, t0 + attack + decay);
    env.gain.setValueAtTime(sustainLevel, t0 + attack + decay);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay + 0.2);

    lfo.start(t0);
    lfo.stop(stopTime);
    osc.start(t0);
    osc.stop(stopTime);
    osc2.start(t0);
    osc2.stop(stopTime);
  }

  // Final chord cluster.
  sustain(notes, time, { attack = 0.8, hold = 4, release = 3.5, cutoffBase = 2600, velocity = 0.28 } = {}) {
    const ctx = this.ctx;
    for (const midi of notes) {
      const freq = midiToFreq(midi);
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      const osc2 = ctx.createOscillator();
      osc2.type = 'sawtooth';
      osc2.frequency.value = freq;
      osc2.detune.value = 10;
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
