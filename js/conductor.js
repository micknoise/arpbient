import { MODES, DARK_ROOTS, PROGRESSIONS, buildChord, voiceChordOpen, buildArpPool } from './theory.js';
import { PadLayer } from './pads.js';
import { ArpLayer } from './arp.js';
import { TextureLayer } from './texture.js';
import { BassLayer } from './bass.js';

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// Generative composer: picks a key/mode/progression at session start, then
// runs a lookahead scheduler that advances chords on bar boundaries, steps
// the arpeggiator on 16ths, mutates the arp pattern in small increments,
// and slowly random-walks macro parameters (darkness/density/intensity) so
// the piece drifts and breathes without ever fully resetting.
//
// Two event systems ride on top of the drift: sparse water "swells"
// (fade in, hold, fade out -- cycling rather than a constant bed), and
// occasional bass "solo" moments where the punchy sub-bass pulse takes
// over and the pads/arp/texture duck out, then fade back in.
export class Conductor {
  constructor(audioCore) {
    this.core = audioCore;
    this.ctx = audioCore.ctx;

    this.pads = new PadLayer(this.ctx, audioCore, { reverbAmount: 0.5, delayAmount: 0.04 });
    this.arp = new ArpLayer(this.ctx, audioCore, { reverbAmount: 0.3, delayAmount: 0.5 });
    this.texture = new TextureLayer(this.ctx, audioCore, { reverbAmount: 0.55 });
    this.bass = new BassLayer(this.ctx, audioCore, { reverbAmount: 0.18, delayAmount: 0 });

    this.root = DARK_ROOTS[Math.floor(Math.random() * DARK_ROOTS.length)];
    this.mode = ['aeolian', 'dorian', 'phrygian'][Math.floor(Math.random() * 3)];
    this.progression = PROGRESSIONS[Math.floor(Math.random() * PROGRESSIONS.length)];
    this.chordIndex = 0;
    this.barsPerChord = 4;

    this.baseBpm = 76;
    this.bpm = this.baseBpm;
    this.beatsPerBar = 4;
    this.stepsPerBeat = 4; // 16th-note grid

    this.lookahead = 25; // ms, scheduler tick interval
    this.scheduleAheadTime = 0.15; // seconds
    this.nextStepTime = 0;
    this.stepCount = 0;
    this.timerID = null;

    this.macro = { darkness: 0.5, density: 0.6, textureLevel: 0.3, padLevel: 0.55, arpLevel: 0.4, intensity: 0.15 };
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

    if (this.macro.density > 0.1 && !this.soloActive) {
      const arpCutoff = 800 + (1 - this.macro.darkness) * 1200 + this.macro.intensity * 600;
      this.arp.triggerStep(time, arpCutoff, 3 + this.macro.intensity * 6 + Math.random() * 2);
    }

    if (this.soloActive && step % 8 === 0) {
      const semi = Math.random() < 0.25 ? 7 : Math.random() < 0.15 ? -5 : 0;
      const midi = this.root - 12 + semi;
      this.bass.playNote(midi, time, {
        cutoffBase: 900 + this.macro.intensity * 900,
        cutoffFloor: 140,
        q: 9 + this.macro.intensity * 7 + Math.random() * 3,
        velocity: 0.55 + this.macro.intensity * 0.2,
        holdTime: 0.1,
      });
    }
  }

  _onBar(barIndex, time) {
    const chordBar = barIndex % this.barsPerChord;
    if (chordBar === 0) {
      this._advanceChord(time);
    }

    const progressionLoopBars = this.barsPerChord * this.progression.length;
    if (barIndex > 0 && barIndex % progressionLoopBars === 0) {
      if (Math.random() < 0.35) {
        this.progression = PROGRESSIONS[Math.floor(Math.random() * PROGRESSIONS.length)];
      }
      if (Math.random() < 0.12) {
        this._shiftMode();
      }
    }

    const mutateChance = 0.2 + this.macro.intensity * 0.6;
    if (barIndex % 2 === 0 && Math.random() < mutateChance) {
      this.arp.mutate();
    }

    if (barIndex % 4 === 0) {
      this._driftMacros();
    }

    this._maybeSwellTexture(time);
    this._maybeBassSolo(barIndex, time);
  }

  _advanceChord(time) {
    const degree = this.progression[this.chordIndex % this.progression.length];
    this.chordIndex++;

    const chordSemis = buildChord(0, this.mode, degree, { seventh: true, add9: Math.random() < 0.3 });
    const padNotes = voiceChordOpen(this.root, chordSemis);

    const holdBeats = this.barsPerChord * this.beatsPerBar;
    const holdDuration = holdBeats * (60 / this.bpm);
    const fadeTime = Math.min(holdDuration * 0.35, 5.0);
    const cutoffBase = 450 + this.macro.darkness * 80 + (1 - this.macro.darkness) * 850;

    this.pads.playChord(padNotes, time, holdDuration - fadeTime, fadeTime, {
      cutoffBase,
      q: 5 + this.macro.intensity * 8 + Math.random() * 3,
      velocity: 0.16 + this.macro.density * 0.1,
    });

    const pool = buildArpPool(this.root, chordSemis, 12);
    this.arp.setPool(pool);
    this.arp.setPattern(this._makePattern(pool));
  }

  _makePattern(pool) {
    const len = 16;
    const restChance = clamp01(0.32 - this.macro.density * 0.15 - this.macro.intensity * 0.2);
    const pattern = [];
    for (let i = 0; i < len; i++) {
      if (Math.random() < restChance) {
        pattern.push(null);
        continue;
      }
      pattern.push(pool[i % pool.length]);
    }
    return pattern;
  }

  _shiftMode() {
    const modes = Object.keys(MODES).filter((m) => m !== this.mode);
    this.mode = modes[Math.floor(Math.random() * modes.length)];
  }

  // Sparse discrete water swells -- cycling ambience rather than a
  // constant background wash.
  _maybeSwellTexture(time) {
    if (this.soloActive) return;
    const chance = 0.04 + this.macro.textureLevel * 0.06;
    if (Math.random() > chance) return;

    const strength = 0.4 + this.macro.textureLevel * 0.6;
    const peak = (0.06 + Math.random() * 0.09) * strength;
    const attack = 3 + Math.random() * 4;
    const hold = 3 + Math.random() * 5;
    const release = 4 + Math.random() * 5;
    this.texture.swell(peak, attack, hold, release, time);
  }

  // Occasionally lets the sub-bass take the spotlight: pads/arp/texture
  // duck out, the bass pulses alone for a while, then everything fades
  // back in.
  _maybeBassSolo(barIndex, time) {
    if (this.soloActive) {
      if (barIndex >= this.soloEndBar) {
        this.soloActive = false;
        this.bass.setLevel(0.0);
        this._applyLevels();
      }
      return;
    }
    if (barIndex > 0 && barIndex % 12 === 6 && Math.random() < 0.4) {
      this.soloActive = true;
      this.soloEndBar = barIndex + 8;
      this.bass.setLevel(0.55 + Math.random() * 0.15);
      this.pads.setLevel(0.04);
      this.arp.setLevel(0.02);
      this.texture.setWaterLevel(0.01);
    }
  }

  _applyLevels() {
    if (this.soloActive) return;
    this.pads.setLevel(this.macro.padLevel);
    this.arp.setLevel(this.macro.arpLevel);
  }

  _driftMacros() {
    this.macro.darkness = clamp01(this.macro.darkness + (Math.random() - 0.5) * 0.3);
    this.macro.density = clamp01(this.macro.density + (Math.random() - 0.5) * 0.25);
    this.macro.textureLevel = clamp01(this.macro.textureLevel + (Math.random() - 0.5) * 0.3);

    // Pad/arp levels: mostly a moderate random walk, occasionally dipping
    // low for a deliberate "breath" before swelling back up.
    this.macro.padLevel = Math.random() < 0.15 ? 0.03 + Math.random() * 0.08 : clamp01(0.35 + Math.random() * 0.5);
    this.macro.arpLevel = Math.random() < 0.15 ? 0.02 + Math.random() * 0.06 : clamp01(0.2 + Math.random() * 0.4);

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

    this.bpm = Math.max(this.baseBpm * 0.85, Math.min(170, this.baseBpm + this.macro.intensity * 80));

    this._applyLevels();
    this.pads.setFilterRate(0.02 + this.macro.intensity * 0.2 + (1 - this.macro.darkness) * 0.04);
    this.arp.setFilterRate(0.05 + this.macro.intensity * 0.4);
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
    this.macro.arpLevel = clamp01(0.2 + v * 0.5);
    this._applyLevels();
  }
}
