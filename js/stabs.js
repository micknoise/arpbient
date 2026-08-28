import { midiToFreq } from './theory.js';

// Bright single stab hits -- horror-stinger character, not a running
// melodic line. Two detuned saws plus an octave-up square for edge, a
// sharp attack, and a filter that starts wide open and slams shut.
export class StabLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.5, delayAmount = 0.12 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.4;
    this.bus.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.6);
  }

  hit(midi, time, { cutoffBase = 5200, cutoffFloor = 700, q = 5, velocity = 0.32, decay = 0.4 } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = freq;
    osc1.detune.value = -5;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = freq;
    osc2.detune.value = 6;
    const edge = ctx.createOscillator();
    edge.type = 'square';
    edge.frequency.value = freq * 2;

    const mix = ctx.createGain();
    mix.gain.value = 0.4;
    const edgeGain = ctx.createGain();
    edgeGain.gain.value = 0.12;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    osc1.connect(mix);
    osc2.connect(mix);
    edge.connect(edgeGain);
    mix.connect(filter);
    edgeGain.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const attack = 0.002;
    const t0 = time;

    filter.frequency.setValueAtTime(cutoffBase, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(200, cutoffFloor), t0 + attack + decay);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);

    const stopTime = t0 + attack + decay + 0.1;
    [osc1, osc2, edge].forEach((o) => {
      o.start(t0);
      o.stop(stopTime);
    });
  }
}
