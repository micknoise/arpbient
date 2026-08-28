import { MODES, DARK_ROOTS, PROGRESSIONS, buildChord, voiceChordOpen, buildArpPool } from './theory.js';
import { PadLayer } from './pads.js';
import { ArpLayer } from './arp.js';
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
// The piece runs in "movements" at a fixed tempo -- tempo never changes
// mid-movement, only at an explicit ending: a huge multi-octave stab on
// the tonic across pad/bass/arp, fading away to leave a lone sustained
// pad, after which a new movement begins at a freshly chosen tempo.
//
// The bass is a continuous repetitive ostinato on the root that fades in
// and out on its own slow drift, rather than a rare "takeover" event. The
// pad additionally has a rhythmic 16th-note gate mode that switches on and
// off at random.
export class Conductor {
  constructor(audioCore) {
    this.core = audioCore;
    this.ctx = audioCore.ctx;

    this.pads = new PadLayer(this.ctx, audioCore, { reverbAmount: 0.5, delayAmount: 0.04 });
    this.arp = new ArpLayer(this.ctx, audioCore, { reverbAmount: 0.3, delayAmount: 0.5 });
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

    this.macro = { darkness: 0.5, density: 0.6, padLevel: 0.55, arpLevel: 0.4, bassLevel: 0.35, intensity: 0.15, timbre: 0.5 };
    this.intensityTarget = 0.15;
    this.intensitySurging = false;

    // Bass note-density is an audible read on intensity: 8th notes at
    // rest, switching to 16ths during a tension surge.
    this.bassSixteenths = false;

    // 'normal' = playing generatively; 'quiet' = the ending stab has fired
    // and only the lone resting pad is ringing out, waiting to restart.
    this.phase = 'normal';
    this.phaseUntil = 0;
    this.movementEndBar = this._pickMovementLength();

    this.padGate = { active: false, endBar: 0 };

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
    this.phase = 'normal';
    this.movementEndBar = this._pickMovementLength();
    this.padGate = { active: false, endBar: 0 };
    this.bassSixteenths = false;
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
    if (this.phase === 'quiet' && time >= this.phaseUntil) {
      this._beginNewMovement(time);
      return; // step/barIndex below are stale relative to the fresh movement
    }

    const stepsPerBar = this.beatsPerBar * this.stepsPerBeat;
    const barStep = step % stepsPerBar;
    const barIndex = Math.floor(step / stepsPerBar);

    if (barStep === 0 && this.phase === 'normal') {
      this._onBar(barIndex, time);
    }

    if (this.phase !== 'normal') return;

    if (this.macro.density > 0.1) {
      const arpCutoff = 800 + (1 - this.macro.darkness) * 1200 + this.macro.intensity * 600;
      const arpQ = 2 + this.macro.timbre * 6 + this.macro.intensity * 6 + Math.random() * 2;
      const sawLevel = 0.3 + this.macro.timbre * 0.35;
      const sqLevel = 0.5 - this.macro.timbre * 0.3;
      const detune = -4 - this.macro.timbre * 10;
      this.arp.triggerStep(time, arpCutoff, arpQ, sawLevel, sqLevel, detune);
    }

    // Bass: a continuous repetitive pedal ostinato on the root, not a
    // rare takeover -- its presence fades in and out via macro.bassLevel.
    // Note density doubles to 16ths during an intensity surge.
    const bassGrid = this.bassSixteenths ? 1 : this.stepsPerBeat / 2;
    if (step % bassGrid === 0) {
      this._fireBassPulse(time);
    }

    if (this.padGate.active) {
      this.pads.setGate(step % 2 === 0, time);
    }
  }

  _fireBassPulse(time) {
    const octaveUp = Math.random() < 0.18;
    const midi = this.root - 12 + (octaveUp ? 12 : 0);
    this.bass.playNote(midi, time, {
      cutoffBase: 700 + this.macro.intensity * 500,
      cutoffFloor: 130,
      q: 8 + Math.random() * 5,
      velocity: 0.45 + this.macro.intensity * 0.15,
      holdTime: 0.06,
    });
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

    // Soft-edged threshold so the switch to 16ths tracks intensity surges
    // rather than flipping on a hard boundary.
    this.bassSixteenths = this.macro.intensity > 0.5 + (Math.random() - 0.5) * 0.2;

    this._maybeTogglePadGate(barIndex, time);

    if (barIndex >= this.movementEndBar) {
      this._beginEnding(time);
    }
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
    const oscLevel = 0.4 + this.macro.timbre * 0.35;
    const subLevel = 0.45 - this.macro.timbre * 0.3;
    const detune = 4 + this.macro.timbre * 14;

    this.pads.playChord(padNotes, time, holdDuration - fadeTime, fadeTime, {
      cutoffBase,
      q: 4 + this.macro.timbre * 10 + this.macro.intensity * 8 + Math.random() * 3,
      velocity: 0.16 + this.macro.density * 0.1,
      oscLevel,
      subLevel,
      detune,
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

  // Rhythmic pad gate: rare, short bursts of a hard 16th-note on/off chop,
  // switching on and back off at random.
  _maybeTogglePadGate(barIndex, time) {
    if (!this.padGate.active) {
      if (Math.random() < 0.05) {
        this.padGate.active = true;
        this.padGate.endBar = barIndex + 1 + Math.floor(Math.random() * 3);
      }
    } else if (barIndex >= this.padGate.endBar) {
      this.padGate.active = false;
      this.pads.setGate(true, time);
    }
  }

  _pickMovementLength() {
    return 24 + Math.floor(Math.random() * 17); // 24-40 bars
  }

  _pickNewTempo() {
    return Math.round(55 + Math.random() * 70); // 55-125 bpm
  }

  // Direction for the ending flourish: ascending, descending, an arch
  // (up then down), or a shuffled run -- varies each time rather than
  // always climbing straight through the pool.
  _flourishOrder(pool) {
    const notes = [...pool].sort((a, b) => a - b);
    const shape = Math.random();
    if (shape < 0.28) return notes;
    if (shape < 0.56) return notes.slice().reverse();
    if (shape < 0.8) return notes.concat(notes.slice(0, -1).reverse());
    const shuffled = notes.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  // Cumulative time offsets for the flourish notes -- a random start/end
  // gap so each run can accelerate, decelerate, or stay roughly even,
  // rather than always ticking at a fixed rate.
  _flourishTimings(count) {
    const startGap = 0.025 + Math.random() * 0.055;
    const endGap = 0.025 + Math.random() * 0.055;
    const offsets = [0];
    for (let i = 1; i < count; i++) {
      const t = i / Math.max(1, count - 1);
      offsets.push(offsets[i - 1] + startGap + (endGap - startGap) * t);
    }
    return offsets;
  }

  // The ending: a huge combined stab on the tonic across pad/bass/arp,
  // spread over a wide octave range, fading away to leave a lone
  // sustained pad ringing out before the next movement begins.
  _beginEnding(time) {
    this.phase = 'quiet';
    this.padGate.active = false;
    this.pads.setGate(true, time);
    this.pads.setLevel(0.7);
    this.bass.setLevel(0.85);
    this.arp.setLevel(0.6);

    const chordSemis = buildChord(0, this.mode, 0, { seventh: false, add9: false });
    const bigNotes = [];
    for (let oct = -1; oct <= 3; oct++) {
      chordSemis.forEach((semi) => {
        const pc = ((semi % 12) + 12) % 12;
        bigNotes.push(this.root + pc + oct * 12);
      });
    }
    this.pads.playChord(bigNotes, time, 0.3, 1.8, { cutoffBase: 2000, q: 4, velocity: 0.42 });

    this.bass.playNote(this.root - 12, time, {
      cutoffBase: 2200,
      cutoffFloor: 300,
      q: 10,
      velocity: 0.9,
      holdTime: 0.3,
    });

    const pool = buildArpPool(this.root, chordSemis, 12);
    this.arp.setPool(pool);
    const flourishNotes = this._flourishOrder(pool);
    const offsets = this._flourishTimings(flourishNotes.length);
    flourishNotes.forEach((midi, i) => {
      this.arp.hit(midi, time + offsets[i], 4200, 2, 0.5, 0.35, -6);
    });

    const restNotes = voiceChordOpen(this.root, chordSemis);
    const restAttack = 2.5;
    const restHold = 8 + Math.random() * 6;
    this.pads.playChord(restNotes, time + 0.5, restHold, restAttack, { cutoffBase: 480, q: 3, velocity: 0.2 });

    this.phaseUntil = time + 0.5 + restAttack + restHold + restAttack * 1.6 + 0.4;
  }

  _beginNewMovement(time) {
    this.phase = 'normal';
    this.stepCount = 0;
    this.baseBpm = this._pickNewTempo();
    this.bpm = this.baseBpm;
    this.root = DARK_ROOTS[Math.floor(Math.random() * DARK_ROOTS.length)];
    this.movementEndBar = this._pickMovementLength();
    this._applyLevels();
    this._advanceChord(time);
  }

  _applyLevels() {
    this.pads.setLevel(this.macro.padLevel);
    this.arp.setLevel(this.macro.arpLevel);
    this.bass.setLevel(this.macro.bassLevel);
  }

  _driftMacros() {
    this.macro.darkness = clamp01(this.macro.darkness + (Math.random() - 0.5) * 0.3);
    this.macro.density = clamp01(this.macro.density + (Math.random() - 0.5) * 0.25);
    // Slow drift through oscillator balance/resonance/detune width, so the
    // pad and arp travel through different textures over the piece.
    this.macro.timbre = clamp01(this.macro.timbre + (Math.random() - 0.5) * 0.25);

    // Pad/arp/bass levels: mostly a moderate random walk, occasionally
    // dipping low for a deliberate "breath" before swelling back up.
    this.macro.padLevel = Math.random() < 0.15 ? 0.03 + Math.random() * 0.08 : clamp01(0.35 + Math.random() * 0.5);
    this.macro.arpLevel = Math.random() < 0.15 ? 0.02 + Math.random() * 0.06 : clamp01(0.2 + Math.random() * 0.4);
    this.macro.bassLevel = Math.random() < 0.2 ? 0.02 + Math.random() * 0.05 : clamp01(0.3 + Math.random() * 0.4);

    // Intensity: occasional surges that decay back down over the
    // following ticks, driving density/resonance/filter-rate faster and
    // more erratic before calming -- tempo is deliberately not touched
    // here, so momentum only changes at an explicit ending.
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
