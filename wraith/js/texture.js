import { createNoiseBuffer, reclaim } from './effects.js';

// Non-musical sound-design layer: a persistent wind/room bed, plus discrete
// "scrape", "creak", and "crackle" events that punctuate a scene with the
// kind of foley-ish dread a horror score reaches for (a door, a metal beam,
// something shifting in the dark). All synthesized from noise buffers and
// filtered oscillators — no samples.
export class TextureLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.5 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    audioCore.connectLayerOutput(this.output, { reverbAmount });

    this.brownBuffer = createNoiseBuffer(ctx, 6, 'brown');
    this.pinkBuffer = createNoiseBuffer(ctx, 5, 'pink');
    this.whiteBuffer = createNoiseBuffer(ctx, 3, 'white');

    // Persistent wind / room bed — brown noise through a slowly-moving bandpass,
    // kept low (sub-300Hz center) so it reads as distant air and pressure, not
    // a mid-range hiss.
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.0;
    this.windSource = ctx.createBufferSource();
    this.windSource.buffer = this.brownBuffer;
    this.windSource.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 240;
    this.windFilter.Q.value = 0.9;
    this.windLFO = ctx.createOscillator();
    this.windLFO.type = 'sine';
    this.windLFO.frequency.value = 0.05;
    this.windLFODepth = ctx.createGain();
    this.windLFODepth.gain.value = 130;
    this.windLFO.connect(this.windLFODepth);
    this.windLFODepth.connect(this.windFilter.frequency);
    this.windSource.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.output);
    this.windSource.start();
    this.windLFO.start();
  }

  setWindLevel(v) {
    this.windGain.gain.setTargetAtTime(v, this.ctx.currentTime, 3);
  }

  // A discrete wind/room swell (fades the bed up, holds, fades back down).
  swell(peak, attack, hold, release, startTime) {
    const g = this.windGain;
    g.gain.cancelScheduledValues(startTime);
    g.gain.setValueAtTime(g.gain.value, startTime);
    g.gain.linearRampToValueAtTime(peak, startTime + attack);
    g.gain.setValueAtTime(peak, startTime + attack + hold);
    g.gain.linearRampToValueAtTime(0.0001, startTime + attack + hold + release);
  }

  // Metallic scrape: bandpass noise with a downward-swept center frequency and
  // a wobble LFO to break the glide into a "scrape." Centered low so it reads
  // as something heavy dragging in the dark, not a bright metallic shriek.
  scrape(startTime, { duration = 2, velocity = 0.15, fromHz = 700, toHz = 240, q = 11 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.pinkBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = q;
    filter.frequency.value = fromHz;
    const wob = ctx.createOscillator();
    wob.type = 'sine';
    wob.frequency.value = 6 + Math.random() * 9;
    const wobDepth = ctx.createGain();
    wobDepth.gain.value = fromHz * 0.1;
    wob.connect(wobDepth);
    wobDepth.connect(filter.frequency);

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    src.connect(filter);
    filter.connect(env);
    env.connect(this.output);

    const t0 = startTime;
    filter.frequency.setValueAtTime(fromHz, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(80, toHz), t0 + duration);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + duration * 0.3);
    env.gain.linearRampToValueAtTime(0.0001, t0 + duration);

    src.start(t0);
    src.stop(t0 + duration + 0.1);
    wob.start(t0);
    wob.stop(t0 + duration + 0.1);
    reclaim(src, src, wob, wobDepth, filter, env);
  }

  // Creak / groan: a low saw pitch-sweep through a narrow high-Q bandpass,
  // with a slow detune wobble — the "groan inside the wood/metal." Pitched
  // well down so it's a deep groan, not a bright squeal.
  creak(startTime, { duration = 3, velocity = 0.12, fromMidi = 33, toMidi = 24, q = 13 } = {}) {
    const ctx = this.ctx;
    const f0 = 440 * Math.pow(2, (fromMidi - 69) / 12);
    const f1 = 440 * Math.pow(2, (toMidi - 69) / 12);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const wob = ctx.createOscillator();
    wob.type = 'sine';
    wob.frequency.value = 1.5 + Math.random() * 2.5;
    const wobDepth = ctx.createGain();
    wobDepth.gain.value = 12;
    wob.connect(wobDepth);
    wobDepth.connect(osc.detune);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = q;

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    osc.connect(filter);
    filter.connect(env);
    env.connect(this.output);

    const t0 = startTime;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + duration);
    filter.frequency.setValueAtTime(f0 * 2, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, f1 * 2), t0 + duration);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, t0 + duration * 0.4);
    env.gain.linearRampToValueAtTime(0.0001, t0 + duration);

    osc.start(t0);
    osc.stop(t0 + duration + 0.1);
    wob.start(t0);
    wob.stop(t0 + duration + 0.1);
    reclaim(osc, osc, wob, wobDepth, filter, env);
  }

  // Crackle / rattle: a burst of lowpassed noise broken into rough pulses —
  // a low wooden/metallic rattle rather than a bright hiss.
  crackle(startTime, { duration = 1.5, velocity = 0.25 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.whiteBuffer;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 1.5;
    const env = ctx.createGain();
    env.gain.value = 0.0001;

    src.connect(lp);
    lp.connect(env);
    env.connect(this.output);

    const t0 = startTime;
    const pulses = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < pulses; i++) {
      const pt = t0 + (i / pulses) * duration * 0.9;
      env.gain.setValueAtTime(velocity * (0.5 + Math.random() * 0.5), pt);
      env.gain.linearRampToValueAtTime(0.0001, pt + 0.05);
    }
    src.start(t0);
    src.stop(t0 + duration + 0.1);
    reclaim(src, src, lp, env);
  }
}
