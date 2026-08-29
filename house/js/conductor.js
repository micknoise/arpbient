import { buildChord, voiceChordOpen, buildLeadPool, pick, randInt, clamp01 } from './theory.js';
import { BassLayer } from './bass.js';
import { LeadLayer } from './lead.js';
import { DrumKit } from './drum.js';

// House composer. 16-step grid, 4/4, one chord per bar over a short
// i-rooted vamp. Fixed tempo and key per movement.
//
// The groove: round 4-on-the-floor kick, clap on 2 & 4, the signature
// off-beat open hats (swung), syncopated closed-hat ghosts, a warm
// syncopated bass (off-beat 8ths, octave pops, "the-and-a" syncopation),
// and alternating syncopated chord stabs and sparse chorus-lead phrases.
// Sections: groove (full), break (drums thin out), peak (melody rides up).
export class Conductor {
  constructor(audioCore) {
    this.core = audioCore;
    this.ctx = audioCore.ctx;

    this.kit = new DrumKit(this.ctx, audioCore, { reverbAmount: 0.08, delayAmount: 0.04 });
    this.bass = new BassLayer(this.ctx, audioCore, { reverbAmount: 0.1, delayAmount: 0.05 });
    this.lead = new LeadLayer(this.ctx, audioCore, { reverbAmount: 0.55, delayAmount: 0.35 });

    this.root = pick([43, 45, 48, 50, 52, 53]);
    this.mode = pick(['aeolian', 'dorian', 'aeolian', 'major']);
    this.progression = pick(PROGRESSIONS);
    this.chordIndex = 0;

    this.baseBpm = 122;
    this.bpm = this.baseBpm;
    this.beatsPerBar = 4;
    this.stepsPerBeat = 4;

    this.lookahead = 25;
    this.scheduleAheadTime = 0.15;
    this.nextStepTime = 0;
    this.stepCount = 0;
    this.timerID = null;

    this.macro = {
      warmth: 0.5,
      density: 0.6,
      intensity: 0.3,
      section: 'groove',
    };
    this.swing = 0.3; // 0..1, applied to hats/stabs/melody
    this.intensityTarget = 0.3;
    this.sectionUntilBar = 0;

    // Bass ostinato held for 4-8 bars (repetition locks the groove in).
    this.bassHoldBars = randInt(4, 8);
    this.polyBar = -1;

    // 16-step patterns.
    this.kickPat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    this.clapPat = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
    this.openHatPat = [0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0];
    this.ghostHatPat = new Array(16).fill(0);
    this.rimPat = new Array(16).fill(0);
    this.bassPat = new Array(16).fill(null);
    this.stabPat = new Array(16).fill(0);
    this.melodyPat = new Array(16).fill(null);

    this.chordSemis = [0, 4, 7];
    this.stabNotes = voiceChordOpen(this.root, this.chordSemis);
    this.melodyPool = buildLeadPool(this.root, this.mode, this.chordSemis);

    this.phase = 'normal';
    this.phaseUntil = 0;
    this.movementEndBar = this._pickMovementLength();
    this.userTempo = null;

    this.running = false;

    this.onBar = null;
    this.onChord = null;
    this.onEnding = null;
    this.onMovementStart = null;
  }

  _stepDuration() {
    return 60 / this.bpm / this.stepsPerBeat;
  }

  // Swing delays the off-grid 16ths (odd steps) -- the house shuffle.
  _swingTime(time, barStep) {
    if (barStep % 2 === 1) time += this.swing * this._stepDuration() * 0.45;
    return time;
  }

  start() {
    if (this.running) return;
    this.running = true;
    if (this.userTempo != null) this.bpm = this.userTempo;
    this._initMovement();
    this.phase = 'normal';
    this._syncDelay();
    this.nextStepTime = this.ctx.currentTime + 0.1;
    this.timerID = setInterval(() => this._scheduler(), this.lookahead);
  }

  stop() {
    this.running = false;
    if (this.timerID) clearInterval(this.timerID);
    this.timerID = null;
  }

  _initMovement() {
    this.chordIndex = 0;
    this.stepCount = 0;
    this.sectionUntilBar = 0;
    this.polyBar = -1;
    this.bassHoldBars = randInt(4, 8);
    this._advanceChord(this.ctx.currentTime, true);
    this._makeBassPattern();
    this._makeStabPattern();
    this._makeMelodyPattern();
    this._makeGhostHats();
    this.kickPat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    this.clapPat = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
    this.openHatPat = [0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0];
    this.rimPat = new Array(16).fill(0);
    this._applyLevels();
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
      return;
    }
    if (this.phase !== 'normal') return;

    const stepsPerBar = this.beatsPerBar * this.stepsPerBeat;
    const barStep = step % stepsPerBar;
    const barIndex = Math.floor(step / stepsPerBar);

    if (barStep === 0) this._onBar(barIndex, time);

    // Drums drop out of the 'break' section (classic house breakdown).
    const drumsOn = this.macro.section !== 'break';
    if (drumsOn) {
      const kv = this.kickPat[barStep];
      if (kv > 0) {
        this.kit.playKick(time, { velocity: kv, startFreq: 125, endFreq: 45, decay: 0.26, click: 0.12 });
        this.core.pump(time, { depth: 0.32 + this.macro.intensity * 0.18, release: 0.18 });
      }

      const cv = this.clapPat[barStep];
      if (cv > 0) this.kit.playClap(time, { velocity: cv, frequency: 1250, hits: 3, pan: 0.12 });

      if (this.openHatPat[barStep] > 0) {
        const t = this._swingTime(time, barStep);
        this.kit.playHat(t, {
          velocity: this.openHatPat[barStep],
          frequency: 7500,
          decay: 0.16,
          pan: barStep % 8 === 2 ? -0.45 : 0.45,
          q: 1.1,
        });
      }

      const gh = this.ghostHatPat[barStep];
      if (gh > 0) {
        const t = this._swingTime(time, barStep);
        this.kit.playHat(t, { velocity: gh, frequency: 9500, decay: 0.035, pan: barStep % 8 < 4 ? -0.3 : 0.3 });
      }

      if (this.rimPat[barStep] > 0) {
        const t = this._swingTime(time, barStep);
        this.kit.playRim(t, { velocity: this.rimPat[barStep], frequency: 1100, pan: 0.25 });
      }
    }

    // Warm syncopated bass -- the anchor, played straight (no swing).
    const b = this.bassPat[barStep];
    if (b) {
      const midi = this.root - 12 + b.pc;
      const warm = this.macro.warmth;
      this.bass.playNote(midi, time, {
        cutoffBase: 550 + warm * 700 + this.macro.intensity * 300,
        cutoffFloor: 80,
        q: 2.5 + warm * 2,
        velocity: b.vel * (0.85 + this.macro.intensity * 0.25),
        decay: b.len,
        subLevel: 0.55,
        detune: 8 + warm * 8,
      });
    }

    // Chord stabs (swung) -- off in the break, where the bass carries.
    const sv = this.stabPat[barStep];
    if (sv > 0 && this.macro.section !== 'break') {
      const t = this._swingTime(time, barStep);
      this.lead.stab(this.stabNotes, t, {
        cutoffBase: 1400 + this.macro.warmth * 800 + this.macro.intensity * 500,
        q: 1.8,
        velocity: sv,
        decay: 0.2 + this.macro.warmth * 0.12,
      });
    }

    // Sparse chorus melody (skipped on a polyrhythmic bar).
    const m = this.melodyPat[barStep];
    if (m && barIndex !== this.polyBar && this.macro.section !== 'break') {
      const t = this._swingTime(time, barStep);
      this.lead.phrase(this.melodyPool[m.noteIdx % this.melodyPool.length], t, {
        cutoffBase: 2400,
        velocity: m.vel,
        decay: m.len,
        vibratoRate: 4.5,
      });
    }
  }

  _onBar(barIndex, time) {
    if (this.onBar) this.onBar(barIndex);

    // One chord per bar (bar 0 already has the movement-start chord).
    if (barIndex > 0) this._advanceChord(time);

    // Section rotation: groove / break / peak.
    if (barIndex >= this.sectionUntilBar && barIndex > 0) {
      const r = Math.random();
      this.macro.section = r < 0.5 ? 'groove' : r < 0.85 ? 'peak' : 'break';
      this.sectionUntilBar = barIndex + randInt(4, 8);
      this._applyLevels();
      this._makeStabPattern();
      this._makeMelodyPattern();
    }

    // Mutations -- bass ostinato held 4-8 bars; hats/stabs stay fluid.
    this.bassHoldBars--;
    if (this.bassHoldBars <= 0) {
      this._makeBassPattern();
      this.bassHoldBars = randInt(4, 8);
    }
    if (Math.random() < 0.2) this._makeGhostHats();
    if (Math.random() < 0.3) this._makeStabPattern();
    if (Math.random() < 0.25) this._mutateClap();
    if (this.macro.section !== 'break' && Math.random() < 0.3) this._makeMelodyPattern();

    // Occasionally swap a clap for an off-beat ghost for variation.
    // Intensity drift.
    if (!this._surging) {
      if (Math.random() < 0.12) {
        this.intensityTarget = 0.65 + Math.random() * 0.35;
        this._surging = true;
      } else {
        this.intensityTarget = 0.2 + Math.random() * 0.3;
      }
    } else {
      this.intensityTarget -= 0.25;
      if (this.intensityTarget <= 0.3) {
        this.intensityTarget = 0.25;
        this._surging = false;
      }
    }
    this.macro.intensity = clamp01(this.macro.intensity + (this.intensityTarget - this.macro.intensity) * 0.5);

    // Polyrhythmic melody bar.
    if (this.macro.section === 'peak' && barIndex > 0 && Math.random() < 0.2) {
      this.polyBar = barIndex;
      this._playPolyPhrase(time);
    }

    if (barIndex >= this.movementEndBar) {
      this._beginEnding(time);
    }
  }

  _advanceChord(silent = false) {
    const degree = this.progression[this.chordIndex % this.progression.length];
    this.chordIndex++;
    this.chordSemis = buildChord(this.mode, degree, { seventh: true, add9: Math.random() < 0.4 });
    this.stabNotes = voiceChordOpen(this.root, this.chordSemis);
    this.melodyPool = buildLeadPool(this.root, this.mode, this.chordSemis);
    if (!silent && this.onChord) {
      this.onChord({ root: this.root, mode: this.mode, degree, midiNotes: this.stabNotes });
    }
  }

  // House bass patterns -- syncopated, root-anchored, octave pops.
  _makeBassPattern() {
    const pat = new Array(16).fill(null);
    const style = pick(['off8', 'sync', 'walk', 'stomp', 'off8']);
    if (style === 'off8') {
      [2, 6, 10, 14].forEach((s) => {
        pat[s] = { pc: s === 14 ? 12 : 0, vel: 0.8, len: 0.3 };
      });
    } else if (style === 'sync') {
      [0, 3, 6, 8, 11, 14].forEach((s) => {
        pat[s] = { pc: s === 3 || s === 11 ? 12 : 0, vel: 0.75, len: 0.26 };
      });
    } else if (style === 'walk') {
      [0, 4, 6, 8, 12, 14].forEach((s, i) => {
        pat[s] = { pc: i === 5 ? 7 : 0, vel: 0.7, len: 0.28 };
      });
    } else {
      [0, 7, 8, 14].forEach((s) => {
        pat[s] = { pc: s === 7 ? 12 : 0, vel: 0.85, len: 0.35 };
      });
    }
    // A passing third, kept within the octave.
    if (Math.random() < 0.5) {
      const third = ((this.chordSemis[1] % 12) + 12) % 12;
      const s = pick([2, 6, 10]);
      if (pat[s]) pat[s].pc = Math.random() < 0.5 ? third : 0;
    }
    this.bassPat = pat;
  }

  _makeStabPattern() {
    const pat = new Array(16).fill(0);
    const style = pick(['offbeat', 'sync', 'long', 'sparse']);
    if (style === 'offbeat') {
      [2, 6, 10, 14].forEach((s) => (pat[s] = 0.42 + Math.random() * 0.2));
    } else if (style === 'sync') {
      [3, 6, 10, 13].forEach((s) => (pat[s] = 0.4 + Math.random() * 0.25));
    } else if (style === 'long') {
      pat[0] = 0.55;
      pat[8] = 0.42;
    } else {
      pat[6] = 0.5;
      pat[14] = 0.45;
    }
    this.stabPat = pat;
  }

  _makeMelodyPattern() {
    const pat = new Array(16).fill(null);
    const notes = randInt(1, 3);
    const slots = pick(
      [[0, 8], [0, 6, 10], [4, 12], [8, 14], [0, 4, 12]]
    ).slice(0, notes);
    let idx = randInt(0, 3);
    slots.forEach((s) => {
      idx += pick([1, 2, 3]);
      pat[s] = { noteIdx: idx, vel: 0.35 + Math.random() * 0.2, len: 0.4 + Math.random() * 0.3 };
    });
    this.melodyPat = pat;
  }

  _makeGhostHats() {
    const pat = new Array(16).fill(0);
    const density = 0.25 + this.macro.density * 0.4;
    [1, 3, 5, 7, 9, 11, 13, 15].forEach((s) => {
      if (Math.random() < density) pat[s] = 0.14 + Math.random() * 0.18;
    });
    this.ghostHatPat = pat;
  }

  _mutateClap() {
    const r = Math.random();
    if (r < 0.3) {
      this.clapPat[11] = 0.3; // off-beat ghost
    } else if (r < 0.5) {
      this.clapPat[11] = 0;
      this.clapPat[15] = 0.28;
    } else {
      this.clapPat[11] = 0;
      this.clapPat[15] = 0;
    }
  }

  _playPolyPhrase(time) {
    const barDur = (4 * 60) / this.bpm;
    const [n, beats] = pick([[3, 2], [3, 4], [5, 4], [7, 4]]);
    const span = beats * (barDur / 4);
    const start = time + (Math.random() < 0.5 ? 0 : barDur / 2);
    for (let i = 0; i < n; i++) {
      const t = start + (span * i) / n;
      this.lead.phrase(pick(this.melodyPool), t, {
        cutoffBase: 2400,
        velocity: 0.34,
        decay: 0.3,
        vibratoRate: 5,
      });
    }
  }

  _pickMovementLength() {
    return randInt(32, 64);
  }

  _pickNewTempo() {
    return randInt(118, 126);
  }

  _applyLevels() {
    const s = this.macro.section;
    const bassL = s === 'break' ? 0.6 : 0.5 + this.macro.intensity * 0.15;
    const leadL = s === 'peak' ? 0.5 : s === 'break' ? 0.25 : 0.38;
    const drumL = s === 'break' ? 0.0 : 0.9;
    this.bass.setLevel(clamp01(bassL));
    this.lead.setLevel(clamp01(leadL));
    this.kit.setLevel(clamp01(drumL));
    this.kit.setKickLevel(0.95);
  }

  // Ending: drums thin to kick+clap, a riser swells, a final swung stab
  // lands on the downbeat with the kick, then a lone wide chord + bass
  // root ring out before the next movement drops in.
  _beginEnding(time) {
    this.phase = 'quiet';
    if (this.onEnding) this.onEnding();

    const barDur = (4 * 60) / this.bpm;
    const stepDur = barDur / 16;

    this.kit.playKick(time, { velocity: 0.9, startFreq: 120, endFreq: 45, decay: 0.4, click: 0.1 });
    this.kit.playClap(time, { velocity: 0.9, frequency: 1250, hits: 3 });
    this.core.pump(time, { depth: 0.5, release: 0.3 });
    [2, 6, 10, 14].forEach((s) => {
      const t = this._swingTime(time + s * stepDur, s);
      this.kit.playHat(t, { velocity: 0.4, frequency: 7500, decay: 0.16, q: 1.1, pan: s % 8 === 2 ? -0.45 : 0.45 });
    });
    this.kit.playRiser(time, barDur, { peak: 0.4 });

    const tEnd = time + barDur;
    // Final swung stab with the kick.
    this.lead.stab(this.stabNotes, tEnd, { cutoffBase: 2400, q: 2, velocity: 0.7, decay: 0.8 });
    this.bass.playNote(this.root - 12, tEnd, { cutoffBase: 1400, cutoffFloor: 90, q: 3, velocity: 0.9, decay: 0.8 });
    this.kit.playKick(tEnd, { velocity: 1.0, startFreq: 120, endFreq: 45, decay: 0.5, click: 0.15 });
    this.kit.playClap(tEnd, { velocity: 1, frequency: 1300, hits: 3 });
    this.core.pump(tEnd, { depth: 0.65, release: 0.4 });

    const restAttack = 2.0;
    const restHold = 5 + Math.random() * 4;
    this.lead.sustain(this.stabNotes, tEnd + 0.02, { attack: restAttack, hold: restHold, release: 4, cutoffBase: 1500, q: 1.2, velocity: 0.45 });
    this.bass.sustain(this.root - 12, tEnd + 0.02, { attack: restAttack, hold: restHold, release: 3, cutoffBase: 800, velocity: 0.55 });

    this.phaseUntil = tEnd + restAttack + restHold + 4 + 1;
  }

  _beginNewMovement(time) {
    this.phase = 'normal';
    this.bpm = this.userTempo != null ? this.userTempo : this._pickNewTempo();
    this.root = pick([43, 45, 48, 50, 52, 53]);
    this.mode = pick(['aeolian', 'dorian', 'aeolian', 'major']);
    this.progression = pick(PROGRESSIONS);
    this.movementEndBar = this._pickMovementLength();
    this.sectionUntilBar = 0;
    this._surging = false;
    this.intensityTarget = 0.3;
    this.macro.intensity = 0.3;
    this.kit.playFall(time, 0.9, { peak: 0.45 });
    this._initMovement();
    this._syncDelay();
    this.nextStepTime = Math.max(this.nextStepTime, time + 0.05);
    if (this.onMovementStart) this.onMovementStart({ root: this.root, mode: this.mode, bpm: this.bpm });
  }

  _syncDelay() {
    this.core.setDelayTime((60 / this.bpm) * 0.75);
  }

  setTempo(bpm) {
    this.userTempo = bpm;
  }

  setWarmth(v) {
    this.macro.warmth = clamp01(v);
  }

  setSwing(v) {
    this.swing = clamp01(v);
  }

  setDensity(v) {
    this.macro.density = clamp01(v);
    this._makeGhostHats();
    this._makeMelodyPattern();
  }

  triggerEnding() {
    if (this.phase !== 'normal') return;
    this.movementEndBar = 0;
  }
}

const PROGRESSIONS = [
  [0, 3, 2, 4], // i - VI - III - VII
  [0, 2, 3, 4],
  [0, 0, 3, 4],
  [0, 4, 3, 0],
];
