import { MODES, buildChord, voiceChordOpen, buildArpPool, pick, randInt, clamp01 } from './theory.js';
import { BassLayer } from './bass.js';
import { LeadLayer } from './lead.js';
import { DrumKit } from './drum.js';

// Techno composer. 16-step grid (16ths), 4/4, one chord per bar over a
// short repetitive i-rooted progression. Fixed tempo and key per movement.
//
// The groove: 4-on-the-floor kick (with the occasional 16th pickup), clap
// on 2 and 4, off-beat 8th hats that open up into 16ths as intensity
// builds, a continuous acid bass line, and either a 16th pluck arpeggio
// or syncopated chord stabs -- the two alternate by section rather than
// playing together all the time. The kick pumps the whole mix through
// AudioCore.pump on every hit.
export class Conductor {
  constructor(audioCore) {
    this.core = audioCore;
    this.ctx = audioCore.ctx;

    this.kit = new DrumKit(this.ctx, audioCore, { reverbAmount: 0.1, delayAmount: 0.05 });
    this.bass = new BassLayer(this.ctx, audioCore, { reverbAmount: 0.12, delayAmount: 0.04 });
    this.lead = new LeadLayer(this.ctx, audioCore, { reverbAmount: 0.45, delayAmount: 0.4 });

    this.root = pick([38, 41, 43, 45, 47, 50]);
    this.mode = Math.random() < 0.8 ? 'aeolian' : 'phrygian';
    this.progression = pick(PROGRESSIONS);
    this.chordIndex = 0;

    this.baseBpm = 126;
    this.bpm = this.baseBpm;
    this.beatsPerBar = 4;
    this.stepsPerBeat = 4;

    this.lookahead = 25;
    this.scheduleAheadTime = 0.15;
    this.nextStepTime = 0;
    this.stepCount = 0;
    this.timerID = null;

    this.macro = {
      acid: 0.5,
      density: 0.6,
      intensity: 0.3,
      section: 'main',
      bassLevel: 0.55,
      leadLevel: 0.3,
      drumLevel: 0.9,
    };
    this.intensityTarget = 0.3;
    this.sectionUntilBar = 0;

    // Section model: a section change is one concert event (bass + top
    // voice + drums + levels all re-rolled together), and within a section
    // the groove builds by adding layers bar by bar instead of swapping
    // individual parts on their own timers -- nothing drifts out of sync.
    this.sectionBar = 0;      // bars since the current section started
    this.layerGates = {};     // additive layer -> sectionBar at which it joins
    // Set to the bar index whose grid lead is replaced by a polyrhythmic
    // phrase scheduled off the 16th grid.
    this.polyBar = -1;

    // 16-step pattern arrays (velocity 0..1, or null / per-voice objects).
    this.kickPat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    this.clapPat = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
    this.hatPat = [0, 0, 0.55, 0, 0, 0, 0.55, 0, 0, 0, 0.55, 0, 0, 0, 0.55, 0];
    this.hatOpenPat = new Array(16).fill(0);
    this.rimPat = new Array(16).fill(0);
    this.bassPat = new Array(16).fill(null);
    this.leadPat = new Array(16).fill(null);
    this.stabPat = new Array(16).fill(0);

    this.chordSemis = [0, 7, 12];
    this.leadPool = [72, 79, 84];

    this.phase = 'normal';
    this.phaseUntil = 0;
    this.movementEndBar = this._pickMovementLength();

    // Tempo from the slider is a *target*: it only takes effect at a
    // movement boundary, so tempo never changes mid-movement.
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
    this._advanceChord(this.ctx.currentTime, true);
    this._applySection('main');
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

    // Kick + pump
    const kv = this.kickPat[barStep];
    if (kv > 0) {
      this.kit.playKick(time, { velocity: kv, decay: 0.32, click: 0.35 });
      this.core.pump(time, { depth: 0.4 + this.macro.intensity * 0.3, release: 0.2 });
    }

    const cv = this.clapPat[barStep];
    if (cv > 0) this.kit.playClap(time, { velocity: cv, frequency: 1400, hits: 3, pan: 0.1 });

    if (this.hatPat[barStep] > 0) {
      const offbeat = barStep % 4 === 2;
      this.kit.playHat(time, {
        velocity: this.hatPat[barStep],
        frequency: 9000,
        decay: offbeat ? 0.055 : 0.03,
        pan: barStep % 8 === 2 ? -0.3 : 0.3,
      });
    }
    if (this.hatOpenPat[barStep] > 0 && this._layerOn('openHat')) {
      this.kit.playHat(time, {
        velocity: this.hatOpenPat[barStep],
        frequency: 7000,
        decay: 0.18,
        pan: barStep % 8 === 2 ? -0.4 : 0.4,
        q: 1.2,
      });
    }

    if (this.rimPat[barStep] > 0 && this._layerOn('rim')) {
      this.kit.playRim(time, { velocity: this.rimPat[barStep], frequency: 900, pan: 0.2 });
    }

    // Acid bass line
    const b = this.bassPat[barStep];
    if (b) {
      const midi = this.root - 12 + b.pc;
      const acid = this.macro.acid;
      this.bass.playNote(midi, time, {
        cutoffBase: 500 + acid * 1000 + this.macro.intensity * 300,
        cutoffFloor: 100 + acid * 80,
        q: 5 + acid * 6 + this.macro.intensity * 3,
        velocity: Math.min(0.85, b.vel * (0.8 + this.macro.intensity * 0.2)),
        decay: b.len,
        subLevel: 0.4,
        driveLevel: 0.4 + acid * 0.3,
      });
    }

    // Pluck arpeggio (main section) and syncopated stabs (peak/breakdown).
    // The grid lead is skipped on the bar a polyrhythmic phrase replaces it.
    const l = this.leadPat[barStep];
    if (l && this.macro.section === 'main' && barIndex !== this.polyBar && this._layerOn('top')) {
      this.lead.pluck(this.leadPool[l.noteIdx % this.leadPool.length], time, {
        cutoffBase: 1800 + this.macro.intensity * 1200,
        q: 4 + this.macro.acid * 5,
        velocity: l.vel,
        decay: 0.12,
      });
    }

    const sv = this.stabPat[barStep];
    if (sv > 0 && this.macro.section !== 'main' && this._layerOn('top')) {
      this.lead.stab(this.stabNotes, time, {
        cutoffBase: 1600 + this.macro.intensity * 800,
        q: 2.5,
        velocity: sv,
        decay: 0.2,
      });
    }
  }

  _onBar(barIndex, time) {
    if (this.onBar) this.onBar(barIndex);

    // One chord per bar, cycling the short repetitive progression.
    // Bar 0 already has the chord established at movement start.
    if (barIndex > 0) this._advanceChord(time);

    // A section change is one concert event: bass + top voice + drums +
    // levels all re-rolled together. Between changes the groove is stable
    // and only builds by adding layers (see _layerOn).
    if (barIndex > 0 && barIndex >= this.sectionUntilBar) {
      this._applySection(this._pickSection());
      this.sectionUntilBar = barIndex + randInt(4, 8);
    } else if (barIndex > 0) {
      this.sectionBar++;
    }

    // Sometimes let the lead run a polyrhythmic phrase against the 16th
    // grid (3-against-2, 5-against-4, ...) instead of the grid pattern.
    // Only against a live grid lead -- an orphaned off-grid phrase with
    // the top voice gated off reads as a timing error.
    if (this.macro.section === 'main' && barIndex > 0 && this._layerOn('top') && Math.random() < 0.18) {
      this.polyBar = barIndex;
      this._playPolyPhrase(time);
    }

    // Macro drift
    if (!this._surging) {
      if (Math.random() < 0.12) {
        this.intensityTarget = 0.7 + Math.random() * 0.3;
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

    if (barIndex >= this.movementEndBar) {
      this._beginEnding(time);
    }
  }

  // One concert event: pick the section's full groove (bass + top voice +
  // drums + levels) and reset the in-section layer build.
  _applySection(name) {
    this.macro.section = name;
    this.sectionBar = 0;
    this._makeBassPattern();
    this._makeLeadPattern();
    this._makeStabPattern();
    this._makeHatPattern();
    // Kick + clap are the constant core; the hot section adds a pickup.
    this.kickPat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    if (name === 'peak') this.kickPat[15] = 0.7;
    this.clapPat = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
    this.rimPat = new Array(16).fill(0);
    this._mutateRim();
    this._applyLevels();
    // Additive layers join as the section builds: open hats, rim, and the
    // top voice (pluck in main / stab elsewhere). Peak is full immediately;
    // breakdown stays sparse and only lets the top voice in late.
    this.layerGates =
      name === 'peak' ? {} :
      name === 'breakdown' ? { openHat: 3, rim: 99, top: 2 } :
      { openHat: 1, rim: 2, top: 1 };
  }

  _pickSection() {
    const r = Math.random();
    if (r < 0.5) return 'main';
    if (r < 0.85) return 'peak';
    return 'breakdown';
  }

  // An additive layer plays once the section has built far enough.
  _layerOn(name) {
    return this.sectionBar >= (this.layerGates[name] ?? 0);
  }

  _advanceChord(time, silent = false) {
    const degree = this.progression[this.chordIndex % this.progression.length];
    this.chordIndex++;
    this.chordSemis = buildChord(this.mode, degree, { seventh: true, add9: Math.random() < 0.35 });
    this.leadPool = buildArpPool(this.root, this.chordSemis, 12);
    this.stabNotes = voiceChordOpen(this.root, this.chordSemis);
    if (!silent && this.onChord) {
      this.onChord({ root: this.root, mode: this.mode, degree, midiNotes: this.stabNotes });
    }
  }

  _makeBassPattern() {
    const pat = new Array(16).fill(null);
    const style = pick(['8ths', '8ths', '16run', 'sync']);
    if (style === '8ths') {
      [0, 2, 4, 6, 8, 10, 12, 14].forEach((s) => {
        pat[s] = { pc: 0, vel: s % 4 === 0 ? 0.85 : 0.65, len: 0.35 };
      });
    } else if (style === '16run') {
      for (let s = 0; s < 16; s++) {
        pat[s] = { pc: s % 8 === 7 ? 12 : 0, vel: s % 2 === 0 ? 0.7 : 0.45, len: 0.18 };
      }
    } else {
      [0, 3, 6, 8, 11, 14].forEach((s, i) => {
        const pcs = [0, 0, 7, 0, 3, 0];
        pat[s] = { pc: pcs[i], vel: 0.75, len: 0.3 };
      });
    }
    // Sprinkle one or two passing chord tones (kept within the octave).
    const passing = ((this.chordSemis[1] % 12) + 12) % 12;
    for (let i = 0; i < 2; i++) {
      if (Math.random() < 0.45) {
        const s = pick([2, 6, 10, 14]);
        if (pat[s]) pat[s].pc = Math.random() < 0.5 ? passing : 0;
      }
    }
    this.bassPat = pat;
  }

  _makeLeadPattern() {
    const rest = clamp01(0.55 - this.macro.density * 0.45 - this.macro.intensity * 0.2);
    const pat = new Array(16).fill(null);
    let idx = 0;
    for (let s = 0; s < 16; s++) {
      if (Math.random() < rest) continue;
      idx += pick([1, 1, 2]);
      pat[s] = { noteIdx: idx, vel: s % 4 === 0 ? 0.4 : 0.28 + Math.random() * 0.2 };
    }
    this.leadPat = pat;
  }

  _makeStabPattern() {
    const pat = new Array(16).fill(0);
    const style = pick(['sync', 'sync', 'long', 'sparse']);
    if (style === 'sync') {
      [3, 6, 10, 13].forEach((s) => (pat[s] = 0.4 + Math.random() * 0.25));
    } else if (style === 'long') {
      pat[0] = 0.55;
      pat[8] = 0.4;
    } else {
      pat[6] = 0.5;
      if (Math.random() < 0.5) pat[14] = 0.45;
    }
    this.stabPat = pat;
  }

  _makeHatPattern() {
    if (this.macro.section === 'breakdown') {
      // Sparse closed hats; the open hats exist but only join via the gate.
      const pat = new Array(16).fill(0);
      [2, 10].forEach((s) => (pat[s] = 0.4));
      const open = new Array(16).fill(0);
      open[6] = 0.3;
      open[14] = 0.35;
      this.hatPat = pat;
      this.hatOpenPat = open;
      return;
    }
    const style = this.macro.intensity > 0.6 ? '16' : pick(['off8', 'off8', '16', 'sparse']);
    const pat = new Array(16).fill(0);
    const open = new Array(16).fill(0);
    if (style === 'off8') {
      [2, 6, 10, 14].forEach((s, i) => (pat[s] = 0.45 + (i % 2 ? 0.1 : 0.2)));
      if (Math.random() < 0.4) [6, 14].forEach((s) => (open[s] = 0.35));
    } else if (style === '16') {
      for (let s = 0; s < 16; s++) {
        pat[s] = s % 4 === 2 ? 0.55 : 0.2;
      }
      open[14] = 0.4;
    } else {
      [6, 10, 14].forEach((s) => (pat[s] = 0.5));
    }
    this.hatPat = pat;
    this.hatOpenPat = open;
  }

  _mutateRim() {
    const pat = new Array(16).fill(0);
    if (Math.random() < 0.5) {
      const spots = pick([[1, 5, 13], [3, 11], [1, 9, 13, 15], [5, 13]]);
      spots.forEach((s) => (pat[s] = 0.25 + Math.random() * 0.25));
    }
    this.rimPat = pat;
  }

  // Polyrhythmic lead phrase: N evenly-spaced notes over M beats, replacing
  // the bar's grid pattern (see polyBar). The notes walk the pool in one
  // direction with an accented head, so it reads as a deliberate figure
  // against the grid rather than a timing slip.
  _playPolyPhrase(time) {
    const barDur = (4 * 60) / this.bpm;
    const [n, beats] = pick([[3, 2], [3, 4], [5, 4], [7, 4], [5, 2]]);
    const span = beats * (barDur / 4);
    const start = time + (Math.random() < 0.5 ? 0 : barDur / 2);
    const pool = this.leadPool;
    let idx = Math.floor(Math.random() * pool.length);
    const dir = Math.random() < 0.5 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const t = start + (span * i) / n;
      idx += dir * pick([1, 1, 2]);
      this.lead.pluck(pool[((idx % pool.length) + pool.length) % pool.length], t, {
        cutoffBase: 2000 + this.macro.intensity * 1000,
        q: 5 + this.macro.acid * 4,
        velocity: i === 0 ? 0.5 : 0.34,
        decay: 0.16,
      });
    }
  }

  _pickMovementLength() {
    return randInt(32, 64); // ~40s-90s at techno tempos
  }

  _pickNewTempo() {
    return randInt(120, 134);
  }

  _applyLevels() {
    const s = this.macro.section;
    const bassL = s === 'breakdown' ? 0.28 : 0.34 + this.macro.intensity * 0.08;
    const leadL = s === 'main' ? 0.4 : s === 'peak' ? 0.5 : 0.2;
    const drumL = s === 'breakdown' ? 0.75 : 0.9;
    this.bass.setLevel(clamp01(bassL));
    this.lead.setLevel(clamp01(leadL));
    this.kit.setLevel(clamp01(drumL));
    this.kit.setKickLevel(1.0);
  }

  // The ending: the groove thins to kick-and-open-hat, a riser swells,
  // then a final hit across bass + lead + kit, and a lone sustained chord
  // rings out before the next movement drops in.
  _beginEnding(time) {
    this.phase = 'quiet';
    if (this.onEnding) this.onEnding();

    const barDur = (4 * 60) / this.bpm;
    const stepDur = barDur / 16;

    // Breakdown bar: sparse kick, open offbeat hats, riser underneath.
    this.kit.playKick(time, { velocity: 0.9, decay: 0.4 });
    this.kit.playKick(time + barDur / 2, { velocity: 0.9, decay: 0.4 });
    this.core.pump(time, { depth: 0.5, release: 0.3 });
    this.core.pump(time + barDur / 2, { depth: 0.5, release: 0.3 });
    [2, 6, 10, 14].forEach((s) => {
      this.kit.playHat(time + s * stepDur, { velocity: 0.45, frequency: 7000, decay: 0.18, q: 1.2, pan: s % 8 === 2 ? -0.4 : 0.4 });
    });
    this.kit.playRiser(time, barDur, { peak: 0.4 });

    // Final hit at the bar line.
    const tEnd = time + barDur;
    this.kit.playKick(tEnd, { velocity: 1.1, decay: 0.5 });
    this.kit.playClap(tEnd, { velocity: 1, frequency: 1500, hits: 3 });
    this.core.pump(tEnd, { depth: 0.7, release: 0.4 });
    this.bass.playNote(this.root - 12, tEnd, { cutoffBase: 2200, cutoffFloor: 200, q: 14, velocity: 0.95, decay: 1.2 });
    const bigChord = this.stabNotes.concat(this.stabNotes.map((n) => n - 12));
    this.lead.stab(bigChord, tEnd, { cutoffBase: 2600, q: 3, velocity: 0.8, decay: 0.9 });

    // Lone sustained chord, long reverb tail.
    const restAttack = 2.0;
    const restHold = 5 + Math.random() * 4;
    this.lead.sustain(this.stabNotes, tEnd + 0.02, { attack: restAttack, hold: restHold, release: 4, cutoffBase: 1400, q: 1.5, velocity: 0.4 });
    this.bass.playNote(this.root - 24, tEnd + 0.02, { cutoffBase: 400, cutoffFloor: 60, q: 4, velocity: 0.5, decay: restHold + restAttack, subLevel: 0.9, driveLevel: 0.4 });

    this.phaseUntil = tEnd + restAttack + restHold + 4 + 1;
  }

  _beginNewMovement(time) {
    this.phase = 'normal';
    this.baseBpm = this.userTempo != null ? this.userTempo : this._pickNewTempo();
    this.bpm = this.baseBpm;
    this.root = pick([38, 41, 43, 45, 47, 50]);
    this.mode = Math.random() < 0.8 ? 'aeolian' : 'phrygian';
    this.progression = pick(PROGRESSIONS);
    this.movementEndBar = this._pickMovementLength();
    this.sectionUntilBar = 0;
    this._surging = false;
    this.intensityTarget = 0.3;
    this.macro.intensity = 0.3;
    this.kit.playFall(time, 1.0, { peak: 0.5 });
    this._initMovement();
    this._syncDelay();
    this.nextStepTime = Math.max(this.nextStepTime, time + 0.05);
    if (this.onMovementStart) this.onMovementStart({ root: this.root, mode: this.mode, bpm: this.bpm });
  }

  // Sync the shared delay to the movement's tempo (dotted-8th feel).
  _syncDelay() {
    this.core.setDelayTime((60 / this.bpm) * 0.75);
  }

  // Target tempo only -- applied at the next movement boundary (or on the
  // next start), never mid-movement.
  setTempo(bpm) {
    this.userTempo = bpm;
  }

  setAcidity(v) {
    this.macro.acid = clamp01(v);
    this.bass.setDrive(0.15 + v * 0.45);
  }

  setDensity(v) {
    this.macro.density = clamp01(v);
    this._makeLeadPattern();
    this._makeHatPattern();
  }

  triggerEnding() {
    if (this.phase !== 'normal') return;
    this.movementEndBar = 0;
  }
}

const PROGRESSIONS = [
  [0, 0, 3, 0],
  [0, 0, 0, 3],
  [0, 3, 0, 4],
  [0, 0, 6, 3],
  [0, 4, 3, 0],
];
