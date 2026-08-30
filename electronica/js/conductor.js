import { MODES, buildChord, voiceChordOpen, buildArpPool, buildScalePool, pick, randInt, clamp01 } from './theory.js';
import { BassLayer } from './bass.js';
import { LeadLayer } from './lead.js';
import { DrumKit } from './drum.js';

// Electronica (IDM) composer. 16-step grid (16ths), 4/4, one chord per bar.
// Fixed tempo and key per movement.
//
// The character: dense 16th "noodle" arpeggios that mutate every bar
// (arps are deliberately fluid -- unlike the bass, which holds its phrase
// for 4-8 bars), a gliding syncopated bass, hat patterns with random
// pitched glitches, and sections that rotate between drum-driven noodle,
// drumless break (arps + bass floating), and sparse groove. The Glitch
// slider adds octave jumps, micro-stutters, and hat rate wobbles.
export class Conductor {
  constructor(audioCore) {
    this.core = audioCore;
    this.ctx = audioCore.ctx;

    this.kit = new DrumKit(this.ctx, audioCore, { reverbAmount: 0.1, delayAmount: 0.06 });
    this.bass = new BassLayer(this.ctx, audioCore, { reverbAmount: 0.1, delayAmount: 0.12 });
    this.lead = new LeadLayer(this.ctx, audioCore, { reverbAmount: 0.35, delayAmount: 0.3 });

    this.root = pick([40, 43, 45, 47, 48]);
    this.mode = this._pickMode();
    this.progression = pick(PROGRESSIONS);
    this.chordIndex = 0;

    this.baseBpm = 118;
    this.bpm = this.baseBpm;
    this.beatsPerBar = 4;
    this.stepsPerBeat = 4;

    this.lookahead = 25;
    this.scheduleAheadTime = 0.15;
    this.nextStepTime = 0;
    this.stepCount = 0;
    this.timerID = null;

    this.macro = {
      density: 0.6,
      glitch: 0.4,
      intensity: 0.4,
      section: 'noodle',
    };
    this.sectionUntilBar = 0;

    // Noodle bass ostinato held 4-8 bars before it re-glides.
    this.bassHoldBars = randInt(4, 8);
    // Bar index whose grid arp is replaced by a polyrhythmic phrase.
    this.polyBar = -1;

    this.kickPat = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
    this.hatPat = new Array(16).fill(0);
    this.rimPat = new Array(16).fill(0);
    this.bassPat = new Array(16).fill(null);
    this.arpPat = new Array(16).fill(null);

    this.chordSemis = [0, 7, 12];
    this.arpPool = [72, 79, 84];
    this.scalePool = [69, 72, 74, 76, 79, 81];

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
    if (r < 0.5) return 'aeolian';
    if (r < 0.75) return 'phrygian';
    if (r < 0.9) return 'dorian';
    return 'major';
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
    this._makeBassPattern();
    this._makeArpPattern();
    this._makeHatPattern();
    this._makeSectionPatterns();
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

    // Kick + pump
    const kv = this.kickPat[barStep];
    if (kv > 0) {
      this.kit.playKick(time, { velocity: kv, decay: 0.3, click: 0.4 });
      this.core.pump(time, { depth: 0.4 + this.macro.intensity * 0.25, release: 0.16 });
    }

    // Hats -- the glitch slider wobbles the pitch of random hits.
    const hv = this.hatPat[barStep];
    if (hv > 0) {
      const glitch = Math.random() < this.macro.glitch * 0.3;
      this.kit.playHat(time, {
        velocity: hv,
        frequency: glitch ? 4000 + Math.random() * 9000 : 9500,
        decay: glitch ? 0.02 : 0.03,
        pan: (barStep % 4) === 0 ? -0.4 : 0.35,
        rate: glitch ? 0.7 + Math.random() * 1.2 : 1.0,
      });
    }

    if (this.rimPat[barStep] > 0) {
      this.kit.playRim(time, { velocity: this.rimPat[barStep], frequency: pick([700, 900, 1200]), pan: -0.3 });
    }

    // Noodle bass
    const b = this.bassPat[barStep];
    if (b) {
      this.bass.playNote(this.root - 12 + b.pc, time, {
        cutoffBase: 900 + this.macro.intensity * 700,
        cutoffFloor: 120,
        q: 6,
        velocity: b.vel,
        decay: b.len,
        glide: b.glide || 0,
        bend: Math.random() < 0.3 ? 0.04 + Math.random() * 0.06 : 0,
        subLevel: 0.4,
      });
    }

    // Dense 16th arps (skipped on the polyrhythm bar).
    const a = this.arpPat[barStep];
    if (a && barIndex !== this.polyBar) {
      const pool = this.arpPool;
      let midi = pool[a.noteIdx % pool.length];
      // Glitch: occasional octave jump.
      if (Math.random() < this.macro.glitch * 0.1) midi += pick([12, -12, 19]);
      this.lead.pluck(midi, time, {
        cutoffBase: 2400 + this.macro.intensity * 1200,
        cutoffFloor: 300,
        q: 4,
        velocity: a.vel,
        decay: 0.09 + a.vel * 0.05,
        repeat: this.macro.glitch,
      });
    }

    // Sparse long tone (break section mostly).
    const l = this.leadPat[barStep];
    if (l && barIndex !== this.polyBar) {
      this.lead.note(this.scalePool[l.noteIdx % this.scalePool.length], time, {
        cutoffBase: 1600 + this.macro.intensity * 800,
        q: 3,
        velocity: l.vel,
        decay: 0.9,
        vibrato: 0.25,
      });
    }
  }

  _onBar(barIndex, time) {
    if (this.onBar) this.onBar(barIndex);

    // One chord per bar. Bar 0 already has the chord at movement start.
    if (barIndex > 0) this._advanceChord(time);

    // Section rotation: noodle (drum-driven) / break (no kick) / groove
    // (sparse, bass-forward).
    if (barIndex >= this.sectionUntilBar && barIndex > 0) {
      const r = Math.random();
      this.macro.section = r < 0.5 ? 'noodle' : r < 0.75 ? 'break' : 'groove';
      this.sectionUntilBar = barIndex + randInt(4, 8);
      this._makeSectionPatterns();
      this._applyLevels();
    }

    // Arps mutate every bar -- that's the IDM texture. Bass holds 4-8 bars.
    if (Math.random() < 0.85) this._makeArpPattern();
    if (Math.random() < 0.3) this._makeHatPattern();
    this.bassHoldBars--;
    if (this.bassHoldBars <= 0) {
      this._makeBassPattern();
      this.bassHoldBars = randInt(4, 8);
    }

    // Polyrhythmic arp phrase (3-against-2, 5-against-4, ...) against the grid.
    if (barIndex > 0 && Math.random() < 0.18) {
      this.polyBar = barIndex;
      this._playPolyPhrase(time);
    }

    // Macro drift
    const target = 0.25 + Math.random() * 0.55;
    this.macro.intensity = clamp01(this.macro.intensity + (target - this.macro.intensity) * 0.4);

    if (barIndex >= this.movementEndBar) {
      this._beginEnding(time);
    }
  }

  _advanceChord(time, silent = false) {
    const degree = this.progression[this.chordIndex % this.progression.length];
    this.chordIndex++;
    this.chordSemis = buildChord(this.mode, degree, { seventh: Math.random() < 0.5, add9: Math.random() < 0.5 });
    this.arpPool = buildArpPool(this.root, this.chordSemis, 12);
    this.scalePool = buildScalePool(this.root, this.mode, { fromOctave: 2, octaves: 2 });
    this.stabNotes = voiceChordOpen(this.root, this.chordSemis);
    if (!silent && this.onChord) {
      this.onChord({ root: this.root, mode: this.mode, degree, midiNotes: this.stabNotes });
    }
  }

  // Noodle bass: syncopated gliding phrase. Glide values give the
  // "portamento between hits" feel.
  _makeBassPattern() {
    const pat = new Array(16).fill(null);
    const style = pick(['slide', 'slide', 'sync', 'staccato']);
    const passing = ((this.chordSemis[1] % 12) + 12) % 12;
    if (style === 'slide') {
      pat[0] = { pc: 0, vel: 0.85, len: 0.18, glide: 0 };
      pat[4] = { pc: 0, vel: 0.6, len: 0.14, glide: 0.08 };
      pat[8] = { pc: passing, vel: 0.7, len: 0.2, glide: 0.12 };
      pat[12] = { pc: 0, vel: 0.8, len: 0.22, glide: 0.15 };
    } else if (style === 'sync') {
      pat[0] = { pc: 0, vel: 0.85, len: 0.16 };
      pat[6] = { pc: 0, vel: 0.55, len: 0.12, glide: 0.06 };
      pat[8] = { pc: 12, vel: 0.75, len: 0.18, glide: 0.1 };
      pat[11] = { pc: passing, vel: 0.5, len: 0.14 };
      pat[14] = { pc: 0, vel: 0.7, len: 0.16, glide: 0.08 };
    } else if (style === 'staccato') {
      [0, 2, 8, 10].forEach((s, i) => {
        pat[s] = { pc: i % 2 ? passing : 0, vel: 0.7, len: 0.09 };
      });
      pat[14] = { pc: 12, vel: 0.5, len: 0.08 };
    } else {
      pat[0] = { pc: 0, vel: 0.9, len: 0.3 };
      pat[8] = { pc: passing, vel: 0.75, len: 0.25, glide: 0.2 };
      pat[12] = { pc: 0, vel: 0.7, len: 0.2, glide: 0.15 };
    }
    this.bassPat = pat;
  }

  // Dense 16th arp with rests -- the signature IDM noodle.
  _makeArpPattern() {
    const pat = new Array(16).fill(null);
    const rest = clamp01(0.55 - this.macro.density * 0.5);
    let idx = 0;
    const dir0 = Math.random() < 0.5 ? 1 : -1;
    for (let s = 0; s < 16; s++) {
      if (Math.random() < rest) continue;
      idx += pick([dir0, dir0, -dir0, dir0 * 2]);
      // Accent the beat, plus occasional octave pop.
      const vel = s % 4 === 0 ? 0.42 : 0.24 + Math.random() * 0.18;
      pat[s] = { noteIdx: idx, vel: Math.random() < 0.06 ? vel * 1.4 : vel };
    }
    this.arpPat = pat;
  }

  _makeHatPattern() {
    const style = pick(['16rest', '16rest', 'ghosts', 'sync']);
    const pat = new Array(16).fill(0);
    const rim = new Array(16).fill(0);
    if (style === '16rest') {
      for (let s = 0; s < 16; s++) {
        if (s % 4 === 3 && Math.random() < 0.5) continue;
        pat[s] = s % 2 === 0 ? 0.3 : 0.18 + Math.random() * 0.12;
      }
    } else if (style === 'ghosts') {
      [1, 3, 6, 9, 11, 14, 15].forEach((s) => (pat[s] = 0.15 + Math.random() * 0.25));
      if (Math.random() < 0.6) [5, 13].forEach((s) => (rim[s] = 0.25 + Math.random() * 0.2));
    } else {
      [2, 6, 10, 14].forEach((s) => (pat[s] = 0.4));
      pat[0] = 0.3;
      rim[7] = 0.3;
      if (Math.random() < 0.5) rim[15] = 0.25;
    }
    this.hatPat = pat;
    this.rimPat = rim;
  }

  _makeSectionPatterns() {
    const s = this.macro.section;
    if (s === 'noodle') {
      this.kickPat = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
      if (Math.random() < 0.4) this.kickPat[10] = 0.55;
      this.leadPat = new Array(16).fill(null);
    } else if (s === 'break') {
      this.kickPat = new Array(16).fill(0);
      this.leadPat = new Array(16).fill(null);
      // One or two floating long tones per bar.
      const spots = pick([[0], [4], [0, 8]]);
      spots.forEach((s2, i) => {
        this.leadPat[s2] = { noteIdx: i, vel: 0.3 };
      });
    } else {
      this.kickPat = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
      this.leadPat = new Array(16).fill(null);
    }
  }

  // Polyrhythmic arp phrase: N evenly-spaced notes over M beats, off grid.
  _playPolyPhrase(time) {
    const barDur = (4 * 60) / this.bpm;
    const [n, beats] = pick([[3, 2], [5, 4], [7, 4], [5, 2]]);
    const span = beats * (barDur / 4);
    const start = time + (Math.random() < 0.5 ? 0 : barDur / 2);
    for (let i = 0; i < n; i++) {
      const t = start + (span * i) / n;
      this.lead.pluck(pick(this.arpPool), t, {
        cutoffBase: 2800,
        cutoffFloor: 300,
        q: 5,
        velocity: 0.4,
        decay: 0.14,
        repeat: this.macro.glitch,
      });
    }
  }

  _pickMovementLength() {
    return randInt(24, 40); // ~50s-90s at electronica tempos
  }

  _pickNewTempo() {
    return randInt(108, 128);
  }

  _applyLevels() {
    const s = this.macro.section;
    const bassL = s === 'groove' ? 0.65 : s === 'break' ? 0.5 : 0.45 + this.macro.intensity * 0.15;
    const leadL = s === 'break' ? 0.45 : 0.3 + this.macro.intensity * 0.15;
    const drumL = s === 'break' ? 0.65 : 0.85;
    this.bass.setLevel(clamp01(bassL));
    this.lead.setLevel(clamp01(leadL));
    this.kit.setLevel(clamp01(drumL));
    this.kit.setKickLevel(0.95);
  }

  // Ending: tom fill, riser, a final hit with a pluck cluster, then a
  // lone sustained chord over a low bed.
  _beginEnding(time) {
    this.phase = 'quiet';
    if (this.onEnding) this.onEnding();

    const barDur = (4 * 60) / this.bpm;
    const stepDur = barDur / 16;

    // Tom fill climbing into the bar line.
    [0, 2, 4, 6, 8, 10, 12, 14].forEach((s, i) => {
      this.kit.playTom(time + s * stepDur, { velocity: 0.4 + i * 0.05, startFreq: 90 + i * 22, endFreq: 45 + i * 8 });
    });
    this.kit.playRiser(time, barDur, { peak: 0.45 });
    // A few last arp notes, thinning out.
    for (let s = 0; s < 16; s += 2) {
      this.lead.pluck(pick(this.arpPool), time + s * stepDur, { cutoffBase: 2600, q: 4, velocity: 0.3, decay: 0.1, repeat: this.macro.glitch });
    }

    // Final hit at the bar line.
    const tEnd = time + barDur;
    this.kit.playKick(tEnd, { velocity: 1.1, decay: 0.5 });
    this.kit.playCrash(tEnd, { velocity: 0.7 });
    this.core.pump(tEnd, { depth: 0.65, release: 0.4 });
    this.bass.playNote(this.root - 12, tEnd, { cutoffBase: 1400, velocity: 0.9, decay: 1.2, bend: 0.1 });
    const cluster = this.arpPool.slice(0, 4);
    cluster.forEach((m, i) => {
      this.lead.pluck(m + (i % 2 ? 12 : 0), tEnd + i * 0.03, { cutoffBase: 3000, q: 5, velocity: 0.5, decay: 0.3 });
    });

    // Lone sustained chord + low bed.
    const restAttack = 1.6;
    const restHold = 5 + Math.random() * 4;
    this.lead.sustain(this.stabNotes, tEnd + 0.02, { attack: restAttack, hold: restHold, release: 4, cutoffBase: 1800, velocity: 0.3 });
    this.bass.sustain(this.root - 24, tEnd + 0.02, { attack: 0.6, hold: restHold, release: 3, cutoffBase: 400, velocity: 0.45 });

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

  // Sync the shared delay to the tempo (a 16th, so echo trails stay tight).
  _syncDelay() {
    this.core.setDelayTime(60 / this.bpm / 4);
  }

  // Target tempo only -- applied at the next movement boundary (or on the
  // next start), never mid-movement.
  setTempo(bpm) {
    this.userTempo = bpm;
  }

  setDensity(v) {
    this.macro.density = clamp01(v);
    this._makeArpPattern();
  }

  setGlitch(v) {
    this.macro.glitch = clamp01(v);
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
