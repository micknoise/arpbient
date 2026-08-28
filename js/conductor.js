import { MODES, DARK_ROOTS, PROGRESSIONS, buildChord, voiceChordOpen, buildArpPool } from './theory.js';
import { PadLayer } from './pads.js';
import { StabLayer } from './stabs.js';
import { TextureLayer } from './texture.js';
import { BassLayer } from './bass.js';

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// Generative composer for the "sinister" pass: a fixed minor mode (always
// carrying a b6) with a narrow i/bVI harmonic cell, a sparse dark pad bed,
// a punchy resonant bass ostinato, and bright irregular stab hits for
// suspense stings. Chord lengths are irregular on purpose -- the piece
// should never settle into a predictable four-bar foursquare pattern.
// An intensity surge system periodically pushes tempo/density/resonance
// into faster, more erratic territory before it eases back down, and
// occasional bass "solo" moments duck everything else out.
export class Conductor {
  constructor(audioCore) {
    this.core = audioCore;
    this.ctx = audioCore.ctx;

    this.pads = new PadLayer(this.ctx, audioCore, { reverbAmount: 0.5, delayAmount: 0.03 });
    this.stabs = new StabLayer(this.ctx, audioCore, { reverbAmount: 0.5, delayAmount: 0.12 });
    this.texture = new TextureLayer(this.ctx, audioCore, { reverbAmount: 0.55 });
    this.bass = new BassLayer(this.ctx, audioCore, { reverbAmount: 0.12, delayAmount: 0 });

    this.root = DARK_ROOTS[Math.floor(Math.random() * DARK_ROOTS.length)];
    this.mode = Object.keys(MODES)[Math.floor(Math.random() * Object.keys(MODES).length)];
    this.progression = PROGRESSIONS[Math.floor(Math.random() * PROGRESSIONS.length)];
    this.chordIndex = 0;
    this.currentBassRoot = this.root - 12;
    this.stabPool = [];

    this.baseBpm = 70;
    this.bpm = this.baseBpm;
    this.beatsPerBar = 4;
    this.stepsPerBeat = 4; // 16th-note grid

    this.lookahead = 25; // ms, scheduler tick interval
    this.scheduleAheadTime = 0.15; // seconds
    this.nextStepTime = 0;
    this.stepCount = 0;
    this.nextChordBar = 0;
    this.timerID = null;

    this.macro = { darkness: 0.6, density: 0.5, textureLevel: 0.25, padLevel: 0.25, bassLevel: 0.4, intensity: 0.15 };
    this.intensityTarget = 0.15;
    this.intensitySurging = false;

    this.soloActive = false;
    this.soloEndBar = 0;

    this.running = false;
  }

  _stepDuration() {
    return 60 / this.bpm / this.stepsPerBeat;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.chordIndex = 0;
    this.stepCount = 0;
    this.nextChordBar = 0;
    this.nextStepTime = this.ctx.currentTime + 0.1;
    this.timerID = setInterval(() => this._scheduler(), this.lookahead);
  }

  stop() {
    this.running = false;
    if (this.timerID) clearInterval(this.timerID);
    this.timerID = null;
  }

  _scheduler() {
    while (this.nextStepTime < this.ctx.currentTime + this.scheduleAheadTime) {
      this._scheduleStep(this.stepCount, this.nextStepTime);
      this.nextStepTime += this._stepDuration();
      this.stepCount++;
    }
  }

  _scheduleStep(step, time) {
    const stepsPerBar = this.beatsPerBar * this.stepsPerBeat;
    const barStep = step % stepsPerBar;
    const barIndex = Math.floor(step / stepsPerBar);

    if (barStep === 0) {
      this._onBar(barIndex, time);
    }

    const isBeat = barStep % this.stepsPerBeat === 0;

    if (!this.soloActive && this.stabPool.length) {
      if (isBeat) {
        const chance = 0.06 + this.macro.density * 0.12 + this.macro.intensity * 0.2;
        if (Math.random() < chance) this._fireStab(time);
      } else if (Math.random() < 0.015 + this.macro.intensity * 0.04) {
        this._fireStab(time);
      }
    }

    if (!this.soloActive && this.macro.bassLevel > 0.08) {
      const grid = this.macro.intensity > 0.55 ? this.stepsPerBeat / 2 : this.stepsPerBeat;
      const restChance = 0.3 - this.macro.density * 0.15;
      if (step % grid === 0 && Math.random() > restChance) {
        this._fireBass(time, false);
      }
    }

    if (this.soloActive && step % (this.stepsPerBeat / 2) === 0) {
      this._fireBass(time, true);
    }
  }

  _fireStab(time) {
    const midi = this.stabPool[Math.floor(Math.random() * this.stabPool.length)];
    const cutoffBase = 3800 + this.macro.intensity * 2400;
    const q = 3 + this.macro.intensity * 5 + Math.random() * 2;
    const velocity = (0.16 + this.macro.intensity * 0.12) * (0.6 + Math.random() * 0.5);
    this.stabs.hit(midi, time, { cutoffBase, q, velocity, decay: 0.3 + Math.random() * 0.3 });

    if (Math.random() < 0.08) {
      const echoMidi = this.stabPool[Math.floor(Math.random() * this.stabPool.length)];
      this.stabs.hit(echoMidi, time + 0.09 + Math.random() * 0.05, {
        cutoffBase: cutoffBase * 0.8,
        q,
        velocity: velocity * 0.7,
        decay: 0.25,
      });
    }
  }

  _fireBass(time, solo) {
    let midi = this.currentBassRoot;
    if (!solo && Math.random() < 0.1) midi += 7;
    if (solo && Math.random() < 0.3) midi += Math.random() < 0.5 ? 7 : 12;
    const velocity = solo ? 0.6 + this.macro.intensity * 0.25 : 0.4 + this.macro.intensity * 0.25;
    this.bass.playNote(midi, time, {
      cutoffBase: 900 + this.macro.intensity * 900,
      cutoffFloor: 140,
      q: 9 + this.macro.intensity * 7 + Math.random() * 3,
      velocity,
      holdTime: solo ? 0.05 : 0.1,
    });
  }

  _onBar(barIndex, time) {
    if (barIndex >= this.nextChordBar) {
      this._advanceChord(barIndex, time);
    }

    if (barIndex % 4 === 0) {
      this._driftMacros();
    }

    this._maybeSwellTexture(time);
    this._maybeBassSolo(barIndex, time);
  }

  _pickHoldBars() {
    const opts = [3, 4, 4, 4, 5, 6];
    return opts[Math.floor(Math.random() * opts.length)];
  }

  _advanceChord(barIndex, time) {
    const degree = this.progression[this.chordIndex % this.progression.length];
    this.chordIndex++;
    if (this.chordIndex % this.progression.length === 0 && Math.random() < 0.35) {
      this.progression = PROGRESSIONS[Math.floor(Math.random() * PROGRESSIONS.length)];
    }

    const seventh = Math.random() < 0.12;
    const chordSemis = buildChord(0, this.mode, degree, { seventh, add9: false });
    const padNotes = voiceChordOpen(this.root, chordSemis);

    const holdBars = this._pickHoldBars();
    this.nextChordBar = barIndex + holdBars;

    const holdDuration = holdBars * this.beatsPerBar * (60 / this.bpm);
    const fadeTime = Math.min(holdDuration * 0.35, 6.0);
    const cutoffBase = 260 + this.macro.darkness * 40 + (1 - this.macro.darkness) * 420;

    this.pads.playChord(padNotes, time, holdDuration - fadeTime, fadeTime, {
      cutoffBase,
      q: 4 + this.macro.intensity * 6 + Math.random() * 2,
      velocity: 0.1 + this.macro.padLevel * 0.06,
    });

    this.currentBassRoot = this.root - 12 + chordSemis[0];
    this.stabPool = buildArpPool(this.root, chordSemis, 24);
  }

  // Sparse discrete water swells -- cycling ambience rather than a
  // constant background wash.
  _maybeSwellTexture(time) {
    if (this.soloActive) return;
    const chance = 0.035 + this.macro.textureLevel * 0.05;
    if (Math.random() > chance) return;

    const strength = 0.35 + this.macro.textureLevel * 0.55;
    const peak = (0.05 + Math.random() * 0.07) * strength;
    const attack = 3 + Math.random() * 4;
    const hold = 3 + Math.random() * 4;
    const release = 4 + Math.random() * 5;
    this.texture.swell(peak, attack, hold, release, time);
  }

  // Occasionally lets the bass take the spotlight: pads/stabs/texture duck
  // out, the bass pulses alone and louder for a while, then everything
  // fades back in.
  _maybeBassSolo(barIndex, time) {
    if (this.soloActive) {
      if (barIndex >= this.soloEndBar) {
        this.soloActive = false;
        this._applyLevels();
      }
      return;
    }
    if (barIndex > 0 && barIndex % 12 === 6 && Math.random() < 0.4) {
      this.soloActive = true;
      this.soloEndBar = barIndex + 8;
      this.bass.setLevel(0.6 + Math.random() * 0.2);
      this.pads.setLevel(0.03);
      this.stabs.setLevel(0.05);
      this.texture.setWaterLevel(0.0);
    }
  }

  _applyLevels() {
    if (this.soloActive) return;
    this.pads.setLevel(this.macro.padLevel);
    this.stabs.setLevel(0.4);
    this.bass.setLevel(this.macro.bassLevel);
  }

  _driftMacros() {
    this.macro.darkness = clamp01(this.macro.darkness + (Math.random() - 0.5) * 0.3);
    this.macro.density = clamp01(this.macro.density + (Math.random() - 0.5) * 0.25);
    this.macro.textureLevel = clamp01(this.macro.textureLevel + (Math.random() - 0.5) * 0.3);

    // Pad/bass levels: mostly a moderate random walk, occasionally dipping
    // low for a deliberate "breath" before swelling back up.
    this.macro.padLevel = Math.random() < 0.25 ? 0.02 + Math.random() * 0.06 : clamp01(0.15 + Math.random() * 0.35);
    this.macro.bassLevel = Math.random() < 0.12 ? 0.02 + Math.random() * 0.05 : clamp01(0.35 + Math.random() * 0.4);

    // Intensity: occasional surges that decay back down over the
    // following ticks, driving tempo/density/resonance faster and more
    // erratic before calming.
    if (!this.intensitySurging) {
      if (Math.random() < 0.14) {
        this.intensityTarget = 0.7 + Math.random() * 0.3;
        this.intensitySurging = true;
      } else {
        this.intensityTarget = 0.1 + Math.random() * 0.15;
      }
    } else {
      this.intensityTarget -= 0.22;
      if (this.intensityTarget <= 0.15) {
        this.intensityTarget = 0.1;
        this.intensitySurging = false;
      }
    }
    this.macro.intensity = clamp01(this.macro.intensity + (this.intensityTarget - this.macro.intensity) * 0.5);

    this.bpm = Math.max(this.baseBpm * 0.8, Math.min(190, this.baseBpm + this.macro.intensity * 110));

    this._applyLevels();
    this.pads.setFilterRate(0.015 + this.macro.intensity * 0.15 + (1 - this.macro.darkness) * 0.03);
  }

  setTempo(bpm) {
    this.baseBpm = bpm;
    this.bpm = bpm;
  }

  setDarknessOverride(v) {
    this.macro.darkness = v;
  }

  setDensityOverride(v) {
    this.macro.density = v;
    this.macro.bassLevel = clamp01(0.25 + v * 0.4);
    this._applyLevels();
  }
}
