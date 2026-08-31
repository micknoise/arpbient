import { MODES, buildChord, voiceChordOpen, buildArpPool, buildLeadPool, pick, randInt, clamp01 } from './theory.js';
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
    this.tempoMin = 140;   // slider bounds -- tempo rolls live within these
    this.tempoMax = 170;
    this._delayBeats = 1;  // BPM-locked delay spacing (re-rolled per movement)
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

    // Section model: a change is one concert event (drums + bass + arps +
    // hats + stabs re-rolled together); within a section the groove builds
    // by adding texture layers rather than swapping parts on independent
    // timers. The bass now holds for the full section (4-8 bars).
    this.sectionBar = 0;
    this.layerGates = {};
    // Section-long polyrhythmic top voice (see _pickPoly): a dotted-division
    // sequence loop that plays in place of the grid arp for the whole
    // section and resets every four bars.
    this.poly = false;
    this.polyDiv = 3;
    this.polyNotesPerBar = 6;
    this.polySeq = [];

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
    // Seed the chord-aware pools so the pattern builders stay safe to call
    // from a slider before the first chord has advanced.
    this.melodyPool = [72, 79, 84];
    this.stabNotes = [60, 67, 72];

    this.phase = 'normal';
    this.phaseUntil = 0;
    this.movementEndBar = this._pickMovementLength();

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
    // Play always begins a fresh movement: a new key, a new tempo (rolled
    // within the slider range), new patterns -- never a replay of the last.
    this._rollMovement();
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
    this._advanceChord(this.ctx.currentTime, true);
    this._applySection('chop');
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

    if (this.rimPat[barStep] > 0 && this._layerOn('rim')) {
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

    // Stutter lead -- blips that sometimes fire as micro-repeats. In a poly
    // section the arp is instead a section-long dotted-division loop
    // (see _pickPoly) that holds for the whole section and resets every
    // four bars.
    if (this.poly) {
      if (barStep % this.polyDiv === 0) {
        const noteInBar = barStep / this.polyDiv;
        const barInCycle = barIndex % 4;
        const seqIdx = (barInCycle * this.polyNotesPerBar + noteInBar) % this.polySeq.length;
        const ni = ((this.polySeq[seqIdx] % this.arpPool.length) + this.arpPool.length) % this.arpPool.length;
        this.lead.blip(this.arpPool[ni], time, {
          cutoffBase: 3000 + this.macro.intensity * 800,
          velocity: noteInBar === 0 ? 0.44 : 0.3,
          decay: 0.07,
        });
      }
    } else {
      const a = this.arpPat[barStep];
      if (a) {
        // noteIdx random-walks in both directions -- wrap negative indices.
        const ni = ((a.noteIdx % this.arpPool.length) + this.arpPool.length) % this.arpPool.length;
        let midi = this.arpPool[ni];
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
    }

    // Detuned stab chords
    const sp = this.stabPat[barStep];
    if (sp > 0 && this._layerOn('stab')) {
      this.lead.stab(this.stabNotes, time, {
        cutoffBase: 2600 + this.macro.intensity * 900,
        velocity: sp * 0.5,
        decay: 0.12,
      });
    }

    // The sustained breath -- a note from the higher chord-aware pool, so
    // it reflects the key rather than a random arp tone.
    const l = this.leadPat[barStep];
    if (l) {
      const mp = this.melodyPool;
      this.lead.note(mp[l.noteIdx % mp.length], time, {
        cutoffBase: 2200,
        q: 4,
        velocity: l.vel,
        decay: 1.5,
        vibrato: 0.32,
      });
    }
  }

  _onBar(barIndex, time) {
    if (this.onBar) this.onBar(barIndex);

    // One chord per bar. Bar 0 already has the chord at movement start.
    if (barIndex > 0) this._advanceChord(time);

    // Section rotation: chop (drum chaos) / build / detonate (full) /
    // hold (drums off, stutters float). A change is one concert event --
    // drums + bass + arps + hats + stabs re-roll together, the bass holds
    // for the full section, and rim + stabs join as the groove builds.
    if (barIndex > 0 && barIndex >= this.sectionUntilBar) {
      this._applySection(this._pickSection());
      this.sectionUntilBar = barIndex + randInt(4, 8);
    } else if (barIndex > 0) {
      this.sectionBar++;
    }

    // Macro drift
    const target = 0.3 + Math.random() * 0.6;
    this.macro.intensity = clamp01(this.macro.intensity + (target - this.macro.intensity) * 0.4);

    // Continuous texture drift: the shared filter LFOs on bass + lead keep
    // gliding (rate + depth wander), so the timbre never sits still -- the
    // "exploring the space" feel carried over from arpbient.
    this._driftTexture();

    if (barIndex >= this.movementEndBar) {
      this._beginEnding(time);
    }
  }

  // One concert event: re-roll the section's full groove (drums + bass +
  // arps + hats + stabs + levels) together and reset the in-section build.
  _applySection(name) {
    this.macro.section = name;
    this.sectionBar = 0;
    this._makeSectionPatterns();
    if (name !== 'hold') this._makeRimPattern();
    this._makeBassPattern();
    this._makeArpPattern();
    this._makeLeadPattern();
    this._makeHatPattern();
    this._makeStabPattern();
    if (name === 'hold') this.stabPat = new Array(16).fill(0); // stutters float
    this._applyLevels();
    // Detonation lands full immediately; chop and build add rim + stabs as
    // the section builds. (Hold is drumless, so its patterns are already 0.)
    this.layerGates =
      name === 'detonate' ? {} :
      name === 'build' ? { rim: 2, stab: 3 } :
      { rim: 1, stab: 2 };
    // The arp top voice is sometimes the section-long polyrhythmic dotted
    // loop instead of the grid pattern (rolled with the section).
    this.poly = Math.random() < 0.4;
    if (this.poly) this._pickPoly();
  }

  _pickSection() {
    const r = Math.random();
    return r < 0.4 ? 'chop' : r < 0.65 ? 'build' : r < 0.85 ? 'detonate' : 'hold';
  }

  // A texture layer plays once the section has built far enough.
  _layerOn(name) {
    return this.sectionBar >= (this.layerGates[name] ?? 0);
  }

  _advanceChord(time, silent = false) {
    const degree = this.progression[this.chordIndex % this.progression.length];
    this.chordIndex++;
    this.chordSemis = buildChord(this.mode, degree, { seventh: Math.random() < 0.5, add9: Math.random() < 0.4 });
    this.arpPool = buildArpPool(this.root, this.chordSemis, 12);
    // Higher, chord-anchored pool for the sustained breath: chord tones plus
    // a few passing scale tones an octave+ up, so it reflects the harmony
    // rather than a random arp tone.
    this.melodyPool = buildLeadPool(this.root, this.mode, this.chordSemis, { fromOctave: 24, octaves: 1 });
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
  }

  // The sustained breath: a short in-key phrase of 2-4 long tones that cuts
  // through the chaos, anchored on chord tones with a little contour. Fuller
  // in the drumless 'hold' (where the lead floats), a rare note elsewhere.
  // Notes come from the higher chord-aware pool (melodyPool), so the line
  // reflects the current harmony instead of a random arp tone.
  _makeLeadPattern() {
    const pat = new Array(16).fill(null);
    const len = Math.max(1, this.melodyPool.length);
    const hold = this.macro.section === 'hold';
    const placements = hold
      ? pick([[0, 8], [0, 6, 12], [4, 12], [0, 8, 12], [0, 4, 8, 12]])
      : Math.random() < 0.3 ? pick([[0], [8]]) : [];
    let idx = Math.floor(Math.random() * Math.min(4, len));
    let dir = Math.random() < 0.5 ? 1 : -1;
    placements.forEach((step, i) => {
      pat[step] = { noteIdx: ((idx % len) + len) % len, vel: i === 0 ? 0.34 : 0.26 + Math.random() * 0.08 };
      idx += dir * pick([1, 1, 2]);
      if (Math.random() < 0.3) dir *= -1;
    });
    this.leadPat = pat;
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

    this._makeRimPattern();
  }

  // Rim blips, re-rolled with the section.
  _makeRimPattern() {
    const density = this.macro.breaks;
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
      this.rimPat = new Array(16).fill(0);
    } else if (s === 'build') {
      this.kickPat = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
      this.snarePat = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
      this.snarePat[7] = 0.5;
      this.snarePat[15] = 0.5;
    } else {
      this._mutateDrums();
    }
  }

  // Roll the section's polyrhythmic top voice: a dotted-division sequence
  // loop. The division is a dotted 8th (every 3rd 16th, 3:2) or a dotted
  // quarter (every 6th, 3:4) -- both on the 16th grid, so it stays in time.
  // The melodic contour is four bars long and loops, resetting every four
  // bars. A section-long figure, not a one-off phrase.
  _pickPoly() {
    this.polyDiv = Math.random() < 0.5 ? 3 : 6;
    this.polyNotesPerBar = Math.floor(15 / this.polyDiv) + 1; // div3 -> 6, div6 -> 3
    const total = this.polyNotesPerBar * 4;
    const poolLen = Math.max(1, this.arpPool.length);
    const seq = [];
    let idx = Math.floor(Math.random() * poolLen);
    let dir = Math.random() < 0.5 ? 1 : -1;
    for (let i = 0; i < total; i++) {
      seq.push(idx);
      idx += dir * pick([1, 1, 2]);
      if (Math.random() < 0.18) dir *= -1; // the figure turns occasionally
    }
    this.polySeq = seq;
  }

  _pickMovementLength() {
    return randInt(28, 44); // ~45s-70s at hardcore tempos
  }

  // Re-roll what should be fresh at a movement boundary. Key, mode, and
  // progression are always new; tempo is re-rolled within the slider range
  // so it always differs from the movement it replaces.
  _rollMovement() {
    const roots = [40, 43, 45, 47, 48];
    let r;
    do { r = pick(roots); } while (r === this.root);
    this.root = r;
    this.mode = this._pickMode();
    this.progression = pick(PROGRESSIONS);
    this.movementEndBar = this._pickMovementLength();
    this.bpm = this._rollTempo();
    this.baseBpm = this.bpm;
    if (this.onMovementStart) this.onMovementStart({ root: this.root, mode: this.mode, bpm: this.bpm });
  }

  _rollTempo() {
    const span = this.tempoMax - this.tempoMin;
    if (span <= 0) return this.tempoMin;
    let t;
    do {
      t = this.tempoMin + Math.floor(Math.random() * (span + 1));
    } while (t === this.bpm);
    return t;
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

  // Slow, continuous evolution of the shared timbral LFOs on bass + lead.
  // The conductor random-walks rate + depth each bar; each layer eases to
  // the new value (2s), so the filter keeps gliding for the whole movement.
  _driftTexture() {
    this._fRate = clamp01((this._fRate != null ? this._fRate : 0.5) + (Math.random() - 0.5) * 0.3);
    this._fAmt = clamp01((this._fAmt != null ? this._fAmt : 0.5) + (Math.random() - 0.5) * 0.3);
    const hz = 0.03 + this._fRate * 0.13;   // 0.03-0.16 Hz
    const depth = 120 + this._fAmt * 480;   // 120-600 Hz
    if (this.bass && this.bass.setFilterRate) {
      this.bass.setFilterRate(hz * 0.7);
      this.bass.setFilterDepth(depth * 0.5);
    }
    if (this.lead && this.lead.setFilterRate) {
      this.lead.setFilterRate(hz);
      this.lead.setFilterDepth(depth);
    }
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
    // Every boundary is a fresh movement: a new key, a new tempo (always
    // different), new patterns -- whether Play started it or the piece ran
    // to its end.
    this._rollMovement();
    this.sectionUntilBar = 0;
    this._initMovement();
    this._syncDelay();
    this.nextStepTime = Math.max(this.nextStepTime, time + 0.05);
  }

  // Re-roll the delay time each movement: one of three BPM-locked
  // spacings (3/4 beat, 1 beat, just under 2 beats for the cascade tail).
  // The beat choice is shared across all nine engines; _retuneDelay keeps
  // the time locked to the beat when the tempo moves live mid-movement.
  _syncDelay() {
    this._delayBeats = [0.75, 1, 1.9][Math.floor(Math.random() * 3)];
    this._retuneDelay();
  }
  _retuneDelay() {
    this.core.setDelayTime((60 / this.bpm) * this._delayBeats);
  }

  // Live tempo: the slider retimes the current movement immediately and
  // becomes the anchor the next roll draws from.
  setTempo(bpm) {
    this.baseBpm = Math.max(this.tempoMin, Math.min(this.tempoMax, bpm));
    if (this.running) {
      this.bpm = this.baseBpm;
      this._retuneDelay();
    }
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
