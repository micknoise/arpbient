// Naturalistic ambient bed: filtered brown-noise wind and water, sparse
// water droplet transients, and a faint tape/vinyl hiss for lofi warmth.
export class TextureLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.5, delayAmount = 0 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });

    this.noiseBuffer = this._makeBrownBuffer(6);
    this.whiteBuffer = this._makeWhiteBuffer(4);

    // Wind bed
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.0;
    this.windSource = ctx.createBufferSource();
    this.windSource.buffer = this.noiseBuffer;
    this.windSource.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 0.5;
    this.windLFO = ctx.createOscillator();
    this.windLFO.type = 'sine';
    this.windLFO.frequency.value = 0.025;
    this.windLFODepth = ctx.createGain();
    this.windLFODepth.gain.value = 260;
    this.windLFO.connect(this.windLFODepth);
    this.windLFODepth.connect(this.windFilter.frequency);
    this.windSource.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.output);
    this.windSource.start();
    this.windLFO.start();

    // Water shimmer bed
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0.0;
    this.waterSource = ctx.createBufferSource();
    this.waterSource.buffer = this.noiseBuffer;
    this.waterSource.loop = true;
    this.waterFilter = ctx.createBiquadFilter();
    this.waterFilter.type = 'bandpass';
    this.waterFilter.frequency.value = 2200;
    this.waterFilter.Q.value = 0.9;
    this.waterLFO = ctx.createOscillator();
    this.waterLFO.type = 'sine';
    this.waterLFO.frequency.value = 0.11;
    this.waterLFODepth = ctx.createGain();
    this.waterLFODepth.gain.value = 900;
    this.waterLFO.connect(this.waterLFODepth);
    this.waterLFODepth.connect(this.waterFilter.frequency);
    this.waterSource.connect(this.waterFilter);
    this.waterFilter.connect(this.waterGain);
    this.waterGain.connect(this.output);
    this.waterSource.start();
    this.waterLFO.start();

    // Faint constant hiss for lofi warmth
    this.hissSource = ctx.createBufferSource();
    this.hissSource.buffer = this.whiteBuffer;
    this.hissSource.loop = true;
    this.hissFilter = ctx.createBiquadFilter();
    this.hissFilter.type = 'highpass';
    this.hissFilter.frequency.value = 5000;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0.007;
    this.hissSource.connect(this.hissFilter);
    this.hissFilter.connect(this.hissGain);
    this.hissGain.connect(this.output);
    this.hissSource.start();
  }

  _makeBrownBuffer(seconds) {
    const rate = this.ctx.sampleRate;
    const len = rate * seconds;
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.012 * white) / 1.012;
        d[i] = last * 1.6;
      }
    }
    return buf;
  }

  _makeWhiteBuffer(seconds) {
    const rate = this.ctx.sampleRate;
    const len = rate * seconds;
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.9;
    }
    return buf;
  }

  setWindLevel(v) {
    this.windGain.gain.setTargetAtTime(v, this.ctx.currentTime, 3);
  }

  setWaterLevel(v) {
    this.waterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 3);
  }

  // A single discrete swell -- fades a bed up, holds, fades it back to
  // silence -- so texture reads as a cycling event rather than a constant wash.
  swell(which, peak, attack, hold, release, startTime) {
    const gainNode = which === 'wind' ? this.windGain : this.waterGain;
    const t0 = startTime;
    gainNode.gain.cancelScheduledValues(t0);
    gainNode.gain.setValueAtTime(gainNode.gain.value, t0);
    gainNode.gain.linearRampToValueAtTime(peak, t0 + attack);
    gainNode.gain.setValueAtTime(peak, t0 + attack + hold);
    gainNode.gain.linearRampToValueAtTime(0.0001, t0 + attack + hold + release);
  }

  scheduleDroplet(time) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1800 + Math.random() * 1600;
    filter.Q.value = 6;
    const env = ctx.createGain();
    env.gain.value = 0.0001;
    src.connect(filter);
    filter.connect(env);
    env.connect(this.output);
    env.gain.setValueAtTime(0.0001, time);
    env.gain.linearRampToValueAtTime(0.06 + Math.random() * 0.04, time + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, time + 0.35);
    src.start(time);
    src.stop(time + 0.4);
  }
}
