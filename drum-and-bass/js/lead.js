import { midiToFreq } from './theory.js';
import { createChorus } from './effects.js';

// DnB lead: the liquid melodic top -- bright plucks (a "piano" timbre:
// sine + triangle + a touch of saw through a chorus) for syncopated
// arpeggios, plus long singing sustained notes for the emotional moments.
export class LeadLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.4, delayAmount = 0.3 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.chorus = createChorus(ctx, { rateL: 0.18, rateR: 0.23, depth: 0.003, baseDelay: 0.018, wet: 0.55 });
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

  // The conductor's texture drift steers the shared LFO so the filter
  // keeps gliding for the whole movement.
  setFilterRate(hz) {
    this.filterLFO.frequency.setTargetAtTime(hz, this.ctx.currentTime, 2);
  }
  setFilterDepth(hz) {
    this.filterLFODepth.gain.setTargetAtTime(hz, this.ctx.currentTime, 2);
  }

  // Bright pluck (piano-ish).
  pluck(midi, time, { cutoffBase = 2800, q = 2, velocity = 0.4, decay = 0.22, detune = 6 } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.value = freq;
    const osc2 = ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.value = freq;
    osc2.detune.value = detune;
    const osc3 = ctx.createOscillator();
    osc3.type = 'sawtooth';
    osc3.frequency.value = freq;

    const g1 = ctx.createGain();
    g1.gain.value = 0.6;
    const g2 = ctx.createGain();
    g2.gain.value = 0.4;
    const g3 = ctx.createGain();
    g3.gain.value = 0.12;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoffBase;
    filter.Q.value = q;
    this.filterLFODepth.connect(filter.frequency);

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    osc1.connect(g1);
    osc2.connect(g2);
    osc3.connect(g3);
    g1.connect(filter);
    g2.connect(filter);
    g3.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const attack = 0.003;
    const t0 = time;
    const stopTime = t0 + attack + decay + 0.12;
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);

    osc1.start(t0);
    osc1.stop(stopTime);
    osc2.start(t0);
    osc2.stop(stopTime);
    osc3.start(t0);
    osc3.stop(stopTime);
  }

  // Long singing sustained note -- the liquid moment. Rich, in-key, and
  // alive: detuned saws with a sine body and a soft triangle a 12th up for
  // air, a filter that opens from a darker start then settles (so the
  // timbre keeps moving rather than holding flat), and vibrato that swells
  // in. The shared slow filter LFO (setFilterRate) keeps it breathing too.
  note(midi, time, { cutoffBase = 2200, q = 3, velocity = 0.32, decay = 1.6, vibrato = 0.28 } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = freq;
    osc2.detune.value = -11;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = freq;
    const air = ctx.createOscillator();
    air.type = 'triangle';
    air.frequency.value = freq;
    air.detune.value = 7;

    const mix = ctx.createGain();
    mix.gain.value = 0.28;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;
    const airGain = ctx.createGain();
    airGain.gain.value = 0.15;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;
    this.filterLFODepth.connect(filter.frequency);

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 4.6 + Math.random() * 1.4;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0;
    lfo.connect(lfoDepth);
    lfoDepth.connect(osc.detune);
    lfoDepth.connect(osc2.detune);

    osc.connect(mix);
    osc2.connect(mix);
    sub.connect(subGain);
    air.connect(airGain);
    airGain.connect(filter);
    mix.connect(filter);
    subGain.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const attack = 0.02;
    const t0 = time;
    const sustainLevel = Math.max(0.0005, velocity * 0.6);
    const stopTime = t0 + attack + decay + 0.5;

    // Filter opens from a darker start to the target, then settles a touch
    // lower over the sustain -- the note breathes instead of holding flat.
    filter.frequency.setValueAtTime(cutoffBase * 0.4, t0);
    filter.frequency.linearRampToValueAtTime(cutoffBase, t0 + 0.12 + Math.random() * 0.1);
    filter.frequency.setTargetAtTime(Math.max(240, cutoffBase * 0.6), t0 + 0.2, 0.6);

    lfoDepth.gain.setValueAtTime(0, t0);
    lfoDepth.gain.linearRampToValueAtTime(vibrato * 28, t0 + 0.3);

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
    sub.start(t0);
    sub.stop(stopTime);
    air.start(t0);
    air.stop(stopTime);
  }

  // Final chord swell.
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
      osc2.detune.value = 9;
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = freq;
      const subGain = ctx.createGain();
      subGain.gain.value = 0.4;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cutoffBase;
      filter.Q.value = 2;
      const env = ctx.createGain();
      env.gain.value = 0.0001;
      osc.connect(filter);
      osc2.connect(filter);
      sub.connect(subGain);
      subGain.connect(filter);
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
      sub.start(t0);
      sub.stop(stopTime);
    }
  }
}
