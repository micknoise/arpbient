import { createSaturationCurve, createReverbImpulse, createDelay } from './effects.js';

// Owns the AudioContext and the master bus: dry sum -> saturation ->
// limiter -> master gain -> destination, plus reverb and delay send/returns
// that every layer can tap into.
export class AudioCore {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = this.ctx;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0; // fades in on start()

    // Invalidates any pending stop()'s delayed suspend on restart.
    this._stopGen = 0;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -14;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 10;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    this.saturation = ctx.createWaveShaper();
    this.saturation.curve = createSaturationCurve(0.15);
    this.saturation.oversample = '2x';

    this.busSum = ctx.createGain();
    this.busSum.gain.value = 1;

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
    this.convolver.buffer = createReverbImpulse(ctx, 4.5, 3.2);
    this.reverbDark = ctx.createBiquadFilter();
    this.reverbDark.type = 'lowpass';
    this.reverbDark.frequency.value = 3400;
    this.reverbDark.Q.value = 0.2;
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.55;
    this.reverbSend.connect(this.convolver);
    this.convolver.connect(this.reverbDark);
    this.reverbDark.connect(this.reverbReturn);
    this.reverbReturn.connect(this.busSum);

    // Delay send/return
    const del = createDelay(ctx, { time: 0.5, feedback: 0.4, cutoff: 2000 });
    this.delayNode = del;
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 0.6;
    this.delaySend.connect(del.input);
    del.output.connect(this.busSum);
  }

  // Routes a layer's output node into the dry bus plus optional reverb/delay sends.
  connectLayerOutput(node, { reverbAmount = 0.3, delayAmount = 0.0 } = {}) {
    node.connect(this.busSum);
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

  async start() {
    // A restart invalidates any pending stop()'s delayed suspend, so the
    // 2.7s-after-stop suspend can't fire on this new playback.
    this._stopGen++;
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
    const gen = ++this._stopGen;
    setTimeout(() => {
      // Only suspend if no start() (or newer stop()) has happened since.
      if (gen === this._stopGen && this.ctx.state === 'running') this.ctx.suspend();
    }, 2700);
  }

  setMasterVolume(v) {
    const now = this.ctx.currentTime;
    this.masterGain.gain.setTargetAtTime(Math.max(0.0001, v * 0.85), now, 0.3);
  }
}
