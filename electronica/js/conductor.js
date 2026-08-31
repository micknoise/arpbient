import { MODES, buildChord, voiceChordOpen, buildArpPool, buildScalePool, buildLeadPool, pick, randInt, clamp01 } from './theory.js';
import { BassLayer } from './bass.js';
import { LeadLayer } from './lead.js';
import { DrumKit } from './drum.js';

// Electronica (IDM) composer. 16-step grid (16ths), 4/4, one chord per bar.
// Fixed tempo and key per movement.
//
// The character: dense 16th "noodle" arpeggios, a gliding syncopated
// bass, hat patterns with random pitched glitches, and sections that
// rotate between drum-driven noodle, drumless break (arps + bass
// floating), and sparse bass-forward groove. A section change is one
// concert event -- bass + top voice + hats + levels all re-rolled
// together; within a section the groove only builds by adding layers.
// The Glitch slider adds octave jumps, micro-stutters, and hat rate
// wobbles.
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
    this.tempoMin = 104;   // slider bounds -- tempo rolls live within these
    this.tempoMax = 128;
    this._delayBeats = 1;  // BPM-locked delay spacing (re-rolled per movement)
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

    // Section model: a change is one concert event (bass + top voice +
    // hats + levels re-rolled together); within a section the groove
    // builds by adding texture layers rather than swapping parts on
    // independent timers.
    this.sectionBar = 0;      // bars since the current section started
    this.layerGates = {};     // additive layer -> sectionBar at which it joins
    // Section-long polyrhythmic top voice (see _pickPoly): a dotted-division
    // sequence loop that plays in place of the grid arp for the whole
    // section and resets every four bars.
    this.poly = false;
    this.polyDiv = 3;
    this.polyNotesPerBar = 6;
    this.polySeq = [];

    this.kickPat = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
    this.hatPat = new Array(16).fill(0);
    this.rimPat = new Array(16).fill(0);
    this.bassPat = new Array(16).fill(null);
    this.arpPat = new Array(16).fill(null);
    this.leadPat = new Array(16).fill(null);

    this.chordSemis = [0, 7, 12];
    this.arpPool = [72, 79, 84];
    this.scalePool = [69, 72, 74, 76, 79, 81];
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
    this._applySection('noodle');
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
    if (hv > 0 && this._layerOn('hat')) {
      const glitch = Math.random() < this.macro.glitch * 0.3;
      this.kit.playHat(time, {
        velocity: hv,
        frequency: glitch ? 4000 + Math.random() * 9000 : 9500,
        decay: glitch ? 0.02 : 0.03,
        pan: (barStep % 4) === 0 ? -0.4 : 0.35,
        rate: glitch ? 0.7 + Math.random() * 1.2 : 1.0,
      });
    }

    if (this.rimPat[barStep] > 0 && this._layerOn('rim')) {
      this.kit.playRim(time, { velocity: this.rimPat[barStep], frequency: pick([700, 900, 1200]), pan: -0.3 });
    }

    // Noodle bass
    const b = this.bassPat[barStep];
    if (b) {
      this.bass.playNote(this.root - 12 + b.pc, time, {
        cutoffBase: 900 + this.macro.intensity * 700,
        cutoffFloor: 120,
        q: 6,
        velocity: Math.min(0.85, b.vel),
        decay: b.len,
        glide: b.glide || 0,
        bend: Math.random() < 0.3 ? 0.04 + Math.random() * 0.06 : 0,
        subLevel: 0.4,
      });
    }

    // Dense 16th arps, or -- in a poly section -- a section-long
    // dotted-division loop (see _pickPoly) that holds for the whole
    // section and resets every four bars.
    const arpOn = this._layerOn('arp');
    if (arpOn && this.poly) {
      if (barStep % this.polyDiv === 0) {
        const noteInBar = barStep / this.polyDiv;
        const barInCycle = barIndex % 4;
        const seqIdx = (barInCycle * this.polyNotesPerBar + noteInBar) % this.polySeq.length;
        const pool = this.arpPool;
        const ni = ((this.polySeq[seqIdx] % pool.length) + pool.length) % pool.length;
        this.lead.pluck(pool[ni], time, {
          cutoffBase: 2400 + this.macro.intensity * 1200,
          cutoffFloor: 300,
          q: 4,
          velocity: noteInBar === 0 ? 0.46 : 0.36,
          decay: 0.14,
          repeat: this.macro.glitch,
        });
      }
    } else if (arpOn) {
      const a = this.arpPat[barStep];
      if (a) {
        const pool = this.arpPool;
        // noteIdx random-walks in both directions -- wrap negative indices.
        const ni = ((a.noteIdx % pool.length) + pool.length) % pool.length;
        let midi = pool[ni];
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
    }

    // The sustained voice -- drawn from the higher chord-aware pool so it
    // sits above the bass and reflects the key.
    const l = this.leadPat[barStep];
    if (l && this._layerOn('lead')) {
      const mp = this.melodyPool;
      this.lead.note(mp[l.noteIdx % mp.length], time, {
        cutoffBase: 1800 + this.macro.intensity * 800,
        q: 3,
        velocity: l.vel,
        decay: 1.3,
        vibrato: 0.3,
      });
    }
  }

  _onBar(barIndex, time) {
    if (this.onBar) this.onBar(barIndex);

    // One chord per bar. Bar 0 already has the chord at movement start.
    if (barIndex > 0) this._advanceChord(time);

    // A section change is one concert event: bass + top voice + hats +
    // levels all re-rolled together. Between changes the groove is stable
    // and only builds by adding layers (see _layerOn).
    if (barIndex > 0 && barIndex >= this.sectionUntilBar) {
      this._applySection(this._pickSection());
      this.sectionUntilBar = barIndex + randInt(4, 8);
    } else if (barIndex > 0) {
      this.sectionBar++;
    }

    // Macro drift
    const target = 0.25 + Math.random() * 0.55;
    this.macro.intensity = clamp01(this.macro.intensity + (target - this.macro.intensity) * 0.4);

    // Continuous texture drift: the shared filter LFOs on bass + lead keep
    // gliding (rate + depth wander), so the timbre never sits still -- the
    // "exploring the space" feel carried over from arpbient.
    this._driftTexture();

    if (barIndex >= this.movementEndBar) {
      this._beginEnding(time);
    }
  }

  // One concert event: pick the section's full groove (bass + top voice +
  // hats + levels) and reset the in-section layer build.
  _applySection(name) {
    this.macro.section = name;
    this.sectionBar = 0;
    this._makeBassPattern();
    this._makeArpPattern();
    this._makeLeadPattern();
    this._makeHatPattern();
    // Kick is the constant core of the drum sections; the break drops
    // it entirely -- arps + bass floating over silence.
    if (name === 'break') {
      this.kickPat = new Array(16).fill(0);
    } else {
      this.kickPat = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
      if (name === 'noodle' && Math.random() < 0.4) this.kickPat[10] = 0.55;
    }
    this._applyLevels();
    // Noodle is full immediately. Break keeps the arp up (it IS the top
    // voice there) and admits the long tone in bar 2, with hats and rim
    // off for good. Groove is sparse and bass-forward: everything
    // additive joins late.
    this.layerGates =
      name === 'noodle' ? {} :
      name === 'break' ? { arp: 0, lead: 1, hat: 99, rim: 99 } :
      { arp: 2, hat: 2, rim: 3, lead: 3 };
    // The arp top voice is sometimes the section-long polyrhythmic dotted
    // loop instead of the grid pattern (rolled with the section).
    this.poly = Math.random() < 0.4;
    if (this.poly) this._pickPoly();
  }

  _pickSection() {
    const r = Math.random();
    return r < 0.5 ? 'noodle' : r < 0.75 ? 'break' : 'groove';
  }

  // An additive layer plays once the section has built far enough.
  _layerOn(name) {
    return this.sectionBar >= (this.layerGates[name] ?? 0);
  }

  _advanceChord(time, silent = false) {
    const degree = this.progression[this.chordIndex % this.progression.length];
    this.chordIndex++;
    this.chordSemis = buildChord(this.mode, degree, { seventh: Math.random() < 0.5, add9: Math.random() < 0.5 });
    this.arpPool = buildArpPool(this.root, this.chordSemis, 12);
    this.scalePool = buildScalePool(this.root, this.mode, { fromOctave: 2, octaves: 2 });
    // Higher, chord-anchored pool for the sustained line: chord tones plus
    // a few passing scale tones an octave+ up, so it sings above the bass
    // and tracks the current harmony.
    this.melodyPool = buildLeadPool(this.root, this.mode, this.chordSemis, { fromOctave: 24, octaves: 1 });
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

  // The sustained top: a short in-key phrase of 2-4 long tones, anchored
  // on chord tones with a little contour for motion. Fuller in the drumless
  // break (where it's the voice), sparse in groove. Notes come from the
  // higher chord-aware pool (melodyPool), so the line sings above the bass
  // and reflects the current harmony instead of doubling its root.
  _makeLeadPattern() {
    const pat = new Array(16).fill(null);
    const len = Math.max(1, this.melodyPool.length);
    const s = this.macro.section;
    const placements =
      s === 'break'
        ? pick([[0, 8], [0, 6, 12], [4, 12], [0, 8, 12], [0, 4, 8, 12]])
        : (s === 'groove' && Math.random() < 0.5) ? pick([[8], [4, 12], [0, 8]]) : [];
    let idx = Math.floor(Math.random() * Math.min(4, len));
    let dir = Math.random() < 0.5 ? 1 : -1;
    placements.forEach((step, i) => {
      pat[step] = { noteIdx: ((idx % len) + len) % len, vel: i === 0 ? 0.34 : 0.24 + Math.random() * 0.08 };
      idx += dir * pick([1, 1, 2]);
      if (Math.random() < 0.3) dir *= -1; // the phrase turns
    });
    this.leadPat = pat;
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
    return randInt(24, 40); // ~50s-90s at electronica tempos
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
    const bassL = s === 'break' ? 0.42 : 0.3 + this.macro.intensity * 0.12;
    const leadL = s === 'break' ? 0.42 : 0.3 + this.macro.intensity * 0.1;
    const drumL = s === 'break' ? 0.0 : 0.9;
    this.bass.setLevel(clamp01(bassL));
    this.lead.setLevel(clamp01(leadL));
    this.kit.setLevel(clamp01(drumL));
    this.kit.setKickLevel(0.95);
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
