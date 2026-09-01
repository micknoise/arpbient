// One shared kit of synthesized drum voices. Every engine uses the same
// "hardware"; a genre's character comes from which voices the conductor
// fires, on which 16th steps, and with what velocity/pan/tone -- so a
// "techno hat" and a "dub brush" are the same node graph with different
// parameters. All voices are transient sources created per hit; each is
// explicitly reclaimed (disconnected) once it ends rather than left for GC.
import { createNoiseBuffer, reclaim } from './effects.js';
import { midiToFreq } from './theory.js';

export class DrumKit {
  constructor(ctx, audioCore, { reverbAmount = 0.1, delayAmount = 0.05 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.bus = ctx.createGain();
    this.bus.gain.value = 1;
    this.bus.connect(this.output);
    // Hats/claps/snare/etc ride the duck stage so the kick pumps them.
    audioCore.connectLayerOutput(this.output, { reverbAmount, delayAmount });

    // Kick bypasses the duck stage entirely so it never pumps itself.
    this.kickBus = ctx.createGain();
    this.kickBus.gain.value = 1;
    audioCore.connectLayerOutput(this.kickBus, { unDucked: true });

    this.noise = createNoiseBuffer(ctx, 2);
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.4);
  }

  setKickLevel(v) {
    this.kickBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.4);
  }

  // Returns the panner node if one was created, so callers can reclaim it.
  _pan(node, pan) {
    if (!pan) {
      node.connect(this.bus);
      return null;
    }
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    node.connect(p);
    p.connect(this.bus);
    return p;
  }

  _noiseHit(time, { duration, filterType, frequency, q = 0.8, gain = 1, rate = 1, target = null, pan = 0 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rate;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const env = ctx.createGain();
    env.gain.value = 0.0001;
    src.connect(filter);
    filter.connect(env);
    let p = null;
    if (target) {
      env.connect(target);
    } else if (pan) {
      p = ctx.createStereoPanner();
      p.pan.value = pan;
      env.connect(p);
      p.connect(this.bus);
    } else {
      env.connect(this.bus);
    }
    env.gain.setValueAtTime(gain, time);
    env.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    const offset = Math.random() * 1.0;
    src.start(time, offset);
    src.stop(time + duration + 0.05);
    reclaim(src, src, filter, env, ...(p ? [p] : []));
  }

  playKick(time, { velocity = 1, startFreq = 150, endFreq = 42, decay = 0.3, click = 0.35, body = 0.7 } = {}) {
    const ctx = this.ctx;
    // Beater: the classic sine pitch-drop, hard instant attack for the snap.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(endFreq, time + 0.07);
    const env = ctx.createGain();
    env.gain.setValueAtTime(velocity, time);
    env.gain.exponentialRampToValueAtTime(0.0001, time + decay);
    osc.connect(env);
    env.connect(this.kickBus);
    osc.start(time);
    osc.stop(time + decay + 0.05);
    reclaim(osc, osc, env);

    // Body: a low sub underneath the beater gives the kick weight.
    if (body > 0) {
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = Math.max(38, endFreq * 0.9);
      const subEnv = ctx.createGain();
      subEnv.gain.setValueAtTime(velocity * body, time);
      subEnv.gain.exponentialRampToValueAtTime(0.0001, time + decay * 1.5);
      sub.connect(subEnv);
      subEnv.connect(this.kickBus);
      sub.start(time);
      sub.stop(time + decay * 1.5 + 0.05);
      reclaim(sub, sub, subEnv);
    }

    // Transient: a short highpass click for the attack.
    if (click > 0) {
      this._noiseHit(time, {
        duration: 0.02,
        filterType: 'highpass',
        frequency: 4500,
        q: 0.8,
        gain: click * velocity,
        target: this.kickBus,
      });
    }
  }

  playSnare(time, { velocity = 0.9, tone = 190, noiseFreq = 1800, decay = 0.16, pan = 0 } = {}) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(tone, time);
    osc.frequency.exponentialRampToValueAtTime(tone * 0.6, time + decay);
    const oscEnv = ctx.createGain();
    oscEnv.gain.setValueAtTime(velocity * 0.7, time);
    oscEnv.gain.exponentialRampToValueAtTime(0.0001, time + decay * 0.8);
    osc.connect(oscEnv);
    const p = this._pan(oscEnv, pan);
    osc.start(time);
    osc.stop(time + decay + 0.05);
    reclaim(osc, osc, oscEnv, ...(p ? [p] : []));

    this._noiseHit(time, {
      duration: decay,
      filterType: 'bandpass',
      frequency: noiseFreq,
      q: 0.9,
      gain: velocity * 0.9,
      pan,
    });
  }

  // Stacked, slightly-staggered noise bursts -- a hand-clap.
  playClap(time, { velocity = 0.9, frequency = 1300, hits = 3, pan = 0.15 } = {}) {
    for (let i = 0; i < hits; i++) {
      const t = i === 0 ? time : time + 0.012 + Math.random() * 0.006 * i;
      this._noiseHit(t, {
        duration: i === hits - 1 ? 0.22 : 0.05,
        filterType: 'bandpass',
        frequency,
        q: 1.2,
        gain: velocity * (i === hits - 1 ? 1 : 0.6),
        pan,
      });
    }
  }

  playHat(time, { velocity = 0.7, frequency = 8500, decay = 0.05, pan = 0.25, rate = 1, q = 0.8 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rate;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(velocity, time);
    env.gain.exponentialRampToValueAtTime(0.0001, time + decay);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(filter);
    filter.connect(env);
    env.connect(p);
    p.connect(this.bus);
    const offset = Math.random() * 1.0;
    src.start(time, offset);
    src.stop(time + decay + 0.05);
    reclaim(src, src, filter, env, p);
  }

  playRim(time, { velocity = 0.5, frequency = 950, pan = 0 } = {}) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = frequency;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency * 1.5;
    filter.Q.value = 6;
    const env = ctx.createGain();
    env.gain.setValueAtTime(velocity, time);
    env.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    osc.connect(filter);
    filter.connect(env);
    env.connect(p);
    p.connect(this.bus);
    osc.start(time);
    osc.stop(time + 0.1);
    reclaim(osc, osc, filter, env, p);
  }

  playTom(time, { velocity = 0.8, startFreq = 130, endFreq = 48, decay = 0.3 } = {}) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(endFreq, time + decay);
    const env = ctx.createGain();
    env.gain.setValueAtTime(velocity, time);
    env.gain.exponentialRampToValueAtTime(0.0001, time + decay);
    osc.connect(env);
    env.connect(this.bus);
    osc.start(time);
    osc.stop(time + decay + 0.05);
    reclaim(osc, osc, env);
  }

  playCrash(time, { velocity = 0.5, frequency = 6000, decay = 1.2 } = {}) {
    this._noiseHit(time, {
      duration: decay,
      filterType: 'highpass',
      frequency,
      q: 0.5,
      gain: velocity,
    });
  }

  // Rising noise sweep with a bandpass opening up -- the pre-ending riser
  // and the new-movement intro swell.
  playRiser(time, duration, { peak = 0.5 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.4;
    filter.frequency.setValueAtTime(180, time);
    filter.frequency.exponentialRampToValueAtTime(7000, time + duration);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, time);
    env.gain.exponentialRampToValueAtTime(peak, time + duration * 0.9);
    env.gain.setValueAtTime(peak, time + duration);
    env.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.3);
    src.connect(filter);
    filter.connect(env);
    env.connect(this.bus);
    src.start(time, Math.random());
    src.stop(time + duration + 0.5);
    reclaim(src, src, filter, env);
  }

  // Falling noise sweep -- the "drop" that opens a new movement.
  playFall(time, duration, { peak = 0.45 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(6000, time);
    filter.frequency.exponentialRampToValueAtTime(150, time + duration);
    const env = ctx.createGain();
    env.gain.setValueAtTime(peak, time);
    env.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    src.connect(filter);
    filter.connect(env);
    env.connect(this.bus);
    src.start(time, Math.random());
    src.stop(time + duration + 0.2);
    reclaim(src, src, filter, env);
  }
}
