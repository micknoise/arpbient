import { midiToFreq } from './theory.js';
import { reclaim } from './effects.js';

// Ambient-techno bass: a deep, slow sub. Sine sub + a quiet low saw for
// body, very low cutoff, long slow swells. The conductor uses it for
// sustained root swells (downbeat + offbeat) and, at higher density, a
// slow rolling 8th pattern.
export class BassLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.15, delayAmount = 0.05 } = {}) {
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

  // A slow, deep sub swell.
  swell(midi, startTime, { attack = 0.4, hold = 1.5, release = 2.5, cutoffBase = 400, velocity = 0.7 } = {}) {
    this._voice(midi, startTime, { attack, hold, release, cutoffBase, velocity, body: 0.4 });
  }

  // A short rolling 8th pluck (used at higher density).
  pluck(midi, startTime, { cutoffBase = 600, velocity = 0.5, decay = 0.3 } = {}) {
    this._voice(midi, startTime, { attack: 0.01, hold: 0.05, release: decay, cutoffBase, velocity, body: 0.3 });
  }

  _voice(midi, startTime, { attack, hold, release, cutoffBase, velocity, body }) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = freq / 2;
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = freq;
    const sawGain = ctx.createGain();
    sawGain.gain.value = body;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 1.2;
    filter.frequency.value = cutoffBase;

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    sub.connect(filter);
    saw.connect(sawGain);
    sawGain.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const t0 = startTime;
    const stopTime = t0 + attack + hold + release + 0.3;

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.setValueAtTime(velocity, t0 + attack + hold);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);

    [sub, saw].forEach((o) => {
      o.start(t0);
      o.stop(stopTime);
    });
    reclaim(sub, sub, saw, sawGain, filter, env);
  }
}
