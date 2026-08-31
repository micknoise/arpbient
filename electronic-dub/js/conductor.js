import { MODES, buildChord, voiceChordOpen, buildArpPool, pick, randInt, clamp01 } from './theory.js';
import { BassLayer } from './bass.js';
import { LeadLayer } from './lead.js';
import { DrumKit } from './drum.js';

// Electronic-dub composer. 16-step grid (16ths), 4/4, one chord per bar over
// a slow i/bVI cell. Fixed tempo and key per movement.
//
// The groove: the classic one-drop -- kick on 1, snare/clap on 2 and 4,
// skank chord stabs on the offbeats riding a big dotted-8th echo, a
// long-decay syncopated bass, and sparse melody notes that live mostly in
// the delay. The "dub" character comes from the mix automation: random
// dropouts (delay + reverb returns cut out), occasional echo swells
// (feedback pushed up), and "stripped" sections where the drums thin to
// kick-and-bass and the tails take over.
export class Conductor {
  constructor(audioCore) {
    this.core = audioCore;
    this.ctx = audioCore.ctx;

    this.kit = new DrumKit(this.ctx, audioCore, { reverbAmount: 0.12, delayAmount: 0.08 });
    this.bass = new BassLayer(this.ctx, audioCore, { reverbAmount: 0.08, delayAmount: 0.5 });
    this.lead = new LeadLayer(this.ctx, audioCore, { reverbAmount: 0.5, delayAmount: 0.65 });

    this.root = pick([40, 43, 45, 47, 48]);
    this.mode = Math.random() < 0.6 ? 'aeolian' : 'major';
    this.progression = pick(PROGRESSIONS);
    this.chordIndex = 0;

    this.baseBpm = 85;
    this.bpm = this.baseBpm;
    this.tempoMin = 70;
    this.tempoMax = 100;
    this._delayBeats = 1;
    this.beatsPerBar = 4;
    this.stepsPerBeat = 4;

    this.lookahead = 25;
    this.scheduleAheadTime = 0.15;
    this.nextStepTime = 0;
    this.stepCount = 0;
    this.timerID = null;

    this.macro = {
      dropout: 0.5,
      intensity: 0.4,
      section: 'full',
    };
    this.sectionUntilBar = 0;

    // Resting delay values -- delayBurst() pushes above these and back,
    // so the conductor tracks what the Echo slider last set.
    this.baseFb = 0.49;
    this.baseReturn = 0.66;

    // Section model: a section change is one concert event (bass + top
    // voice + drums + levels all re-rolled together), and within a section
    // the groove builds by adding layers bar by bar instead of swapping
    // individual parts on their own timers -- nothing drifts out of sync.
    this.sectionBar = 0;      // bars since the current section started
    this.layerGates = {};     // additive layer -> sectionBar at which it joins
    // Section-long polyrhythmic top voice (see _pickPoly): a dotted-division
    // sequence loop that plays in place of the grid lead for the whole
    // section and resets every four bars.
    this.poly = false;
    this.polyDiv = 3;
    this.polyNotesPerBar = 6;
    this.polySeq = [];

    this.kickPat = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    this.clapPat = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
    this.hatPat = new Array(16).fill(0);
    this.rimPat = new Array(16).fill(0);
    this.bassPat = new Array(16).fill(null);
    this.skankPat = [0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.8, 0];
    this.leadPat = new Array(16).fill(null);

    this.chordSemis = [0, 7, 12];
    this.leadPool = [72, 79, 84];

    this.phase = 'normal';
    this.phaseUntil = 0;
    this.movementEndBar = this._pickMovementLength();

    this.running = false;

    this.onBar = null;
    this.onChord = null;
    this.onEnding = null;
    this.onMovementStart = null;

    this.setEcho(0.6);
  }

  _stepDuration() {
    return 60 / this.bpm / this.stepsPerBeat;
  }

  start() {
    if (this.running) return;
    this.running = true;
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
    this._applySection('full');
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

    // Kick -- lighter pump than techno; dub is about the tails, not the
    // thump.
    const kv = this.kickPat[barStep];
    if (kv > 0) {
      this.kit.playKick(time, { velocity: kv, decay: 0.35, click: 0.25 });
      this.core.pump(time, { depth: 0.3, release: 0.25 });
    }

    const cv = this.clapPat[barStep];
    if (cv > 0) this.kit.playClap(time, { velocity: cv * 0.9, frequency: 1300, hits: 2, pan: 0.1 });

    if (this.hatPat[barStep] > 0 && this._layerOn('hats')) {
      this.kit.playHat(time, {
        velocity: this.hatPat[barStep],
        frequency: 9500,
        decay: 0.03,
        pan: barStep % 8 === 2 ? -0.35 : 0.35,
      });
    }

    if (this.rimPat[barStep] > 0 && this._layerOn('rim')) {
      this.kit.playRim(time, { velocity: this.rimPat[barStep], frequency: 800, pan: -0.2 });
    }

    // Long-decay syncopated bass -- the anchor, always on. Sometimes this
    // is the only thing going.
    const b = this.bassPat[barStep];
    if (b) {
      this.bass.playNote(this.root - 12 + b.pc, time, {
        cutoffBase: 380 + b.vel * 200,
        cutoffFloor: 60,
        q: 2.5,
        velocity: Math.min(b.vel, 0.85),
        decay: b.len,
        subLevel: 0.4,
      });
      // Occasional echo swell riding the bass tail.
      if (Math.random() < 0.06) this._echoBurst(time);
    }

    // Skank stabs -- the offbeat chord that defines the reggae feel.
    const sv = this.skankPat[barStep];
    if (sv > 0 && this._layerOn('skank')) {
      this.lead.stab(this.stabNotes, time, {
        cutoffBase: 2200 + this.macro.intensity * 900,
        q: 1.2,
        velocity: sv * 0.45,
        decay: 0.16,
      });
    }

    // Sparse long melody notes, or -- in a poly section -- a section-long
    // dotted-division loop (see _pickPoly) that holds for the whole
    // section and resets every four bars.
    const leadOn = this._layerOn('lead');
    if (leadOn && this.poly) {
      if (barStep % this.polyDiv === 0) {
        const noteInBar = barStep / this.polyDiv;
        const barInCycle = barIndex % 4;
        const seqIdx = (barInCycle * this.polyNotesPerBar + noteInBar) % this.polySeq.length;
        const ni = ((this.polySeq[seqIdx] % this.leadPool.length) + this.leadPool.length) % this.leadPool.length;
        this.lead.note(this.leadPool[ni], time, {
          cutoffBase: 1400 + this.macro.intensity * 900,
          q: 3,
          velocity: noteInBar === 0 ? 0.42 : 0.3,
          decay: 0.5 + this.macro.intensity * 0.6,
          vibrato: 0.2,
        });
      }
    } else if (leadOn) {
      const l = this.leadPat[barStep];
      if (l) {
        this.lead.note(this.leadPool[l.noteIdx % this.leadPool.length], time, {
          cutoffBase: 1400 + this.macro.intensity * 900,
          q: 3,
          velocity: l.vel,
          decay: 0.5 + this.macro.intensity * 0.6,
          vibrato: 0.2,
        });
      }
    }
  }

  _onBar(barIndex, time) {
    if (this.onBar) this.onBar(barIndex);

    // One chord per bar, cycling the slow i-rooted cell. Bar 0 already has
    // the chord established at movement start.
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

    // The dub magic: random dropouts and echo swells, scaled by the
    // Dropouts slider.
    if (this.macro.dropout > 0 && Math.random() < this.macro.dropout * 0.55) {
      this._dropout(time);
    }
    if (Math.random() < 0.1 + this.macro.dropout * 0.2) {
      this._echoBurst(time + this._stepDuration() * 4);
    }

    // Macro drift
    const target = 0.25 + Math.random() * 0.5;
    this.macro.intensity = clamp01(this.macro.intensity + (target - this.macro.intensity) * 0.4);

    this._driftTexture();

    if (barIndex >= this.movementEndBar) {
      this._beginEnding(time);
    }
  }

  // One concert event: pick the section's full groove (bass + skank +
  // melody + hats + levels) and reset the in-section layer build.
  _applySection(name) {
    this.macro.section = name;
    this.sectionBar = 0;
    this._makeBassPattern();
    this._makeLeadPattern();
    this._makeSkankPattern();
    this.rimPat = new Array(16).fill(0);
    this._makeHatPattern();
    // Kick + clap are the constant one-drop core.
    this.kickPat = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    this.clapPat = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
    this._applyLevels();
    // Additive layers join as the section builds. Full: skank + hats step
    // in, then melody + rim. Stripped: the dub-out -- kick + bass + tails
    // carry it, the top voice stays off and only sparse hats join late.
    this.layerGates =
      name === 'stripped'
        ? { skank: 99, lead: 99, hats: 3, rim: 99 }
        : { skank: 1, lead: 2, hats: 1, rim: 2 };
    // In 'full' the melody is sometimes the section-long polyrhythmic
    // dotted loop instead of the grid pattern (rolled with the section).
    this.poly = name === 'full' && Math.random() < 0.5;
    if (this.poly) this._pickPoly();
  }

  _pickSection() {
    return Math.random() < 0.65 ? 'full' : 'stripped';
  }

  // An additive layer plays once the section has built far enough.
  _layerOn(name) {
    return this.sectionBar >= (this.layerGates[name] ?? 0);
  }

  _advanceChord(time, silent = false) {
    const degree = this.progression[this.chordIndex % this.progression.length];
    this.chordIndex++;
    this.chordSemis = buildChord(this.mode, degree, { seventh: Math.random() < 0.4, add9: Math.random() < 0.4 });
    this.leadPool = buildArpPool(this.root, this.chordSemis, 12);
    this.stabNotes = voiceChordOpen(this.root, this.chordSemis);
    if (!silent && this.onChord) {
      this.onChord({ root: this.root, mode: this.mode, degree, midiNotes: this.stabNotes });
    }
  }

  // Long-decay one-drop bass phrases.
  _makeBassPattern() {
    const pat = new Array(16).fill(null);
    const style = pick(['onettwo', 'onettwo', 'sync', 'long', 'pop']);
    if (style === 'onettwo') {
      pat[0] = { pc: 0, vel: 0.95, len: 1.4 };
      pat[8] = { pc: 0, vel: 0.7, len: 1.1 };
      if (Math.random() < 0.5) pat[12] = { pc: 0, vel: 0.5, len: 0.5 };
    } else if (style === 'sync') {
      pat[0] = { pc: 0, vel: 0.9, len: 0.9 };
      pat[6] = { pc: 0, vel: 0.6, len: 0.4 };
      pat[8] = { pc: 0, vel: 0.85, len: 1.1 };
      if (Math.random() < 0.6) pat[11] = { pc: ((this.chordSemis[1] % 12) + 12) % 12, vel: 0.5, len: 0.5 };
    } else if (style === 'long') {
      pat[0] = { pc: 0, vel: 1.0, len: 2.0 };
      pat[10] = { pc: 0, vel: 0.55, len: 0.8 };
    } else {
      pat[0] = { pc: 0, vel: 0.9, len: 0.8 };
      pat[8] = { pc: 0, vel: 0.85, len: 1.2 };
      pat[14] = { pc: 0, vel: 0.55, len: 0.4 };
    }
    this.bassPat = pat;
  }

  _makeLeadPattern() {
    const pat = new Array(16).fill(null);
    const spots = pick([[0], [0, 8], [4], [0, 10], [6, 12], [0, 6, 12]]);
    let idx = 0;
    spots.forEach((s, i) => {
      idx += pick([0, 1, 2]);
      pat[s] = { noteIdx: idx, vel: i === 0 ? 0.4 : 0.3 + Math.random() * 0.15 };
    });
    this.leadPat = pat;
  }

  _makeSkankPattern() {
    const r = Math.random();
    if (r < 0.2) {
      // Drop one offbeat for a moment of silence.
      this.skankPat = [0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 0, 0, 0.8, 0];
    } else if (r < 0.35) {
      // Ghost stab before the downbeat.
      this.skankPat = [0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.55, 0];
    } else if (r < 0.5) {
      // Double the last offbeat (the "and" echo played dry).
      this.skankPat = [0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.8, 0.35];
    } else {
      this.skankPat = [0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.8, 0];
    }
  }

  _makeHatPattern() {
    const style = pick(['sparse', 'sparse', 'ghosts', 'off8']);
    const pat = new Array(16).fill(0);
    if (style === 'off8') {
      [2, 6, 10, 14].forEach((s, i) => (pat[s] = 0.25 + (i % 2 ? 0.1 : 0.15)));
    } else if (style === 'ghosts') {
      [1, 5, 9, 13, 15].forEach((s) => (pat[s] = 0.15 + Math.random() * 0.2));
    } else {
      [6, 14].forEach((s) => (pat[s] = 0.4));
      if (Math.random() < 0.5) pat[10] = 0.3;
    }
    this.hatPat = pat;
    if (Math.random() < 0.4) {
      const spots = pick([[3, 11], [1, 9], [5, 13, 15]]);
      const rim = new Array(16).fill(0);
      spots.forEach((s) => (rim[s] = 0.2 + Math.random() * 0.2));
      this.rimPat = rim;
    }
  }

  // Dub dropout: cut the delay + reverb returns for a beat or two, then
  // bring them back. The dry hit reads instantly "dub".
  _dropout(time) {
    const steps = pick([2, 4, 4, 6]);
    this.core.setEffectsMuted(true, time);
    this.core.setEffectsMuted(false, time + steps * this._stepDuration());
  }

  // Echo swell: push the shared delay's feedback and return up briefly.
  _echoBurst(time) {
    this.core.delayBurst(time, 0.5 + Math.random() * 0.7, {
      baseFeedback: this.baseFb,
      baseReturn: this.baseReturn,
      feedback: 0.85,
      returnLevel: 1.15,
    });
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
    const poolLen = Math.max(1, this.leadPool.length);
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
    return randInt(24, 48); // ~70s-135s at dub tempos
  }

  // Every movement boundary (play click or auto) re-rolls key AND tempo --
  // the tempo is guaranteed different from the one it's replacing, and the
  // slider stays the live target for the in-flight movement.
  _rollMovement() {
    const roots = [40, 43, 45, 47, 48];
    let r;
    do { r = pick(roots); } while (r === this.root);
    this.root = r;
    this.mode = Math.random() < 0.6 ? 'aeolian' : 'major';
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
    do { t = this.tempoMin + Math.floor(Math.random() * (span + 1)); } while (t === this.bpm);
    return t;
  }

  _applyLevels() {
    const s = this.macro.section;
    const bassL = s === 'stripped' ? 0.42 : 0.32 + this.macro.intensity * 0.08;
    const leadL = s === 'stripped' ? 0.3 : 0.38 + this.macro.intensity * 0.1;
    const drumL = s === 'stripped' ? 0.75 : 0.9;
    this.bass.setLevel(clamp01(bassL));
    this.lead.setLevel(clamp01(leadL));
    this.kit.setLevel(clamp01(drumL));
    this.kit.setKickLevel(0.9);
  }

  // Texture drift: each bar, random-walk the shared bass/lead filter LFO
  // rate + depth so the timbre keeps gliding across the section (the
  // arpbient model). Each layer eases to the new value with a 2s tau.
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

  // The ending: the groove strips to a slow kick-and-bass pulse, a riser
  // swells, the final hit detonates with an echo burst, then a lone chord
  // rings out over a held sub.
  _beginEnding(time) {
    this.phase = 'quiet';
    if (this.onEnding) this.onEnding();

    const barDur = (4 * 60) / this.bpm;
    const stepDur = barDur / 16;

    // Stripped final bar: half-time pulse, offbeat open hats, riser.
    this.kit.playKick(time, { velocity: 0.9, decay: 0.45 });
    this.kit.playKick(time + barDur / 2, { velocity: 0.9, decay: 0.45 });
    this.core.pump(time, { depth: 0.4, release: 0.3 });
    this.core.pump(time + barDur / 2, { depth: 0.4, release: 0.3 });
    [2, 6, 10, 14].forEach((s) => {
      this.kit.playHat(time + s * stepDur, { velocity: 0.4, frequency: 8000, decay: 0.16, q: 1.2, pan: s % 8 === 2 ? -0.4 : 0.4 });
    });
    this.bass.playNote(this.root - 12, time, { velocity: 0.9, decay: barDur * 0.7, cutoffBase: 500 });
    this.bass.playNote(this.root - 12, time + barDur / 2, { velocity: 0.8, decay: barDur * 0.7, cutoffBase: 500 });
    this.kit.playRiser(time, barDur, { peak: 0.45 });

    // Final hit at the bar line, with the echo swelling hard.
    const tEnd = time + barDur;
    this.kit.playKick(tEnd, { velocity: 1.1, decay: 0.55 });
    this.kit.playClap(tEnd, { velocity: 1, frequency: 1400, hits: 3 });
    this.core.pump(tEnd, { depth: 0.6, release: 0.5 });
    this.bass.playNote(this.root - 12, tEnd, { cutoffBase: 700, velocity: 1.0, decay: 1.6 });
    const bigChord = this.stabNotes.concat(this.stabNotes.map((n) => n - 12));
    this.lead.stab(bigChord, tEnd, { cutoffBase: 2600, q: 1.5, velocity: 0.6, decay: 0.3 });
    this._echoBurst(tEnd);

    // Lone sustained chord + held sub, long tails.
    const restAttack = 2.0;
    const restHold = 5 + Math.random() * 4;
    this.lead.sustain(this.stabNotes, tEnd + 0.02, { attack: restAttack, hold: restHold, release: 4, cutoffBase: 1400, velocity: 0.3 });
    this.bass.sustain(this.root - 24, tEnd + 0.02, { attack: 0.8, hold: restHold, release: 3, cutoffBase: 400, velocity: 0.5 });

    this.phaseUntil = tEnd + restAttack + restHold + 4 + 1;
  }

  _beginNewMovement(time) {
    this.phase = 'normal';
    this._rollMovement();
    this.sectionUntilBar = 0;
    this._initMovement();
    this._syncDelay();
    this.nextStepTime = Math.max(this.nextStepTime, time + 0.05);
  }

  // Re-roll the delay time each movement: one of three BPM-locked
  // spacings (3/4 beat, 1 beat, just under 2 beats for the cascade tail).
  // This logic is identical across all nine engines.
  _syncDelay() {
    this._delayBeats = [0.75, 1, 1.9][Math.floor(Math.random() * 3)];
    this._retuneDelay();
  }

  _retuneDelay() {
    this.core.setDelayTime((60 / this.bpm) * this._delayBeats);
  }

  // Live tempo: the slider sets the target immediately; if a movement is in
  // flight it takes effect now (and the shared delay re-locks to it).
  setTempo(bpm) {
    this.baseBpm = Math.max(this.tempoMin, Math.min(this.tempoMax, bpm));
    if (this.running) {
      this.bpm = this.baseBpm;
      this._retuneDelay();
    }
  }

  // Echo slider: rides the shared delay's feedback + return. Tracks the
  // resting values so echo swells restore to where the slider left them.
  setEcho(v) {
    const e = clamp01(v);
    this.baseFb = 0.25 + e * 0.4;
    this.baseReturn = 0.15 + e * 0.85;
    this.core.setDelayFeedback(this.baseFb);
    this.core.setDelayReturn(this.baseReturn);
  }

  // Dropouts slider: how often the conductor cuts the effects returns.
  setDropouts(v) {
    this.macro.dropout = clamp01(v);
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
  [0, 0, 3, 5],
];
