import { MODES, buildChord, voiceChordOpen, buildArpPool, pick, randInt, clamp01 } from './theory.js';
import { BassLayer } from './bass.js';
import { LeadLayer } from './lead.js';
import { DrumKit } from './drum.js';

// Glitchcore composer. 16-step grid (16ths), 4/4, one chord per bar. Fixed
// tempo and key per movement.
//
// The character: fast breakbeat chaos -- heavily mutated 16th drum patterns
// (snare ghosts, kick pickups, rim blips), a punchy syncopated bass, and a
// square "stutter" lead: the same note fired in scheduled micro-repeats,
// with random octave jumps. Sections rotate between drum chaos, builds,
// full detonation, and drumless "holds" where the stutters float. The
// Stutter slider controls how often the glitch repeats fire; Breaks
// controls drum density.
export class Conductor {
  constructor(audioCore) {
    this.core = audioCore;
    this.ctx = audioCore.ctx;

    this.kit = new DrumKit(this.ctx, audioCore, { reverbAmount: 0.1, delayAmount: 0.05 });
    this.bass = new BassLayer(this.ctx, audioCore, { reverbAmount: 0.06, delayAmount: 0.08 });
    this.lead = new LeadLayer(this.ctx, audioCore, { reverbAmount: 0.3, delayAmount: 0.25 });

    this.root = pick([40, 43, 45, 47, 48]);
    this.mode = this._pickMode();
    this.progression = pick(PROGRESSIONS);
    this.chordIndex = 0;

    this.baseBpm = 150;
    this.bpm = this.baseBpm;
    this.beatsPerBar = 4;
    this.stepsPerBeat = 4;

    this.lookahead = 25;
    this.scheduleAheadTime = 0.15;
    this.nextStepTime = 0;
    this.stepCount = 0;
    this.timerID = null;

    this.macro = {
      stutter: 0.5,
      breaks: 0.6,
      intensity: 0.5,
      section: 'chop',
    };
    this.sectionUntilBar = 0;

    // Punchy bass ostinato held 4-8 bars before it re-syncopates.
    this.bassHoldBars = randInt(4, 8);
    // Bar index whose grid arp is replaced by a polyrhythmic phrase.
    this.polyBar = -1;

    this.kickPat = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
    this.snarePat = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
    this.hatPat = new Array(16).fill(0);
    this.rimPat = new Array(16).fill(0);
    this.bassPat = new Array(16).fill(null);
    this.arpPat = new Array(16).fill(null);
    this.stabPat = new Array(16).fill(0);
    this.leadPat = new Array(16).fill(null);

    this.chordSemis = [0, 7, 12];
    this.arpPool = [72, 79, 84];

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
    if (r < 0.6) return 'aeolian';
    if (r < 0.9) return 'phrygian';
    return 'dorian';
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
    this._mutateDrums();
    this._makeStabPattern();
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

    // Kick + pump (glitchcore pumps hard)
    const kv = this.kickPat[barStep];
    if (kv > 0) {
      this.kit.playKick(time, { velocity: kv, decay: 0.28, click: 0.5 });
      this.core.pump(time, { depth: 0.45 + this.macro.intensity * 0.25, release: 0.12 });
    }

    const sv = this.snarePat[barStep];
    if (sv > 0) this.kit.playSnare(time, { velocity: sv, noiseFreq: 1600 });

    const hv = this.hatPat[barStep];
    if (hv > 0) {
      const glitch = Math.random() < this.macro.stutter * 0.3;
      this.kit.playHat(time, {
        velocity: hv,
        frequency: glitch ? 3500 + Math.random() * 9000 : 10000,
        decay: glitch ? 0.015 : 0.025,
        pan: barStep % 2 === 0 ? -0.5 : 0.4,
        rate: glitch ? 0.6 + Math.random() * 1.4 : 1.0,
      });
    }

    if (this.rimPat[barStep] > 0) {
      this.kit.playRim(time, { velocity: this.rimPat[barStep], frequency: pick([700, 1000, 1400]), pan: -0.4 });
    }

    // Punchy syncopated bass
    const b = this.bassPat[barStep];
    if (b) {
      this.bass.playNote(this.root - 12 + b.pc, time, {
        cutoffBase: 1200 + this.macro.intensity * 600,
        cutoffFloor: 90,
        q: 8,
        velocity: b.vel,
        decay: b.len,
        glide: b.glide || 0,
        bend: Math.random() < 0.25 ? 0.05 : 0,
        subLevel: 0.7,
      });
    }

    // Stutter lead -- blips that sometimes fire as micro-repeats.
    const a = this.arpPat[barStep];
    if (a && barIndex !== this.polyBar) {
      let midi = this.arpPool[a.noteIdx % this.arpPool.length];
      if (Math.random() < this.macro.stutter * 0.12) midi += pick([12, -12, 19, -5]);
      if (Math.random() < this.macro.stutter * 0.3) {
        this.lead.stutter(midi, time, {
          repeats: randInt(2, 4),
          cutoffBase: 3000 + this.macro.intensity * 800,
          velocity: a.vel,
          decay: 0.07,
        });
      } else {
        this.lead.blip(midi, time, {
          cutoffBase: 3000 + this.macro.intensity * 800,
          velocity: a.vel,
          decay: 0.07,
        });
      }
    }

    // Detuned stab chords
    const sp = this.stabPat[barStep];
    if (sp > 0) {
      this.lead.stab(this.stabNotes, time, {
        cutoffBase: 2600 + this.macro.intensity * 900,
        velocity: sp * 0.5,
        decay: 0.12,
      });
    }

    // Rare long tone (a breath in the chaos)
    const l = this.leadPat[barStep];
    if (l && barIndex !== this.polyBar) {
      this.lead.note(pick(this.arpPool) + 12, time, {
        cutoffBase: 2000,
        q: 4,
        velocity: l.vel,
        decay: 1.2,
        vibrato: 0.3,
      });
    }
  }

  _onBar(barIndex, time) {
    if (this.onBar) this.onBar(barIndex);

    // One chord per bar. Bar 0 already has the chord at movement start.
    if (barIndex > 0) this._advanceChord(time);

    // Section rotation: chop (drum chaos) / build / detonate (full) /
    // hold (drums off, stutters float).
    if (barIndex >= this.sectionUntilBar && barIndex > 0) {
      const r = Math.random();
      this.macro.section = r < 0.4 ? 'chop' : r < 0.65 ? 'build' : r < 0.85 ? 'detonate' : 'hold';
      this.sectionUntilBar = barIndex + randInt(4, 8);
      this._makeSectionPatterns();
      this._applyLevels();
    }

    // Drums mutate a LOT -- that's the breakcore fluidity. Bass holds 4-8
    // bars (the anchor), arps/stabs re-roll.
    if (Math.random() < 0.5) this._mutateDrums();
    if (Math.random() < 0.6) this._makeArpPattern();
    if (Math.random() < 0.4) this._makeStabPattern();
    if (Math.random() < 0.3) this._makeHatPattern();
    this.bassHoldBars--;
    if (this.bassHoldBars <= 0) {
      this._makeBassPattern();
      this.bassHoldBars = randInt(4, 8);
    }

    // Polyrhythmic stutter phrase against the grid.
    if (barIndex > 0 && Math.random() < 0.16) {
      this.polyBar = barIndex;
      this._playPolyPhrase(time);
    }

    // Macro drift
    const target = 0.3 + Math.random() * 0.6;
    this.macro.intensity = clamp01(this.macro.intensity + (target - this.macro.intensity) * 0.4);

    if (barIndex >= this.movementEndBar) {
      this._beginEnding(time);
    }
  }

  _advanceChord(time, silent = false) {
    const degree = this.progression[this.chordIndex % this.progression.length];
    this.chordIndex++;
    this.chordSemis = buildChord(this.mode, degree, { seventh: Math.random() < 0.5, add9: Math.random() < 0.4 });
    this.arpPool = buildArpPool(this.root, this.chordSemis, 12);
    this.stabNotes = voiceChordOpen(this.root, this.chordSemis);
    if (!silent && this.onChord) {
      this.onChord({ root: this.root, mode: this.mode, degree, midiNotes: this.stabNotes });
    }
  }

  _makeBassPattern() {
    const pat = new Array(16).fill(null);
    const passing = ((this.chordSemis[1] % 12) + 12) % 12;
    const style = pick(['punch', 'punch', 'sync', 'glide']);
    if (style === 'punch') {
      [0, 8].forEach((s, i) => (pat[s] = { pc: 0, vel: i ? 0.75 : 0.95, len: 0.12 }));
      pat[11] = { pc: passing, vel: 0.55, len: 0.1 };
      if (Math.random() < 0.5) pat[14] = { pc: 0, vel: 0.5, len: 0.08 };
    } else if (style === 'sync') {
      pat[0] = { pc: 0, vel: 0.9, len: 0.12 };
      pat[5] = { pc: 0, vel: 0.5, len: 0.08 };
      pat[8] = { pc: 12, vel: 0.8, len: 0.12 };
      pat[10] = { pc: passing, vel: 0.6, len: 0.1 };
      pat[13] = { pc: 0, vel: 0.7, len: 0.12 };
    } else if (style === 'glide') {
      pat[0] = { pc: 0, vel: 0.9, len: 0.16 };
      pat[6] = { pc: passing, vel: 0.6, len: 0.12, glide: 0.1 };
      pat[8] = { pc: 12, vel: 0.8, len: 0.16, glide: 0.12 };
      pat[12] = { pc: 0, vel: 0.85, len: 0.18, glide: 0.15 };
    } else {
      [0, 3, 8, 11].forEach((s, i) => {
        pat[s] = { pc: i % 2 ? 0 : passing, vel: 0.75, len: 0.09 };
      });
    }
    this.bassPat = pat;
  }

  // Fast 16th blip arp with rests and octave pops.
  _makeArpPattern() {
    const pat = new Array(16).fill(null);
    const rest = clamp01(0.6 - this.macro.breaks * 0.45);
    let idx = 0;
    const dir = Math.random() < 0.5 ? 1 : -1;
    for (let s = 0; s < 16; s++) {
      if (Math.random() < rest) continue;
      idx += pick([dir, dir, -dir]);
      const vel = s % 4 === 0 ? 0.4 : 0.26 + Math.random() * 0.16;
      pat[s] = { noteIdx: idx, vel: Math.random() < 0.08 ? vel * 1.5 : vel };
    }
    this.arpPat = pat;
    // Rare long tone, mostly in 'hold' sections.
    this.leadPat = new Array(16).fill(null);
    if (this.macro.section === 'hold' && Math.random() < 0.6) {
      this.leadPat[pick([0, 4, 8])] = { noteIdx: 0, vel: 0.3 };
    }
  }

  // Aggressive drum mutation -- extra snare ghosts, kick pickups, rim blips.
  _mutateDrums() {
    const density = this.macro.breaks;
    // Kick: base 1+3 with random pickups/extra 16ths.
    const kick = new Array(16).fill(0);
    kick[0] = 1;
    kick[8] = 0.9;
    if (Math.random() < 0.4 + density * 0.3) kick[pick([6, 7, 10, 14, 15])] = 0.55;
    if (Math.random() < 0.25 * density) kick[pick([3, 5, 11])] = 0.45;
    this.kickPat = kick;

    // Snare: 2+4 with ghost notes sprinkled on off-grid steps.
    const snare = new Array(16).fill(0);
    snare[4] = 1;
    snare[12] = 0.95;
    const ghosts = randInt(0, Math.round(3 + density * 4));
    for (let i = 0; i < ghosts; i++) {
      snare[pick([1, 2, 6, 7, 9, 10, 13, 14, 15])] = 0.3 + Math.random() * 0.3;
    }
    this.snarePat = snare;

    // Rim blips.
    const rim = new Array(16).fill(0);
    const rims = randInt(0, Math.round(2 + density * 4));
    for (let i = 0; i < rims; i++) {
      rim[pick([1, 3, 5, 7, 9, 11, 13, 15])] = 0.2 + Math.random() * 0.3;
    }
    this.rimPat = rim;
  }

  _makeHatPattern() {
    const pat = new Array(16).fill(0);
    const style = pick(['16', '16', 'ghosts', 'sync']);
    if (style === '16') {
      for (let s = 0; s < 16; s++) {
        if (s % 8 === 7 && Math.random() < 0.4) continue;
        pat[s] = s % 4 === 0 ? 0.35 : 0.2 + Math.random() * 0.12;
      }
    } else if (style === 'ghosts') {
      [1, 3, 6, 9, 11, 14].forEach((s) => (pat[s] = 0.15 + Math.random() * 0.25));
    } else {
      [0, 2, 4, 6, 8, 10, 12, 14].forEach((s, i) => (pat[s] = i % 2 ? 0.25 : 0.4));
    }
    this.hatPat = pat;
  }

  _makeStabPattern() {
    const pat = new Array(16).fill(0);
    const style = pick(['off', 'off', 'sync', 'double']);
    if (style === 'sync') {
      [3, 10].forEach((s) => (pat[s] = 0.4 + Math.random() * 0.25));
      if (Math.random() < 0.4) pat[13] = 0.35;
    } else if (style === 'double') {
      pat[0] = 0.55;
      pat[8] = 0.5;
      pat[15] = 0.3;
    }
    this.stabPat = pat;
  }

  _makeSectionPatterns() {
    const s = this.macro.section;
    if (s === 'hold') {
      this.kickPat = new Array(16).fill(0);
      this.snarePat = new Array(16).fill(0);
    } else if (s === 'build') {
      this.kickPat = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
      this.snarePat = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
      this.snarePat[7] = 0.5;
      this.snarePat[15] = 0.5;
    } else {
      this._mutateDrums();
    }
  }

  // Polyrhythmic stutter phrase: N blips over M beats, off the grid.
  _playPolyPhrase(time) {
    const barDur = (4 * 60) / this.bpm;
    const [n, beats] = pick([[3, 2], [5, 4], [7, 4], [5, 2]]);
    const span = beats * (barDur / 4);
    const start = time + (Math.random() < 0.5 ? 0 : barDur / 2);
    for (let i = 0; i < n; i++) {
      const t = start + (span * i) / n;
      if (Math.random() < this.macro.stutter * 0.5) {
        this.lead.stutter(pick(this.arpPool), t, { repeats: 3, velocity: 0.4, decay: 0.06 });
      } else {
        this.lead.blip(pick(this.arpPool), t, { velocity: 0.38, decay: 0.08 });
      }
    }
  }

  _pickMovementLength() {
    return randInt(28, 44); // ~45s-70s at hardcore tempos
  }

  _pickNewTempo() {
    return randInt(142, 168);
  }

  _applyLevels() {
    const s = this.macro.section;
    const bassL = s === 'hold' ? 0.55 : 0.5 + this.macro.intensity * 0.2;
    const leadL = s === 'hold' ? 0.45 : s === 'detonate' ? 0.5 : 0.35 + this.macro.intensity * 0.15;
    const drumL = s === 'hold' ? 0.5 : s === 'detonate' ? 1.0 : 0.9;
    this.bass.setLevel(clamp01(bassL));
    this.lead.setLevel(clamp01(leadL));
    this.kit.setLevel(clamp01(drumL));
    this.kit.setKickLevel(1.0);
  }

  // Ending: tom fill, riser, then a detonation hit -- sub drop, kick,
  // stab cluster, crash -- and an abrupt cut to a lone sustained chord.
  // Glitchcore endings end HARD, not long.
  _beginEnding(time) {
    this.phase = 'quiet';
    if (this.onEnding) this.onEnding();

    const barDur = (4 * 60) / this.bpm;
    const stepDur = barDur / 16;

    // Rising tom fill + riser.
    for (let s = 0; s < 16; s += 2) {
      const i = s / 2;
      this.kit.playTom(time + s * stepDur, { velocity: 0.35 + i * 0.06, startFreq: 80 + i * 25, endFreq: 40 + i * 10 });
    }
    this.kit.playRiser(time, barDur, { peak: 0.5 });

    // Detonation at the bar line.
    const tEnd = time + barDur;
    this.kit.playKick(tEnd, { velocity: 1.2, decay: 0.5 });
    this.kit.playCrash(tEnd, { velocity: 0.8, frequency: 7000 });
    this.core.pump(tEnd, { depth: 0.75, release: 0.35 });
    this.bass.subDrop(this.root - 24, tEnd, { velocity: 1.0 });
    this.bass.playNote(this.root - 12, tEnd, { cutoffBase: 2000, velocity: 0.95, decay: 0.8, bend: 0.12 });
    const cluster = this.arpPool.slice(0, 5);
    cluster.forEach((m, i) => {
      this.lead.blip(m + (i % 2 ? 12 : 0), tEnd + i * 0.025, { cutoffBase: 3400, velocity: 0.5, decay: 0.2 });
    });
    this.lead.stab(this.stabNotes, tEnd, { cutoffBase: 3000, velocity: 0.55, decay: 0.25 });

    // Abrupt: lone chord, short tail, then the next movement slams in.
    const restHold = 3 + Math.random() * 2;
    this.lead.sustain(this.stabNotes, tEnd + 0.05, { attack: 0.4, hold: restHold, release: 2.5, cutoffBase: 2400, velocity: 0.25 });

    this.phaseUntil = tEnd + restHold + 2.5 + 1;
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

  // Sync the shared delay to the tempo (a 16th -- tight trails).
  _syncDelay() {
    this.core.setDelayTime(60 / this.bpm / 4);
  }

  // Target tempo only -- applied at the next movement boundary (or on the
  // next start), never mid-movement.
  setTempo(bpm) {
    this.userTempo = bpm;
  }

  setStutter(v) {
    this.macro.stutter = clamp01(v);
  }

  setBreaks(v) {
    this.macro.breaks = clamp01(v);
    this._mutateDrums();
  }

  triggerEnding() {
    if (this.phase !== 'normal') return;
    this.movementEndBar = 0;
  }
}

const PROGRESSIONS = [
  [0, 0, 3, 0],
  [0, 0, 0, 6],
  [0, 3, 0, 6],
  [0, 0, 6, 3],
];
