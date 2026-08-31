import { midiToFreq } from './theory.js';
import { createChorus } from './effects.js';

// Dub lead: two jobs -- short bright "skank" chord stabs on the offbeats,
// and sparse long melody notes. Both are wired into the shared delay/reverb
// sends HARD at the layer level, so the Echo and Space sliders shape their
// trails; the conductor additionally fires feedback bursts ("echo swells")
// underneath them.
export class LeadLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.5, delayAmount = 0.65 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.chorus = createChorus(ctx, { rateL: 0.14, rateR: 0.19, depth: 0.003, baseDelay: 0.017, wet: 0.5 });
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(this.chorus.input);
    this.chorus.output.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });

    // Shared slow timbral LFO -- the lead filter keeps drifting over
    // seconds so the echoey melody travels through timbres. The
    // conductor's texture drift steers its rate/depth (see setFilterRate).
    this.filterLFO = ctx.createOscillator();
    this.filterLFO.type = 'sine';
    this.filterLFO.frequency.value = 0.06;
    this.filterLFODepth = ctx.createGain();
    this.filterLFODepth.gain.value = 420;
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

  // Skank: short, slightly detuned, chord stab -- the reggae guitar sound,
  // here with a saw+square edge.
  stab(notes, time, { cutoffBase = 2400, q = 1.2, velocity = 0.5, decay = 0.16 } = {}) {
    const ctx = this.ctx;
    for (const midi of notes) {
      const freq = midiToFreq(midi);
      const osc1 = ctx.createOscillator();
      osc1.type = 'sawtooth';
      osc1.frequency.value = freq;
      const osc2 = ctx.createOscillator();
      osc2.type = 'square';
      osc2.frequency.value = freq;
      osc2.detune.value = -7;

      const oscGain = ctx.createGain();
      oscGain.gain.value = 0.3;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cutoffBase;
      filter.Q.value = q;
      this.filterLFODepth.connect(filter.frequency);

      const env = ctx.createGain();
      env.gain.value = 0.0001;

      osc1.connect(oscGain);
      osc2.connect(oscGain);
      oscGain.connect(filter);
      filter.connect(env);
      env.connect(this.bus);

      const attack = 0.004;
      const t0 = time;
      const stopTime = t0 + attack + decay + 0.1;
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(velocity, t0 + attack);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);

      osc1.start(t0);
      osc1.stop(stopTime);
      osc2.start(t0);
      osc2.stop(stopTime);
    }
  }

  // Long singing melody note -- the echoey dub lead. Vibrato comes in late.
  note(midi, time, { cutoffBase = 1600, q = 3, velocity = 0.35, decay = 0.8, vibrato = 0.2 } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const sub = ctx.createOscillator();
    sub.type = 'triangle';
    sub.frequency.value = freq;

    const mix = ctx.createGain();
    mix.gain.value = 0.4;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoffBase;
    filter.Q.value = q;
    this.filterLFODepth.connect(filter.frequency);

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    // Vibrato ramps in ~100ms after the attack.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5.2;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0;
    lfo.connect(lfoDepth);
    lfoDepth.connect(osc.detune);

    osc.connect(mix);
    sub.connect(subGain);
    mix.connect(filter);
    subGain.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const attack = 0.01;
    const t0 = time;
    const sustainLevel = Math.max(0.0005, velocity * 0.5);
    const stopTime = t0 + attack + decay + 0.3;

    lfoDepth.gain.setValueAtTime(0, t0);
    lfoDepth.gain.linearRampToValueAtTime(vibrato * 30, t0 + 0.12);

    // Click-safe ADSR -- every ramp flows into the next, no mid-ramp
    // setValueAtTime snaps.
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.exponentialRampToValueAtTime(sustainLevel, t0 + attack + decay);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay + 0.15);

    lfo.start(t0);
    lfo.stop(stopTime);
    osc.start(t0);
    osc.stop(stopTime);
    sub.start(t0);
    sub.stop(stopTime);
  }

  // Final-chord swell for endings: slow attack, long hold, huge release
  // into the reverb tail.
  sustain(notes, time, { attack = 1.6, hold = 4, release = 4, cutoffBase = 1400, velocity = 0.35 } = {}) {
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
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cutoffBase;
      filter.Q.value = 1.5;
      this.filterLFODepth.connect(filter.frequency);
      const env = ctx.createGain();
      env.gain.value = 0.0001;
      osc.connect(filter);
      osc2.connect(filter);
      filter.connect(env);
      env.connect(this.bus);

      const t0 = time;
      const stopTime = t0 + attack + hold + release + 0.3;
      // Click-safe: the hold is a whisper-sagging swell instead of a flat
      // setValueAtTime hold, so the release ramp starts from a smooth value.
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(velocity, t0 + attack);
      env.gain.exponentialRampToValueAtTime(Math.max(0.0005, velocity * 0.96), t0 + attack + hold);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
      osc.start(t0);
      osc.stop(stopTime);
      osc2.start(t0);
      osc2.stop(stopTime);
    }
  }
}
