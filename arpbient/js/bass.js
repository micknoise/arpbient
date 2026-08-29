import { midiToFreq } from './theory.js';

// Punchy resonant sub-bass (ARP Odyssey acid character): saw + sine sub,
// a fast-opening filter that snaps shut right after each hit. Built as a
// repeatable pulse voice -- the conductor drives it as a recurring
// ostinato, not a sustained drone.
export class BassLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.12, delayAmount = 0 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.0;
    this.bus.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.8);
  }

  // Percussive pluck: the amp envelope is a short punch (attack/decay/hold/
  // release), while the filter separately snaps open then drops down fast
  // -- the "filter dropping down after each punchy note" character.
  playNote(midi, startTime, { cutoffBase = 1200, cutoffFloor = 160, q = 11, velocity = 0.65, holdTime = 0.08 } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = freq / 2;

    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.5;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.8;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    osc.connect(oscGain);
    sub.connect(subGain);
    oscGain.connect(filter);
    subGain.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const attack = 0.004;
    const decay = 0.14;
    const release = 0.22;
    const t0 = startTime;
    const sustainLevel = velocity * 0.35;
    const holdEnd = t0 + attack + decay + holdTime;
    const stopTime = holdEnd + release + 0.05;

    filter.frequency.setValueAtTime(cutoffBase, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, cutoffFloor), t0 + attack + decay * 1.3);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0005, sustainLevel), t0 + attack + decay);
    env.gain.setValueAtTime(sustainLevel, holdEnd);
    env.gain.exponentialRampToValueAtTime(0.0001, holdEnd + release);

    osc.start(t0);
    osc.stop(stopTime);
    sub.start(t0);
    sub.stop(stopTime);
  }
}
