import { midiToFreq, pick } from './theory.js';
import { createChorus, createSaturationCurve } from './effects.js';

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

    // Shared slow filter LFO -- the lead's filter keeps breathing as the
    // conductor's texture drift re-rolls its rate/depth (see setFilterRate),
    // so the top voice travels through timbres instead of sitting still.
    this.filterLFO = ctx.createOscillator();
    this.filterLFO.type = 'sine';
    this.filterLFO.frequency.value = 0.06;
    this.filterLFODepth = ctx.createGain();
    this.filterLFODepth.gain.value = 380;
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
    this.filterLFODepth.connect(filter.frequency);

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

  // Long ringing tone for the sustained moments, with a stranger IDM edge:
  // a wider, random detune, analog saturation, and a resonant bandpass
  // "formant" that sweeps to a random spot over the note (a moving vowel).
  // Still built on the in-key pool note; the shared slow filter LFO keeps it
  // breathing.
  note(midi, time, { cutoffBase = 1800, q = 3, velocity = 0.3, decay = 1.4, vibrato = 0.3 } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = freq;
    osc2.detune.value = pick([-18, -26, 22, 34]);      // wider + random -- weirder
    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.value = freq;
    const air = ctx.createOscillator();
    air.type = 'triangle';
    air.frequency.value = freq;
    air.detune.value = 7;

    const mix = ctx.createGain();       mix.gain.value = 0.4;
    const bodyGain = ctx.createGain();  bodyGain.gain.value = 0.3;
    const airGain = ctx.createGain();   airGain.gain.value = 0.14;

    // Saturation: odd harmonics for a gritty, non-clean edge.
    const shaper = ctx.createWaveShaper();
    shaper.curve = createSaturationCurve(0.7 + Math.random() * 0.6);
    shaper.oversample = '2x';

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;
    this.filterLFODepth.connect(filter.frequency);

    // A resonant bandpass riding in parallel: its center sweeps to a random
    // spot over the note, re-tinting the vowel so each note is strange.
    const formant = ctx.createBiquadFilter();
    formant.type = 'bandpass';
    formant.Q.value = 7 + Math.random() * 9;
    const formantGain = ctx.createGain();
    formantGain.gain.value = 0.2 + Math.random() * 0.22;

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    // Vibrato swells in on the core saws.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 4.4 + Math.random() * 1.8;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0;
    lfo.connect(lfoDepth);
    lfoDepth.connect(osc.detune);
    lfoDepth.connect(osc2.detune);

    // Wiring: core -> shaper (grit) -> lowpass -> env -> bus; body + air feed
    // the lowpass directly and the shaper also drives the moving formant.
    osc.connect(mix);
    osc2.connect(mix);
    mix.connect(shaper);
    shaper.connect(filter);
    body.connect(bodyGain);
    air.connect(airGain);
    bodyGain.connect(filter);
    airGain.connect(filter);
    shaper.connect(formant);
    formant.connect(formantGain);
    formantGain.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const attack = 0.02;
    const t0 = time;
    const sustainLevel = Math.max(0.0005, velocity * 0.55);
    const stopTime = t0 + attack + decay + 0.5;

    // The formant center wanders to a new random spot across the note.
    formant.frequency.setValueAtTime(freq * (2 + Math.random() * 3), t0);
    formant.frequency.exponentialRampToValueAtTime(freq * (3 + Math.random() * 5), t0 + decay);

    // Filter opens from a darker start to the target, then settles a touch
    // lower over the sustain -- the note breathes instead of holding flat.
    filter.frequency.setValueAtTime(Math.max(220, cutoffBase * 0.35), t0);
    filter.frequency.linearRampToValueAtTime(cutoffBase, t0 + 0.12 + Math.random() * 0.1);
    filter.frequency.setTargetAtTime(Math.max(220, cutoffBase * 0.55), t0 + 0.2, 0.6);

    lfoDepth.gain.setValueAtTime(0, t0);
    lfoDepth.gain.linearRampToValueAtTime(vibrato * 30, t0 + 0.3);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.exponentialRampToValueAtTime(sustainLevel, t0 + attack + decay);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay + 0.25);

    lfo.start(t0);
    lfo.stop(stopTime);
    osc.start(t0);
    osc.stop(stopTime);
    osc2.start(t0);
    osc2.stop(stopTime);
    body.start(t0);
    body.stop(stopTime);
    air.start(t0);
    air.stop(stopTime);
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
