import { createSaturationCurve, createReverbImpulse, createDelay } from './effects.js';

// Owns the AudioContext and the master bus. Signal path:
//
//   dry layers  -> duckGain -> busSum -> saturation -> limiter -> master -> out
//   kick/side  -> busSum   (bypasses the duck stage, so the kick never
//                           pumps itself)
//   + reverb and delay send/returns that any layer can tap into.
//
// Genre character (reverb size, delay feedback, drive) comes in via the
// options object, so the file is shared by every engine and only the
// config differs.
export class AudioCore {
  constructor(options = {}) {
    const {
      saturation = 0.18,
      reverb = { duration: 3.5, decay: 3.0, dark: 3800, return: 0.5 },
      delay = { time: 0.42, feedback: 0.4, cutoff: 2200, return: 0.5 },
    } = options;

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = this.ctx;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0; // fades in on start()

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -14;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 10;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    this.saturation = ctx.createWaveShaper();
    this.saturation.curve = createSaturationCurve(saturation);
    this.saturation.oversample = '2x';

    // Duck stage: everything except the kick passes through here, so the
    // conductor can schedule a sidechain-style pump at each kick hit.
    this.duckGain = ctx.createGain();
    this.duckGain.gain.value = 1;
    // Tracks the last commanded duck level (same lookahead reason as the
    // arpbient pad gate: reading .gain.value at schedule time returns the
    // audio thread's *current* value, not the value the next ramp will
    // start from).
    this._duckTarget = 1.0;

    this.busSum = ctx.createGain();
    this.duckGain.connect(this.busSum);
    this.busSum.connect(this.saturation);
    this.saturation.connect(this.limiter);
    this.limiter.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.masterGain.connect(this.analyser);

    // Reverb send/return
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = createReverbImpulse(ctx, reverb.duration, reverb.decay);
    this.reverbDark = ctx.createBiquadFilter();
    this.reverbDark.type = 'lowpass';
    this.reverbDark.frequency.value = reverb.dark;
    this.reverbDark.Q.value = 0.2;
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = reverb.return;
    this.reverbSend.connect(this.convolver);
    this.convolver.connect(this.reverbDark);
    this.reverbDark.connect(this.reverbReturn);
    this.reverbReturn.connect(this.busSum);

    // Delay send/return
    this.delayBus = createDelay(ctx, { time: delay.time, feedback: delay.feedback, cutoff: delay.cutoff });
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 1;
    this.delayReturn = ctx.createGain();
    this.delayReturn.gain.value = delay.return;
    this.delaySend.connect(this.delayBus.input);
    this.delayBus.output.connect(this.delayReturn);
    this.delayReturn.connect(this.busSum);
  }

  // Routes a layer's output node into the dry bus plus optional reverb/delay
  // sends. unDucked=true sends straight to the bus, bypassing the pump stage
  // (used by the kick).
  connectLayerOutput(node, { reverbAmount = 0, delayAmount = 0, unDucked = false } = {}) {
    node.connect(unDucked ? this.busSum : this.duckGain);
    if (reverbAmount > 0) {
      const g = this.ctx.createGain();
      g.gain.value = reverbAmount;
      node.connect(g);
      g.connect(this.reverbSend);
    }
    if (delayAmount > 0) {
      const g = this.ctx.createGain();
      g.gain.value = delayAmount;
      node.connect(g);
      g.connect(this.delaySend);
    }
  }

  // Sidechain-style pump at `time`: quickly dip everything but the kick,
  // then release. depth 0..1 (0 = no duck). The ramp starts from the last
  // commanded level rather than the audio thread's current value, so
  // overlapping pumps (fast kicks) don't click at the ramp start.
  pump(time, { depth = 0.6, release = 0.16 } = {}) {
    if (depth <= 0) return;
    const g = this.duckGain.gain;
    const from = this._duckTarget;
    const floor = Math.max(0.0001, from * (1 - depth));
    g.setValueAtTime(from, time);
    g.linearRampToValueAtTime(floor, time + 0.008);
    g.linearRampToValueAtTime(from, time + release);
  }

  // Live drive change (the "drive" slider). Swapping the curve is safe
  // mid-stream.
  setSaturation(amount) {
    this.saturation.curve = createSaturationCurve(amount);
  }

  // Live return levels -- the "space" sliders ride the wet returns.
  setReverbReturn(v) {
    this.reverbReturn.gain.setTargetAtTime(Math.max(0, v), this.ctx.currentTime, 0.4);
  }

  setDelayReturn(v) {
    this.delayReturn.gain.setTargetAtTime(Math.max(0, v), this.ctx.currentTime, 0.4);
  }

  // Re-routes the delay time (sync to the movement's tempo) and depth.
  setDelayTime(seconds) {
    this.delayBus.setDelayTime(seconds);
  }

  setDelayFeedback(v) {
    this.delayBus.setFeedback(v);
  }

  // Hard on/off the delay + reverb returns -- the dub "effect dropout".
  setEffectsMuted(muted, time) {
    const now = Math.max(time, this.ctx.currentTime);
    const targets = muted ? 0.0001 : 1.0;
    [this.delayReturn, this.reverbReturn].forEach((n) => {
      n.gain.setValueAtTime(n.gain.value, now);
      n.gain.linearRampToValueAtTime(targets, now + 0.05);
    });
  }

  async start() {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
    this.masterGain.gain.linearRampToValueAtTime(0.85, now + 3.5);
  }

  async stop() {
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
    this.masterGain.gain.linearRampToValueAtTime(0.0001, now + 2.5);
    setTimeout(() => {
      if (this.ctx.state === 'running') this.ctx.suspend();
    }, 2700);
  }

  setMasterVolume(v) {
    const now = this.ctx.currentTime;
    this.masterGain.gain.setTargetAtTime(Math.max(0.0001, v * 0.85), now, 0.3);
  }
}
