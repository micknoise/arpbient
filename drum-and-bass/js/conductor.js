import { MODES, buildChord, voiceChordOpen, buildArpPool, buildScalePool, pick, randInt, clamp01 } from './theory.js';
import { BassLayer } from './bass.js';
import { LeadLayer } from './lead.js';
import { DrumKit } from './drum.js';

// Drum & bass composer. 16-step grid (16ths), 4/4, one chord per bar.
// Fixed tempo and key per movement.
//
// The character: the classic 2-step break -- kick on 1 and the "and" of 3
// (steps 0 and 10), snare on 2 and 4 (steps 4 and 12) -- over a rolling
// Reese bass (detuned saws with an AM wobble tracking the 16ths) and a
// bright, syncopated liquid top. Sections rotate between full groove,
// drumless breaks (bass + lead floating), and liquid moments (long singing
// notes over a sparse bass).
export class Conductor {
  constructor(audioCore) {
    this.core = audioCore;
    this.ctx = audioCore.ctx;

    this.kit = new DrumKit(this.ctx, audioCore, { reverbAmount: 0.12, delayAmount: 0.06 });
    this.bass = new BassLayer(this.ctx, audioCore, { reverbAmount: 0.1, delayAmount: 0.08 });
    this.lead = new LeadLayer(this.ctx, audioCore, { reverbAmount: 0.4, delayAmount: 0.3 });

    this.root = pick([40, 43, 45, 47, 48]);
    this.mode = this._pickMode();
    this.progression = pick(PROGRESSIONS);
    this.chordIndex = 0;

    this.baseBpm = 174;
    this.bpm = this.baseBpm;
    this.beatsPerBar = 4;
    this.stepsPerBeat = 4;

    this.lookahead = 25;
    this.scheduleAheadTime = 0.15;
    this.nextStepTime = 0;
    this.stepCount = 0;
    this.timerID = null;

    this.macro = {
      liquid: 0.6,
      intensity: 0.45,
      section: 'groove',
    };
    this.sectionUntilBar = 0;

    // Section model: the 2-step stays locked, and a section change is one
    // concert event (bass + arps + lead + hats + rim re-rolled together);
    // within a section the groove builds by adding layers rather than
    // swapping parts on independent timers. The Reese ostinato now holds
    // for the full section (4-8 bars).
    this.sectionBar = 0;
    this.layerGates = {};
    // Bar index whose grid arp is replaced by a polyrhythmic phrase.
    this.polyBar = -1;

    // The signature 2-step break.
    this.kickPat = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
    this.snarePat = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
    this.hatPat = new Array(16).fill(0);
    this.rimPat = new Array(16).fill(0);
    this.bassPat = new Array(16).fill(null);
    this.arpPat = new Array(16).fill(null);
    this.leadPat = new Array(16).fill(null);

    this.chordSemis = [0, 7, 12];
    this.arpPool = [72, 79, 84];
    this.scalePool = [69, 72, 74, 76, 79];

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

  _pickMode() {
    const r = Math.random();
    if (r < 0.55) return 'aeolian';
    if (r < 0.8) return 'dorian';
    if (r < 0.95) return 'major';
    return 'phrygian';
  }

  _stepDuration() {
    return 60 / this.bpm / this.stepsPerBeat;
  }

  // Wobble rate locked to the 16th grid (one AM cycle per 16th).
  _wobbleRate() {
    return this.bpm / 15;
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
    this._applySection('groove');
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

    // Kick + pump (DnB pumps tight and hard)
    const kv = this.kickPat[barStep];
    if (kv > 0) {
      this.kit.playKick(time, { velocity: kv, decay: 0.3, click: 0.45 });
      this.core.pump(time, { depth: 0.5 + this.macro.intensity * 0.25, release: 0.11 });
    }

    const sv = this.snarePat[barStep];
    if (sv > 0) this.kit.playSnare(time, { velocity: sv, noiseFreq: 1900 });

    if (this.hatPat[barStep] > 0 && this._layerOn('hat')) {
      this.kit.playHat(time, {
        velocity: this.hatPat[barStep],
        frequency: 10500,
        decay: 0.028,
        pan: barStep % 4 === 2 ? -0.4 : 0.35,
      });
    }

    if (this.rimPat[barStep] > 0 && this._layerOn('rim')) {
      this.kit.playRim(time, { velocity: this.rimPat[barStep], frequency: 900, pan: -0.3 });
    }

    // Rolling Reese bass
    const b = this.bassPat[barStep];
    if (b) {
      this.bass.playNote(this.root - 12 + b.pc, time, {
        cutoffBase: 700 + this.macro.intensity * 500 + b.vel * 150,
        cutoffFloor: 70,
        q: 7,
        velocity: b.vel,
        decay: b.len,
        wobbleRate: this._wobbleRate(),
        glide: b.glide || 0,
        subLevel: 0.8,
      });
    }

    // Bright syncopated arp (skipped on the polyrhythm bar)
    const a = this.arpPat[barStep];
    if (a && barIndex !== this.polyBar) {
      // noteIdx random-walks in both directions -- wrap negative indices.
      const ni = ((a.noteIdx % this.arpPool.length) + this.arpPool.length) % this.arpPool.length;
      this.lead.pluck(this.arpPool[ni], time, {
        cutoffBase: 2600 + this.macro.intensity * 900,
        velocity: a.vel,
        decay: 0.18 + a.vel * 0.08,
      });
    }

    // Long singing notes (mostly in 'liquid' sections)
    const l = this.leadPat[barStep];
    if (l && barIndex !== this.polyBar) {
      this.lead.note(this.scalePool[l.noteIdx % this.scalePool.length], time, {
        cutoffBase: 2000,
        q: 3,
        velocity: l.vel,
        decay: 1.4,
        vibrato: 0.28,
      });
    }
  }

  _onBar(barIndex, time) {
    if (this.onBar) this.onBar(barIndex);

    // One chord per bar. Bar 0 already has the chord at movement start.
    if (barIndex > 0) this._advanceChord(time);

    // Section rotation: groove (full 2-step) / break (drums off) / liquid
    // (long singing notes, sparse bass). A change is one concert event --
    // the 2-step stays locked while bass + arps + lead + hats + rim re-roll
    // together, the Reese holds for the full section, and hats + rim join
    // as the groove builds.
    if (barIndex > 0 && barIndex >= this.sectionUntilBar) {
      this._applySection(this._pickSection());
      this.sectionUntilBar = barIndex + randInt(4, 8);
    } else if (barIndex > 0) {
      this.sectionBar++;
    }

    // Polyrhythmic lead phrase against the grid.
    if (barIndex > 0 && Math.random() < 0.15) {
      this.polyBar = barIndex;
      this._playPolyPhrase(time);
    }

    // Macro drift
    const target = 0.3 + Math.random() * 0.5;
    this.macro.intensity = clamp01(this.macro.intensity + (target - this.macro.intensity) * 0.4);

    if (barIndex >= this.movementEndBar) {
      this._beginEnding(time);
    }
  }

  // One concert event: re-roll the groove around the locked 2-step (bass +
  // arps + lead + hats + rim + levels) together and reset the in-section
  // build. Break is drumless; the rest builds hats + rim as it goes.
  _applySection(name) {
    this.macro.section = name;
    this.sectionBar = 0;
    this._makeBassPattern();
    this._makeArpPattern();
    this._makeLeadPattern();
    this._makeSectionPatterns(); // 2-step core / drumless break
    if (name !== 'break') {
      this._mutateBreak(); // ghost kick/snare/rim around the locked 2-step
      this._makeHatPattern();
    }
    this._applyLevels();
    this.layerGates =
      name === 'break' ? {} :
      name === 'liquid' ? { hat: 2, rim: 3 } :
      { hat: 1, rim: 1 };
  }

  _pickSection() {
    const r = Math.random();
    return r < 0.5 ? 'groove' : r < 0.75 ? 'break' : 'liquid';
  }

  // A texture layer plays once the section has built far enough.
  _layerOn(name) {
    return this.sectionBar >= (this.layerGates[name] ?? 0);
  }

  _advanceChord(time, silent = false) {
    const degree = this.progression[this.chordIndex % this.progression.length];
    this.chordIndex++;
    this.chordSemis = buildChord(this.mode, degree, { seventh: Math.random() < 0.4, add9: Math.random() < 0.4 });
    this.arpPool = buildArpPool(this.root, this.chordSemis, 12);
    this.scalePool = buildScalePool(this.root, this.mode, { fromOctave: 2, octaves: 2 });
    this.stabNotes = voiceChordOpen(this.root, this.chordSemis);
    if (!silent && this.onChord) {
      this.onChord({ root: this.root, mode: this.mode, degree, midiNotes: this.stabNotes });
    }
  }

  // Rolling Reese patterns: syncopated 16ths with root/third/octave.
  _makeBassPattern() {
    const pat = new Array(16).fill(null);
    const passing = ((this.chordSemis[1] % 12) + 12) % 12;
    const style = pick(['roll', 'roll', 'sync', 'push']);
    if (style === 'roll') {
      [0, 3, 6, 8, 11, 14].forEach((s, i) => {
        pat[s] = { pc: i === 3 ? 12 : i === 5 ? passing : 0, vel: s === 0 ? 0.9 : 0.65, len: 0.16 };
      });
    } else if (style === 'sync') {
      pat[0] = { pc: 0, vel: 0.9, len: 0.2 };
      pat[5] = { pc: passing, vel: 0.55, len: 0.12 };
      pat[8] = { pc: 12, vel: 0.8, len: 0.2 };
      pat[10] = { pc: 0, vel: 0.85, len: 0.18 };
      pat[13] = { pc: 0, vel: 0.6, len: 0.14 };
    } else if (style === 'push') {
      // The DnB "push" -- root, then a run of 16ths climbing.
      pat[0] = { pc: 0, vel: 0.9, len: 0.14 };
      [8, 10, 12, 14].forEach((s, i) => {
        pat[s] = { pc: [0, passing, 12, 12][i], vel: 0.5 + i * 0.06, len: 0.1, glide: 0.06 };
      });
    } else {
      pat[0] = { pc: 0, vel: 0.9, len: 0.3 };
      pat[8] = { pc: passing, vel: 0.75, len: 0.22, glide: 0.12 };
      pat[12] = { pc: 0, vel: 0.85, len: 0.25, glide: 0.15 };
    }
    this.bassPat = pat;
  }

  _makeArpPattern() {
    const pat = new Array(16).fill(null);
    const rest = clamp01(0.5 - this.macro.liquid * 0.45 - this.macro.intensity * 0.15);
    let idx = 0;
    const dir = Math.random() < 0.5 ? 1 : -1;
    for (let s = 0; s < 16; s++) {
      if (Math.random() < rest) continue;
      idx += pick([dir, dir, -dir]);
      pat[s] = { noteIdx: idx, vel: s % 4 === 0 ? 0.38 : 0.24 + Math.random() * 0.16 };
    }
    this.arpPat = pat;
  }

  // Long singing notes -- the liquid top. Sparse by design.
  _makeLeadPattern() {
    const pat = new Array(16).fill(null);
    if (this.macro.section === 'liquid') {
      const spots = pick([[0], [0, 8], [4, 12], [0, 6]]);
      spots.forEach((s, i) => (pat[s] = { noteIdx: i, vel: 0.34 }));
    } else if (Math.random() < 0.35) {
      pat[pick([0, 4, 8, 12])] = { noteIdx: 0, vel: 0.3 };
    }
    this.leadPat = pat;
  }

  // Ghost/fill texture over the locked 2-step.
  _mutateBreak() {
    // Keep the 2-step core; mutate around it.
    const kick = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
    if (Math.random() < 0.3) kick[pick([6, 7, 14])] = 0.5;
    this.kickPat = kick;

    const snare = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
    if (Math.random() < 0.4) snare[pick([3, 7, 11, 15])] = 0.3 + Math.random() * 0.25;
    this.snarePat = snare;

    const rim = new Array(16).fill(0);
    if (Math.random() < 0.5) {
      rim[pick([2, 6, 9, 13])] = 0.2 + Math.random() * 0.2;
    }
    this.rimPat = rim;
  }

  _makeHatPattern() {
    // DnB hats are sparse and open -- mostly offbeat 8ths with the
    // occasional 16th pair.
    const style = pick(['off8', 'off8', 'ghosts', 'pairs']);
    const pat = new Array(16).fill(0);
    if (style === 'off8') {
      [2, 6, 10, 14].forEach((s, i) => (pat[s] = 0.22 + (i % 2 ? 0.1 : 0.16)));
    } else if (style === 'ghosts') {
      [3, 7, 11, 15].forEach((s) => (pat[s] = 0.15 + Math.random() * 0.15));
      pat[2] = 0.3;
      pat[10] = 0.3;
    } else {
      [1, 2, 9, 10, 13, 14].forEach((s, i) => (pat[s] = i % 2 ? 0.28 : 0.18));
    }
    this.hatPat = pat;
  }

  _makeSectionPatterns() {
    const s = this.macro.section;
    if (s === 'break') {
      this.kickPat = new Array(16).fill(0);
      this.snarePat = new Array(16).fill(0);
      this.hatPat = new Array(16).fill(0);
      this.rimPat = new Array(16).fill(0);
    } else if (s === 'liquid') {
      this.kickPat = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
      this.snarePat = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
      this._makeLeadPattern();
    } else {
      this.kickPat = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
      this.snarePat = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
    }
  }

  // Polyrhythmic melody phrase: N evenly-spaced notes over M beats, off grid.
  // Polyrhythmic lead phrase: N evenly-spaced notes over M beats. Notes
  // walk the pool in one direction with an accented head -- a deliberate
  // figure against the grid, not a timing slip.
  _playPolyPhrase(time) {
    const barDur = (4 * 60) / this.bpm;
    const [n, beats] = pick([[3, 2], [5, 4], [7, 4], [5, 2]]);
    const span = beats * (barDur / 4);
    const start = time + (Math.random() < 0.5 ? 0 : barDur / 2);
    const pool = this.scalePool;
    let idx = Math.floor(Math.random() * pool.length);
    const dir = Math.random() < 0.5 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const t = start + (span * i) / n;
      idx += dir * pick([1, 1, 2]);
      this.lead.pluck(pool[((idx % pool.length) + pool.length) % pool.length], t, {
        cutoffBase: 2800,
        velocity: i === 0 ? 0.42 : 0.32,
        decay: 0.3,
      });
    }
  }

  _pickMovementLength() {
    return randInt(32, 48); // ~45s-66s at 174bpm
  }

  _pickNewTempo() {
    return randInt(170, 176);
  }

  _applyLevels() {
    const s = this.macro.section;
    const bassL = s === 'liquid' ? 0.45 : 0.55 + this.macro.intensity * 0.2;
    const leadL = s === 'liquid' ? 0.5 : s === 'break' ? 0.4 : 0.3 + this.macro.intensity * 0.15;
    const drumL = s === 'break' ? 0.5 : 0.9;
    this.bass.setLevel(clamp01(bassL));
    this.lead.setLevel(clamp01(leadL));
    this.kit.setLevel(clamp01(drumL));
    this.kit.setKickLevel(1.0);
  }

  // Ending: tom fill + riser, then the final hit -- kick, sub drop,
  // bright chord stab -- and a sustained liquid chord over a held sub.
  _beginEnding(time) {
    this.phase = 'quiet';
    if (this.onEnding) this.onEnding();

    const barDur = (4 * 60) / this.bpm;
    const stepDur = barDur / 16;

    // Climbing tom fill + riser.
    for (let s = 0; s < 16; s += 2) {
      const i = s / 2;
      this.kit.playTom(time + s * stepDur, { velocity: 0.35 + i * 0.06, startFreq: 80 + i * 24, endFreq: 42 + i * 8 });
    }
    this.kit.playRiser(time, barDur, { peak: 0.5 });
    // Final 2-step pulse under the riser.
    this.kit.playKick(time, { velocity: 0.9, decay: 0.35 });
    this.kit.playKick(time + 10 * stepDur, { velocity: 0.9, decay: 0.35 });
    this.kit.playSnare(time + 4 * stepDur, { velocity: 0.8, noiseFreq: 1800 });
    this.kit.playSnare(time + 12 * stepDur, { velocity: 0.8, noiseFreq: 1800 });

    // Final hit at the bar line.
    const tEnd = time + barDur;
    this.kit.playKick(tEnd, { velocity: 1.2, decay: 0.5 });
    this.kit.playCrash(tEnd, { velocity: 0.7, frequency: 6500 });
    this.core.pump(tEnd, { depth: 0.7, release: 0.4 });
    this.bass.subDrop(this.root - 24, tEnd, { velocity: 1.0 });
    this.bass.playNote(this.root - 12, tEnd, { cutoffBase: 1100, velocity: 0.95, decay: 1.2, wobble: 0.6, wobbleRate: this._wobbleRate() });
    const chord = this.stabNotes.concat(this.stabNotes.map((n) => n + 12));
    chord.forEach((m, i) => {
      this.lead.pluck(m, tEnd + i * 0.02, { cutoffBase: 3000, velocity: 0.4, decay: 0.5 });
    });

    // Sustained liquid chord + held sub.
    const restAttack = 1.6;
    const restHold = 5 + Math.random() * 4;
    this.lead.sustain(this.stabNotes, tEnd + 0.02, { attack: restAttack, hold: restHold, release: 4, cutoffBase: 1800, velocity: 0.28 });
    this.bass.subDrop(this.root - 24, tEnd + 0.02, { attack: 0.8, hold: restHold, release: 3, velocity: 0.6 });

    this.phaseUntil = tEnd + restAttack + restHold + 4 + 1;
  }

  _beginNewMovement(time) {
    this.phase = 'normal';
    this.baseBpm = this.userTempo != null ? this.userTempo : this._pickNewTempo();
    this.bpm = this.baseBpm;
    this.root = pick([40, 43, 45, 47, 48]);
    this.mode = this._pickMode();
    this.progression = pick(PROGRESSIONS);
    this.movementEndBar = this._pickMovementLength();
    this.sectionUntilBar = 0;
    this._initMovement();
    this._syncDelay();
    this.nextStepTime = Math.max(this.nextStepTime, time + 0.05);
    if (this.onMovementStart) this.onMovementStart({ root: this.root, mode: this.mode, bpm: this.bpm });
  }

  // Sync the shared delay to the tempo (one beat -- classic liquid spacing).
  _syncDelay() {
    this.core.setDelayTime(60 / this.bpm);
  }

  // Target tempo only -- applied at the next movement boundary (or on the
  // next start), never mid-movement.
  setTempo(bpm) {
    this.userTempo = bpm;
  }

  setReese(v) {
    this.bass.setReese(clamp01(v));
  }

  setLiquid(v) {
    this.macro.liquid = clamp01(v);
    this._makeArpPattern();
    this._makeLeadPattern();
  }

  triggerEnding() {
    if (this.phase !== 'normal') return;
    this.movementEndBar = 0;
  }
}

const PROGRESSIONS = [
  [0, 0, 3, 0],
  [0, 0, 0, 6],
  [0, 3, 0, 4],
  [0, 0, 6, 3],
];
