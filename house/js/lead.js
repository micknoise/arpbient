import { midiToFreq } from './theory.js';
import { createChorus } from './effects.js';

// House lead layer: lush chorus-processed voices.
//  - 'stab':   detuned-saw chord stabs (the syncopated off-beat chords)
//  - 'phrase': sustained melody notes with slow vibrato (the sparse lead)
//  - 'sustain': wide long chords for endings / breakdowns
export class LeadLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.5, delayAmount = 0.3 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.chorus = createChorus(ctx, { rateL: 0.13, rateR: 0.17, depth: 0.0045, baseDelay: 0.02, wet: 0.6 });
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(this.chorus.input);
    this.chorus.output.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.8);
  }

  // Chord stab.
  stab(midiNotes, time, { cutoffBase = 1600, q = 2, velocity = 0.5, decay = 0.24, detune = 12 } = {}) {
    midiNotes.forEach((midi, i) => {
      this._voice(midi, time, {
        cutoffBase: cutoffBase + i * 50,
        q,
        velocity: velocity / Math.sqrt(midiNotes.length),
        attack: 0.006,
        decay,
        detune,
        sustain: 0.3,
        vibratoRate: 0,
      });
    });
  }

  // Sustained melody note with vibrato.
  phrase(midi, time, { cutoffBase = 2200, q = 1.5, velocity = 0.4, decay = 0.5, detune = 10, vibratoRate = 4.5 } = {}) {
    this._voice(midi, time, {
      cutoffBase,
      q,
      velocity,
      attack: 0.03,
      decay,
      detune,
      sustain: 0.6,
      vibratoRate,
    });
  }

  // Wide long chord.
  sustain(midiNotes, time, { attack = 1.5, hold = 5, release = 4, cutoffBase = 1300, q = 1.2, velocity = 0.4, detune = 14 } = {}) {
    midiNotes.forEach((midi, i) => {
      this._voice(midi, time, {
        cutoffBase: cutoffBase + i * 40,
        q,
        velocity: velocity / Math.sqrt(midiNotes.length),
        attack,
        decay: hold + release,
        detune,
        sustain: 0.85,
        hold,
        vibratoRate: 0,
      });
    });
  }

  _voice(midi, time, { cutoffBase, q, velocity, attack, decay, detune, sustain = 0.3, hold = 0.05, vibratoRate = 0 }) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = freq;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = freq;
    osc2.detune.value = detune;

    // Slow vibrato for the phrase voice.
    let vibrato = null;
    if (vibratoRate > 0) {
      vibrato = ctx.createOscillator();
      vibrato.type = 'sine';
      vibrato.frequency.value = vibratoRate;
      const depth = ctx.createGain();
      depth.gain.value = 4 + Math.random() * 4;
      vibrato.connect(depth);
      depth.connect(osc1.detune);
      depth.connect(osc2.detune);
      vibrato.start(time);
      vibrato.stop(time + attack + hold + decay + 0.2);
    }

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;
    filter.frequency.value = cutoffBase;

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const t0 = time;
    const sustainLevel = Math.max(0.0005, velocity * sustain);
    const stopTime = t0 + attack + hold + decay + 0.2;

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    if (hold > 0.02) env.gain.setValueAtTime(sustainLevel, t0 + attack + hold);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + decay);

    osc1.start(t0);
    osc1.stop(stopTime);
    osc2.start(t0);
    osc2.stop(stopTime);
  }
}
