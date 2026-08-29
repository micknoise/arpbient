import { midiToFreq } from './theory.js';

// Ambient-techno lead: sparse, long notes with big reverb/delay tails.
// A single detuned-saw + sine blend through a gentle lowpass; the
// spaciousness comes from the long decay and the master reverb/delay.
export class LeadLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.9, delayAmount = 0.6 } = {}) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 1.5);
  }

  // A long, singing note.
  note(midi, time, { cutoffBase = 1800, q = 1.6, velocity = 0.35, decay = 1.6, detune = 9, vibratoRate = 3.5 } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const sine = ctx.createOscillator();
    sine.type = 'sine';
    sine.frequency.value = freq;
    const sineGain = ctx.createGain();
    sineGain.gain.value = 0.4;

    const vibrato = ctx.createOscillator();
    vibrato.type = 'sine';
    vibrato.frequency.value = vibratoRate;
    const depth = ctx.createGain();
    depth.gain.value = 5 + Math.random() * 4;
    vibrato.connect(depth);
    depth.connect(osc.detune);
    depth.connect(sine.detune);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;
    filter.frequency.value = cutoffBase;

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    osc.connect(filter);
    sine.connect(sineGain);
    sineGain.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const t0 = time;
    const stopTime = t0 + 0.05 + decay + 0.3;

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + 0.04);
    env.gain.setValueAtTime(velocity, t0 + 0.2);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2 + decay);

    [osc, sine, vibrato].forEach((o) => {
      o.start(t0);
      o.stop(stopTime);
    });
  }

  // A short, quiet "tick" pluck for the sequenced texture.
  tick(midi, time, { cutoffBase = 2600, velocity = 0.22, decay = 0.4 } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoffBase;
    filter.Q.value = 2;
    const env = ctx.createGain();
    env.gain.value = 0.0001;
    osc.connect(filter);
    filter.connect(env);
    env.connect(this.bus);
    env.gain.setValueAtTime(0.0001, time);
    env.gain.linearRampToValueAtTime(velocity, time + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, time + 0.01 + decay);
    const stopTime = time + decay + 0.2;
    osc.start(time);
    osc.stop(stopTime);
  }
}
