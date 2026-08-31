import { midiToFreq } from './theory.js';
import { reclaim } from './effects.js';

// Defiant low-melody voice — NOT an ostinato. Each call is one sustained note
// in the low octave, built to sound bright and resonant (detuned saws through
// a high-Q resonant lowpass, plus a sine sub for weight), with a slow attack
// and a long, ringing decay so notes sit in space rather than pulse.
//
// When `unison` is set, the same note is doubled an octave up by a detuned
// saw "synth string" ensemble — the higher voice that sometimes joins the
// bass line. Routed through a generous amount of reverb by the Conductor.
export class BassLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.6 } = {}) {
    this.ctx = ctx;

    this.out = ctx.createGain();
    this.out.gain.value = 1;
    audioCore.connectLayerOutput(this.out, { reverbAmount });
  }

  setLevel(v) {
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.6);
  }

  // One low, resonant, long-decay note. `midi` is absolute MIDI.
  playNote(midi, startTime, {
    velocity = 0.5,
    attack = 0.35,
    hold = 0.6,
    release = 3.0,
    bright = 0.7,   // 0..1 — raises the resonant cutoff (how "bright")
    detune = 8,     // cents — body width / beating
    unison = false, // add the octave-up synth-string double
    stringLevel = 0.5,
  } = {}) {
    this._bodyVoice(midi, startTime, velocity, attack, hold, release, bright, detune);
    if (unison) {
      this._stringVoice(midi + 12, startTime, velocity * stringLevel, attack * 1.4, hold, release * 1.2);
    }
  }

  // The low body: two detuned saws for presence + a sine sub below for weight,
  // through a resonant lowpass so it reads as a bright growl, not a hollow sine.
  _bodyVoice(midi, startTime, velocity, attack, hold, release, bright, detune) {
    const ctx = this.ctx;
    const f = midiToFreq(midi);

    const cutoff = 340 + bright * 1500;
    const q = 5 + bright * 8;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    filter.Q.value = q;

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    const t0 = startTime;
    const attackEnd = t0 + attack;
    const releaseStart = attackEnd + hold;
    const releaseEnd = releaseStart + release;
    const stopTime = releaseEnd + 0.3;

    // saw, detuned saw, sub sine — one octave below the body for weight.
    const voices = [];
    [[f, 1.0, 'sawtooth', -detune * 0.5], [f, 1.0, 'sawtooth', detune * 0.5], [f / 2, 0.85, 'sine', 0]]
      .forEach(([freq, amp, type, cents]) => {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = freq;
        osc.detune.value = cents;
        const g = ctx.createGain();
        g.gain.value = amp * 0.5;
        osc.connect(g);
        g.connect(filter);
        osc.start(t0);
        osc.stop(stopTime);
        voices.push(osc, g);
      });

    filter.connect(env);
    env.connect(this.out);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, attackEnd);
    env.gain.setValueAtTime(velocity, releaseStart);
    env.gain.exponentialRampToValueAtTime(0.0001, releaseEnd);
    reclaim(voices[0], ...voices, filter, env);
  }

  // Octave-up "synth string": a small detuned-saw ensemble, smoothed to a
  // soft stringy shimmer. Joins the low note in unison when asked.
  _stringVoice(midi, startTime, velocity, attack, hold, release) {
    const ctx = this.ctx;
    const f = midiToFreq(midi);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1500;
    filter.Q.value = 1.4;

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    const t0 = startTime;
    const attackEnd = t0 + attack;
    const releaseStart = attackEnd + hold;
    const releaseEnd = releaseStart + release;
    const stopTime = releaseEnd + 0.3;

    const voices = [];
    [-16, -5, 5, 16].forEach((cents) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      osc.detune.value = cents;
      const g = ctx.createGain();
      g.gain.value = 0.22;
      osc.connect(g);
      g.connect(filter);
      osc.start(t0);
      osc.stop(stopTime);
      voices.push(osc, g);
    });

    filter.connect(env);
    env.connect(this.out);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(velocity, attackEnd);
    env.gain.setValueAtTime(velocity, releaseStart);
    env.gain.exponentialRampToValueAtTime(0.0001, releaseEnd);
    reclaim(voices[0], ...voices, filter, env);
  }

  // Sub drop: a sub-octave sine that falls a run of semitones — the transient
  // "falling" accent used at the top of a build (the stinger's low end).
  subDrop(midi, startTime, { steps = 7, duration = 1.0, velocity = 0.7 } = {}) {
    const ctx = this.ctx;
    const f0 = midiToFreq(midi);
    const f1 = midiToFreq(Math.max(8, midi - steps));
    const t0 = startTime;
    const end = t0 + duration;

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(f0, t0);
    sub.frequency.exponentialRampToValueAtTime(Math.max(20, f1), end);

    // A faint saw for body so the drop isn't a naked sub.
    const body = ctx.createOscillator();
    body.type = 'sawtooth';
    body.frequency.setValueAtTime(f0, t0);
    body.frequency.exponentialRampToValueAtTime(Math.max(30, f1), end);
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0.25;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 220;
    filter.Q.value = 4;

    const env = ctx.createGain();
    env.gain.setValueAtTime(velocity, t0);
    env.gain.exponentialRampToValueAtTime(0.0001, end);

    sub.connect(filter);
    body.connect(bodyGain);
    bodyGain.connect(filter);
    filter.connect(env);
    env.connect(this.out);
    sub.start(t0);
    body.start(t0);
    sub.stop(end + 0.1);
    body.stop(end + 0.1);
    reclaim(sub, sub, body, bodyGain, filter, env);
  }
}
