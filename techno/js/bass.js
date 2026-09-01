import { midiToFreq } from './theory.js';
import { createSaturationCurve, reclaim } from './effects.js';

// Techno acid bass: a hard-saw voice with a high-Q resonant lowpass that
// opens per hit and snaps shut, a sine sub underneath, and an optional
// drive stage for the classic TB-303 bite. The conductor sequences it as
// a 16th-note acid line; this file is just the voice.
export class BassLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.1, delayAmount = 0.05 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.drive = ctx.createWaveShaper();
    this.drive.curve = createSaturationCurve(0.25);
    this.drive.oversample = '2x';
    this.drive.connect(this.bus);
    this.bus.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });

    // Shared slow timbral LFO -- the acid filter keeps drifting over seconds
    // so the line keeps evolving. The conductor's texture drift steers its
    // rate/depth (see setFilterRate).
    this.filterLFO = ctx.createOscillator();
    this.filterLFO.type = 'sine';
    this.filterLFO.frequency.value = 0.05;
    this.filterLFODepth = ctx.createGain();
    this.filterLFODepth.gain.value = 40;
    this.filterLFO.connect(this.filterLFODepth);
    this.filterLFO.start();
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.6);
  }

  setFilterRate(hz) {
    this.filterLFO.frequency.setTargetAtTime(hz, this.ctx.currentTime, 2);
  }
  // The slow swing is capped so the filter can never be driven below the
  // 40 Hz floor (a resonant lowpass dragged toward 0 Hz is where the clicks
  // came from); the ramp floor in playNote keeps the effective minimum
  // at ~40 Hz.
  setFilterDepth(hz) {
    const depth = Math.max(0, Math.min(50, hz));
    this.filterLFODepth.gain.setTargetAtTime(depth, this.ctx.currentTime, 2);
  }

  setDrive(amount) {
    this.drive.curve = createSaturationCurve(amount);
  }

  playNote(midi, startTime, {
    cutoffBase = 900,
    cutoffFloor = 120,
    q = 6,
    velocity = 0.8,
    decay = 0.16,
    subLevel = 0.4,
    driveLevel = 0.5,
  } = {}) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = freq / 2;

    const oscGain = ctx.createGain();
    oscGain.gain.value = driveLevel;
    const subGain = ctx.createGain();
    subGain.gain.value = subLevel;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;
    this.filterLFODepth.connect(filter.frequency);

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    osc.connect(oscGain);
    oscGain.connect(filter);
    sub.connect(subGain);
    subGain.connect(filter);
    filter.connect(env);
    env.connect(this.drive);

    const attack = 0.004;
    const t0 = startTime;
    const sustainLevel = Math.max(0.0005, velocity * 0.25);
    const holdEnd = t0 + attack + decay;
    const stopTime = holdEnd + 0.15;

    // The acid motion: full-open at the hit, dropping to the floor over
    // the note's decay.
    // Ramp down to the floor (>=140 Hz); with the capped slow LFO (<=50)
    // the effective lowpass never falls below ~40 Hz.
    filter.frequency.setValueAtTime(cutoffBase, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(140, cutoffFloor), t0 + attack + decay);

    // Click-safe: attack, smooth decay to sustain, then release -- no
    // mid-ramp setValueAtTime snap.
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + attack);
    env.gain.exponentialRampToValueAtTime(sustainLevel, holdEnd);
    env.gain.exponentialRampToValueAtTime(0.0001, holdEnd + 0.1);

    osc.start(t0);
    osc.stop(stopTime);
    sub.start(t0);
    sub.stop(stopTime);
    reclaim(osc, osc, sub, oscGain, subGain, filter, env, [this.filterLFODepth, filter.frequency]);
  }
}
