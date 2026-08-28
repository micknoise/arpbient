import { midiToFreq } from './theory.js';

// Juno/ARP-style arpeggiator layer: short plucked notes with a fast filter
// envelope (open-then-close) layered on top of a shared slow filter LFO.
// Patterns mutate in small increments rather than being replaced wholesale.
export class ArpLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.3, delayAmount = 0.45 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.35;
    this.bus.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });

    this.filterLFO = ctx.createOscillator();
    this.filterLFO.type = 'sine';
    this.filterLFO.frequency.value = 0.09;
    this.filterLFODepth = ctx.createGain();
    this.filterLFODepth.gain.value = 900;
    this.filterLFO.connect(this.filterLFODepth);
    this.filterLFO.start();

    this.pattern = [];
    this.pool = [];
    this.step = 0;
    this.enabled = true;
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 1.0);
  }

  setFilterRate(hz) {
    this.filterLFO.frequency.setTargetAtTime(hz, this.ctx.currentTime, 2);
  }

  setPool(pool) {
    this.pool = pool;
  }

  setPattern(notes) {
    this.pattern = notes;
    this.step = 0;
  }

  // Small, minimal change to the existing pattern: toggle a rest or swap
  // one step for another pool note. Keeps the loop mostly repeating.
  mutate() {
    if (this.pattern.length === 0) return;
    const i = Math.floor(Math.random() * this.pattern.length);
    if (Math.random() < 0.5) {
      this.pattern[i] = this.pattern[i] === null ? this._randomPoolNote() : null;
    } else if (this.pool.length) {
      this.pattern[i] = this._randomPoolNote();
    }
  }

  _randomPoolNote() {
    return this.pool[Math.floor(Math.random() * this.pool.length)];
  }

  // sawLevel/sqLevel/detune let the caller drift the ensemble's balance
  // and width over time so the arp travels through different textures
  // rather than always sitting at the same mix.
  triggerStep(time, cutoffBase = 1400, q = 3, sawLevel = 0.5, sqLevel = 0.35, detune = -6) {
    if (!this.enabled || this.pattern.length === 0) return;
    const midi = this.pattern[this.step % this.pattern.length];
    this.step++;
    if (midi == null) return;
    this._pluck(midi, time, cutoffBase, q, sawLevel, sqLevel, detune);
  }

  // Direct one-off note, bypassing the pattern/step grid -- used for the
  // ending flourish, which fires an explicit sequence of specific notes.
  hit(midi, time, cutoffBase = 1400, q = 3, sawLevel = 0.5, sqLevel = 0.35, detune = -6) {
    this._pluck(midi, time, cutoffBase, q, sawLevel, sqLevel, detune);
  }

  _pluck(midi, time, cutoffBase, q, sawLevel = 0.5, sqLevel = 0.35, detune = -6) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = freq;
    osc2.detune.value = detune;

    const sawGain = ctx.createGain();
    sawGain.gain.value = sawLevel;
    const sqGain = ctx.createGain();
    sqGain.gain.value = sqLevel;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;
    this.filterLFODepth.connect(filter.frequency);

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    osc.connect(sawGain);
    osc2.connect(sqGain);
    sawGain.connect(filter);
    sqGain.connect(filter);
    filter.connect(env);
    env.connect(this.bus);

    const attack = 0.008;
    const decay = 0.28;
    const hold = 0.02;
    const peak = 0.5;

    filter.frequency.setValueAtTime(cutoffBase * 0.4, time);
    filter.frequency.linearRampToValueAtTime(cutoffBase, time + attack);
    filter.frequency.exponentialRampToValueAtTime(Math.max(200, cutoffBase * 0.3), time + attack + decay);

    env.gain.setValueAtTime(0.0001, time);
    env.gain.linearRampToValueAtTime(peak, time + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, time + attack + decay + hold);

    const stopTime = time + attack + decay + hold + 0.05;
    osc.start(time);
    osc.stop(stopTime);
    osc2.start(time);
    osc2.stop(stopTime);
  }
}
