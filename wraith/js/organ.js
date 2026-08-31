import { midiToFreq } from './theory.js';
import { createChorus, reclaim } from './effects.js';

// Church-organ swell layer. Built additively from a bright pipe-organ stack —
// a strong fundamental plus the 8' and 4' ranks (2nd and 4th partials) and a
// touch of the top octave — so it reads as a straight, resonant organ rather
// than a soft pad. Each partial is doubled with a small detune for a controlled
// widening and slow beating. Swells are long (seconds of attack/release) and
// carry the tension arc, but the timbre itself stays declarative.
export class OrganLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.5, delayAmount = 0.05 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.chorus = createChorus(ctx, { rateL: 0.07, rateR: 0.1, depth: 0.0018, baseDelay: 0.014, wet: 0.45 });
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.5;
    this.bus.connect(this.chorus.input);
    this.chorus.output.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });

    // Shared slow filter LFO — a subtle brightness drift, kept small so the
    // organ stays "straight" rather than wobbling like a pad.
    this.filterLFO = ctx.createOscillator();
    this.filterLFO.type = 'sine';
    this.filterLFO.frequency.value = 0.04;
    this.filterLFODepth = ctx.createGain();
    this.filterLFODepth.gain.value = 220;
    this.filterLFO.connect(this.filterLFODepth);
    this.filterLFO.start();
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 1.2);
  }

  setFilterRate(hz) {
    this.filterLFO.frequency.setTargetAtTime(hz, this.ctx.currentTime, 2);
  }

  // midiNotes: array of MIDI notes; attack/hold/release in seconds.
  playSwell(midiNotes, startTime, { attack = 3, hold = 3, release = 6, cutoff = 900, q = 2.5, velocity = 0.2, detune = 5 } = {}) {
    midiNotes.forEach((midi, idx) => {
      this._playVoice(midi, startTime, attack, hold, release, cutoff + idx * 40, q, velocity, detune);
    });
  }

  _playVoice(midi, startTime, attack, hold, release, cutoff, q, velocity, detune) {
    const ctx = this.ctx;
    const f = midiToFreq(midi);

    // [amplitude, partial multiple] — bright pipe-organ recipe: strong
    // fundamental, the 8' and 4' ranks (2nd/4th partials), a restrained 3rd,
    // and a faint top octave for the organ's "shimmer."
    const partials = [
      [1.0, 1],
      [0.85, 2],
      [0.32, 3],
      [0.55, 4],
      [0.28, 8],
    ];

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    filter.Q.value = q;
    this.filterLFODepth.connect(filter.frequency);

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    const t0 = startTime;
    const attackEnd = t0 + attack;
    const releaseStart = attackEnd + hold;
    const releaseEnd = releaseStart + release;
    const stopTime = releaseEnd + 0.3;

    const voices = [];
    partials.forEach(([amp, mult]) => {
      [-1, 1].forEach((sign) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f * mult;
        osc.detune.value = sign * detune * 0.5;
        const g = ctx.createGain();
        g.gain.value = amp;
        osc.connect(g);
        g.connect(filter);
        osc.start(t0);
        osc.stop(stopTime);
        voices.push(osc, g);
      });
    });

    filter.connect(env);
    env.connect(this.bus);

    // Click-free swell envelope (mirrors main's pads approach).
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, attackEnd);
    env.gain.setValueAtTime(velocity, releaseStart);
    env.gain.exponentialRampToValueAtTime(0.0001, releaseEnd);
    reclaim(voices[0], ...voices, filter, env, [this.filterLFODepth, filter.frequency]);
  }
}
