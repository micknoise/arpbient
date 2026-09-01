import { midiToFreq } from './theory.js';
import { reclaim } from './effects.js';

// Techno lead layer with three characters sharing one bus:
//  - 'pluck': short resonant arpeggio hits (the 16th-note sequenced line)
//  - 'stab':  detuned-saw chord stabs, the syncopated off-beat chords
//  - 'sustain': long wide chords for endings / movement heads
export class LeadLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.4, delayAmount = 0.35 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });

    // Shared slow filter LFO -- the lead's filter keeps breathing as the
    // conductor's texture drift re-rolls its rate/depth (see setFilterRate),
    // so the top voice travels through timbres instead of sitting still.
    this.filterLFO = ctx.createOscillator();
    this.filterLFO.type = 'sine';
    this.filterLFO.frequency.value = 0.06;
    this.filterLFODepth = ctx.createGain();
    this.filterLFODepth.gain.value = 360;
    this.filterLFO.connect(this.filterLFODepth);
    this.filterLFO.start();
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.8);
  }

  setFilterRate(hz) {
    this.filterLFO.frequency.setTargetAtTime(hz, this.ctx.currentTime, 2);
  }
  setFilterDepth(hz) {
    this.filterLFODepth.gain.setTargetAtTime(hz, this.ctx.currentTime, 2);
  }

  // Short resonant pluck -- the arpeggio voice.
  pluck(midi, time, { cutoffBase = 2200, q = 6, velocity = 0.5, decay = 0.14, detune = 8 } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = freq;
    osc2.detune.value = detune;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;
    this.filterLFODepth.connect(filter.frequency);

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    osc.connect(filter);
    osc2.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const attack = 0.005;
    filter.frequency.setValueAtTime(cutoffBase * 0.35, time);
    filter.frequency.linearRampToValueAtTime(cutoffBase, time + attack);
    filter.frequency.exponentialRampToValueAtTime(Math.max(250, cutoffBase * 0.2), time + attack + decay);

    env.gain.setValueAtTime(0.0001, time);
    env.gain.linearRampToValueAtTime(velocity, time + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, time + attack + decay);

    const stopTime = time + attack + decay + 0.05;
    osc.start(time);
    osc.stop(stopTime);
    osc2.start(time);
    osc2.stop(stopTime);
    reclaim(osc, osc, osc2, filter, env, [this.filterLFODepth, filter.frequency]);
  }

  // Detuned-saw chord stab.
  stab(midiNotes, time, { cutoffBase = 1800, q = 2.5, velocity = 0.4, decay = 0.22, detune = 10 } = {}) {
    midiNotes.forEach((midi, i) => {
      this._sawVoice(midi, time, {
        cutoffBase: cutoffBase + i * 60,
        q,
        velocity: velocity / Math.sqrt(midiNotes.length),
        attack: 0.006,
        decay,
        detune,
        sustain: 0.25,
      });
    });
  }

  // Long wide chord for the ending and movement heads.
  sustain(midiNotes, time, { attack = 1.2, hold = 4, release = 3, cutoffBase = 1200, q = 1.5, velocity = 0.3, detune = 12 } = {}) {
    midiNotes.forEach((midi, i) => {
      this._sawVoice(midi, time, {
        cutoffBase: cutoffBase + i * 50,
        q,
        velocity: velocity / Math.sqrt(midiNotes.length),
        attack,
        decay: hold + release,
        detune,
        sustain: 0.9,
        hold,
      });
    });
  }

  _sawVoice(midi, time, { cutoffBase, q, velocity, attack, decay, detune, sustain = 0.3, hold = 0.05 }) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = freq;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = freq;
    osc2.detune.value = detune;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;
    filter.frequency.value = cutoffBase;
    this.filterLFODepth.connect(filter.frequency);

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const t0 = time;
    const sustainLevel = Math.max(0.0005, velocity * sustain);
    // Click-safe: attack, a smooth settle to the sustain level (replaces an
    // instant drop that clicked), then a single release ramp to silence.
    const settle = Math.max(0.03, Math.min(0.12, hold * 0.4));
    const stopTime = t0 + attack + hold + decay + 0.1;

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.exponentialRampToValueAtTime(sustainLevel, t0 + attack + settle);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + decay);

    osc1.start(t0);
    osc1.stop(stopTime);
    osc2.start(t0);
    osc2.stop(stopTime);
    reclaim(osc1, osc1, osc2, filter, env, [this.filterLFODepth, filter.frequency]);
  }
}
