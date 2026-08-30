import { buildChord, voiceChordOpen, buildLeadPool, pick, randInt, clamp01 } from './theory.js';
import { PadLayer } from './pad.js';
import { BassLayer } from './bass.js';
import { LeadLayer } from './lead.js';
import { DrumKit } from './drum.js';

// Ambient-techno composer. 16-step grid but sparse by design: soft
// half-time or broken kick, long reverbed hats, slow root swells, a wide
// evolving pad (one chord per 2 bars), and sparse long singing lead
// notes. Big reverb + long delay. Fixed tempo and key per movement.
export class Conductor {
  constructor(audioCore) {
    this.core = audioCore;
    this.ctx = audioCore.ctx;

    this.kit = new DrumKit(this.ctx, audioCore, { reverbAmount: 0.35, delayAmount: 0.2 });
    this.pad = new PadLayer(this.ctx, audioCore, { reverbAmount: 0.9, delayAmount: 0.35 });
    this.bass = new BassLayer(this.ctx, audioCore, { reverbAmount: 0.2, delayAmount: 0.05 });
    this.lead = new LeadLayer(this.ctx, audioCore, { reverbAmount: 1.0, delayAmount: 0.65 });

    this.root = pick([40, 43, 45, 47, 48]);
    this.mode = Math.random() < 0.7 ? 'aeolian' : 'dorian';
    this.progression = pick(PROGRESSIONS);
    this.chordIndex = 0;

    this.baseBpm = 108;
    this.bpm = this.baseBpm;
    this.beatsPerBar = 4;
    this.stepsPerBeat = 4;
    this.barsPerChord = 2;

    this.lookahead = 25;
    this.scheduleAheadTime = 0.15;
    this.nextStepTime = 0;
    this.stepCount = 0;
    this.timerID = null;

    this.macro = { space: 0.7, density: 0.45, intensity: 0.3, warmth: 0.6, section: 'drift' };
    this.intensityTarget = 0.3;
    this.sectionUntilBar = 0;

    // Section model: a change is one concert event (bass + lead + hats
    // re-rolled together); within a section the texture builds by adding
    // layers rather than swapping parts on independent timers.
    this.sectionBar = 0;
    this.layerGates = {};
    this.polyBar = -1;

    // 16-step patterns.
    this.kickPat = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
    this.clapPat = [0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0];
    this.hatPat = new Array(16).fill(0);
    this.hatOpenPat = new Array(16).fill(0);
    this.rimPat = new Array(16).fill(0);
    this.bassPat = new Array(16).fill(null);
    this.leadPat = new Array(16).fill(null);

    this.chordSemis = [0, 7, 12];
    this.padNotes = voiceChordOpen(this.root, this.chordSemis);
    this.leadPool = buildLeadPool(this.root, this.mode, this.chordSemis);

    this.phase = 'normal';
    this.phaseUntil = 0;
    this.movementEndBar = this._pickMovementLength();
    this.userTempo = null;
    this.sweepBar = 8;

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
    this.polyBar = -1;
    this.sweepBar = randInt(8, 16);
    this._advanceChord(true);
    this._applySection('drift');
    this._playChord(this.ctx.currentTime);
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

    // Soft, round, reverb-drenched kick.
    const kv = this.kickPat[barStep];
    if (kv > 0) {
      this.kit.playKick(time, { velocity: kv * 0.8, startFreq: 105, endFreq: 40, decay: 0.55, click: 0.06 });
      this.core.pump(time, { depth: 0.3 + this.macro.intensity * 0.15, release: 0.35 });
    }

    const cv = this.clapPat[barStep];
    if (cv > 0) this.kit.playClap(time, { velocity: cv, frequency: 1100, hits: 2, pan: 0.1 });

    const hv = this.hatPat[barStep];
    if (hv > 0 && this._layerOn('hat')) {
      this.kit.playHat(time, { velocity: hv, frequency: 9000, decay: 0.14, pan: barStep % 8 < 4 ? -0.35 : 0.35 });
    }
    const hvo = this.hatOpenPat[barStep];
    if (hvo > 0 && this._layerOn('openHat')) {
      this.kit.playHat(time, { velocity: hvo, frequency: 6800, decay: 0.4, q: 1.2, pan: barStep % 8 === 2 ? -0.5 : 0.5 });
    }

    if (this.rimPat[barStep] > 0 && this._layerOn('rim')) {
      this.kit.playRim(time, { velocity: this.rimPat[barStep], frequency: 850, pan: 0.3 });
    }

    // Deep bass swells / rolling 8ths.
    const b = this.bassPat[barStep];
    if (b) {
      const midi = this.root + b.pc;
      const warm = this.macro.warmth;
      if (b.long) {
        this.bass.swell(midi, time, {
          attack: 0.3,
          hold: b.hold,
          release: 2.2,
          cutoffBase: 250 + warm * 300 + this.macro.intensity * 150,
          velocity: b.vel,
        });
      } else {
        this.bass.pluck(midi, time, {
          cutoffBase: 300 + warm * 400,
          velocity: b.vel,
          decay: 0.4,
        });
      }
    }

    // Sparse long lead notes (skipped on a polyrhythmic bar).
    const l = this.leadPat[barStep];
    if (l && barIndex !== this.polyBar && this._layerOn('lead')) {
      this.lead.note(this.leadPool[l.noteIdx % this.leadPool.length], time, {
        cutoffBase: 1600 + this.macro.warmth * 900,
        velocity: l.vel,
        decay: l.len,
        vibratoRate: 3.5,
      });
    }
  }

  _onBar(barIndex, time) {
    if (this.onBar) this.onBar(barIndex);

    // One chord per 2 bars, cross-faded by long pad release.
    if (barIndex % this.barsPerChord === 0) {
      const firstBar = barIndex === 0;
      if (!firstBar) this._advanceChord(false);
      this._playChord(time);
    }

    // Slow noise sweep every so often for motion.
    if (barIndex === this.sweepBar) {
      const barDur = (4 * 60) / this.bpm;
      this.kit.playRiser(time, barDur * 2, { peak: 0.18 });
      this.sweepBar = barIndex + randInt(10, 20);
    }

    // A section change is one concert event: bass + lead + hats + kick +
    // rim all re-roll together, and the bass now holds for the full section
    // (4-8 bars). Between changes the texture only builds by adding layers
    // (see _layerOn) -- nothing drifts out of sync.
    if (barIndex > 0 && barIndex >= this.sectionUntilBar) {
      this._applySection(this._pickSection());
      this.sectionUntilBar = barIndex + randInt(4, 8);
    } else if (barIndex > 0) {
      this.sectionBar++;
    }

    // Polyrhythmic lead bar (3-against-4, 5-against-4 at slow tempos).
    // Only against a live grid lead -- an orphaned off-grid phrase with
    // the lead gated off reads as a timing error.
    if (barIndex > 0 && this._layerOn('lead') && Math.random() < 0.15) {
      this.polyBar = barIndex;
      this._playPolyPhrase(time);
    }

    // Intensity drift (drum presence swells and fades).
    if (!this._surging) {
      if (Math.random() < 0.1) {
        this.intensityTarget = 0.6 + Math.random() * 0.4;
        this._surging = true;
      } else {
        this.intensityTarget = 0.15 + Math.random() * 0.25;
      }
    } else {
      this.intensityTarget -= 0.2;
      if (this.intensityTarget <= 0.25) {
        this.intensityTarget = 0.2;
        this._surging = false;
      }
    }
    this.macro.intensity = clamp01(this.macro.intensity + (this.intensityTarget - this.macro.intensity) * 0.4);
    this._applyLevels();

    if (barIndex >= this.movementEndBar) {
      this._beginEnding(time);
    }
  }

  // One concert event: pick the section's full texture (bass + lead + hats
  // + kick + rim + levels) and reset the in-section layer build.
  _applySection(name) {
    this.macro.section = name;
    this.sectionBar = 0;
    this._makeBassPattern();
    this._makeLeadPattern();
    this._makeHatPattern();
    this._makeRimPattern();
    this._pickKick(name);
    // The soft clap on 2 & 4 is the constant ambient-techno core.
    this.clapPat = [0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0];
    this._applyLevels();
    // Drift builds up from a bare pad + bass; swell is full immediately;
    // deep stays drumless-feeling and lets the lead ride.
    this.layerGates =
      name === 'swell' ? {} :
      name === 'deep' ? { hat: 2, openHat: 3, rim: 4, lead: 0 } :
      { hat: 1, openHat: 2, rim: 2, lead: 1 };
  }

  _pickSection() {
    const r = Math.random();
    return r < 0.5 ? 'drift' : r < 0.85 ? 'swell' : 'deep';
  }

  // A texture layer plays once the section has built far enough.
  _layerOn(name) {
    return this.sectionBar >= (this.layerGates[name] ?? 0);
  }

  // The half-time kick core, shaped per section (swell adds the broken
  // ghost pulses; deep is a bare heartbeat that the low kit level buries).
  _pickKick(name) {
    if (name === 'swell') {
      this.kickPat = [0.8, 0, 0, 0, 0.5, 0, 0, 0, 0.8, 0, 0, 0, 0.5, 0, 0, 0];
    } else if (name === 'deep') {
      this.kickPat = [0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0];
    } else {
      this.kickPat = [0.8, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 0, 0];
    }
  }

  _advanceChord(silent = false) {
    const degree = this.progression[this.chordIndex % this.progression.length];
    this.chordIndex++;
    this.chordSemis = buildChord(this.mode, degree, { seventh: true, add9: Math.random() < 0.3 });
    this.padNotes = voiceChordOpen(this.root, this.chordSemis);
    this.leadPool = buildLeadPool(this.root, this.mode, this.chordSemis);
    if (!silent && this.onChord) {
      this.onChord({ root: this.root, mode: this.mode, degree, midiNotes: this.padNotes });
    }
  }

  // Sustains the current chord on the pad with long, cross-fading envelope.
  _playChord(time) {
    const barDur = (4 * 60) / this.bpm;
    const chordDur = this.barsPerChord * barDur;
    const attack = Math.min(chordDur * 0.4, 4.0);
    const hold = Math.max(chordDur - attack - 2.0, 1.0);
    const warm = this.macro.warmth;
    this.pad.sustain(this.padNotes, time, {
      attack,
      hold,
      release: 3.5,
      cutoffBase: 500 + warm * 700 + this.macro.intensity * 300,
      q: 1.3,
      velocity: 0.32 + this.macro.intensity * 0.1,
      detune: 10 + warm * 8,
    });
  }

  _makeBassPattern() {
    const pat = new Array(16).fill(null);
    const style = pick(['swell', 'swell', 'rolling', 'ghost']);
    if (style === 'swell') {
      pat[0] = { pc: 0, vel: 0.75, long: true, hold: 0.8 };
      pat[8] = { pc: 0, vel: 0.6, long: true, hold: 0.6 };
    } else if (style === 'rolling') {
      [0, 2, 4, 6, 8, 10, 12, 14].forEach((s) => {
        pat[s] = { pc: s === 14 ? 12 : 0, vel: s % 4 === 0 ? 0.6 : 0.42, long: false };
      });
    } else {
      pat[0] = { pc: 0, vel: 0.7, long: true, hold: 0.7 };
      pat[11] = { pc: 12, vel: 0.35, long: false };
    }
    this.bassPat = pat;
  }

  _makeLeadPattern() {
    const pat = new Array(16).fill(null);
    const notes = randInt(1, 2);
    const slots = pick([[0], [8], [0, 8], [4, 12], [6, 14]]).slice(0, notes);
    let idx = randInt(0, 4);
    slots.forEach((s) => {
      idx += pick([1, 2, 3]);
      pat[s] = { noteIdx: idx, vel: 0.3 + Math.random() * 0.18, len: 1.6 + Math.random() * 1.6 };
    });
    this.leadPat = pat;
  }

  _makeHatPattern() {
    const closed = new Array(16).fill(0);
    const open = new Array(16).fill(0);
    const style = pick(['tick16', 'off8', 'off8', 'sparse']);
    if (style === 'tick16') {
      for (let s = 0; s < 16; s++) closed[s] = 0.08 + (s % 4 === 2 ? 0.08 : 0);
      open[2] = 0.22;
      open[10] = 0.22;
    } else if (style === 'off8') {
      [2, 6, 10, 14].forEach((s, i) => (open[s] = 0.2 + (i % 2 ? 0.08 : 0.14)));
    } else {
      [6, 10].forEach((s) => (closed[s] = 0.16));
      open[14] = 0.24;
    }
    this.hatPat = closed;
    this.hatOpenPat = open;
  }

  // Sparse rim ghosts, re-rolled with the section.
  _makeRimPattern() {
    const pat = new Array(16).fill(0);
    if (Math.random() < 0.5) {
      const spots = pick([[13], [3, 11], [5], [1, 9]]);
      spots.forEach((s) => (pat[s] = 0.18 + Math.random() * 0.15));
    }
    this.rimPat = pat;
  }

  // Polyrhythmic lead phrase, always within one bar (polyBar suppresses
  // the grid lead for exactly one bar). Notes walk the pool with an
  // accented head -- a deliberate figure, not a timing slip.
  _playPolyPhrase(time) {
    const barDur = (4 * 60) / this.bpm;
    const [n, beats] = pick([[3, 4], [5, 4], [3, 2], [7, 4]]);
    const span = beats * (barDur / 4);
    const start = time;
    const pool = this.leadPool;
    let idx = Math.floor(Math.random() * pool.length);
    const dir = Math.random() < 0.5 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const t = start + (span * i) / n;
      idx += dir * pick([1, 1, 2]);
      this.lead.note(pool[((idx % pool.length) + pool.length) % pool.length], t, {
        cutoffBase: 1800,
        velocity: i === 0 ? 0.36 : 0.24,
        decay: 1.2,
        vibratoRate: 4,
      });
    }
  }

  _pickMovementLength() {
    return randInt(32, 56); // long, slow movements (~70s-2min)
  }

  _pickNewTempo() {
    return randInt(96, 118);
  }

  _applyLevels() {
    const i = this.macro.intensity;
    const s = this.macro.section;
    // 'deep' buries the kit under the pad; 'swell' lifts it forward.
    const kitL = s === 'deep' ? 0.12 + i * 0.2 : s === 'swell' ? 0.5 + i * 0.45 : 0.35 + i * 0.5;
    const leadL = s === 'deep' ? 0.42 + i * 0.15 : 0.3 + i * 0.2;
    this.pad.setLevel(0.45 + i * 0.2);
    this.bass.setLevel(0.4 + i * 0.25);
    this.lead.setLevel(clamp01(leadL));
    this.kit.setLevel(clamp01(kitL));
    this.kit.setKickLevel(0.9);
  }

  // Ending: drums fade, the pad swells wide, a long riser, then a final
  // sustained chord + sub ring out for a long quiet drone.
  _beginEnding(time) {
    this.phase = 'quiet';
    if (this.onEnding) this.onEnding();

    const barDur = (4 * 60) / this.bpm;

    // Last two bars: pad only, swelling.
    this.pad.sustain(this.padNotes, time, {
      attack: barDur * 0.6,
      hold: barDur * 1.2,
      release: 5,
      cutoffBase: 1200,
      q: 1.2,
      velocity: 0.5,
    });
    this.kit.playRiser(time, barDur * 2, { peak: 0.3 });

    const tEnd = time + barDur * 2;
    this.bass.swell(this.root, tEnd, { attack: 0.8, hold: 4, release: 5, cutoffBase: 500, velocity: 0.8 });
    this.pad.sustain(this.padNotes, tEnd, { attack: 1.5, hold: 6, release: 6, cutoffBase: 1500, q: 1.2, velocity: 0.55 });
    this.lead.note(pick(this.leadPool), tEnd, { cutoffBase: 2000, velocity: 0.4, decay: 4, vibratoRate: 3 });

    this.phaseUntil = tEnd + 10 + Math.random() * 6;
  }

  _beginNewMovement(time) {
    this.phase = 'normal';
    this.bpm = this.userTempo != null ? this.userTempo : this._pickNewTempo();
    this.root = pick([40, 43, 45, 47, 48]);
    this.mode = Math.random() < 0.7 ? 'aeolian' : 'dorian';
    this.progression = pick(PROGRESSIONS);
    this.movementEndBar = this._pickMovementLength();
    this._surging = false;
    this.intensityTarget = 0.3;
    this.macro.intensity = 0.3;
    this.kit.playFall(time, 1.4, { peak: 0.35 });
    this._initMovement();
    this._syncDelay();
    this.nextStepTime = Math.max(this.nextStepTime, time + 0.05);
    if (this.onMovementStart) this.onMovementStart({ root: this.root, mode: this.mode, bpm: this.bpm });
  }

  _syncDelay() {
    // Just under two beats -- the slow tempo leaves room for a long
    // cascading echo tail.
    this.core.setDelayTime((60 / this.bpm) * 1.9);
  }

  setTempo(bpm) {
    this.userTempo = bpm;
  }

  setSpace(v) {
    this.macro.space = clamp01(v);
    // Ride the shared reverb/delay returns.
    this.core.setReverbReturn(0.3 + v * 0.9);
    this.core.setDelayReturn(0.2 + v * 0.9);
  }

  setDensity(v) {
    this.macro.density = clamp01(v);
    this._makeHatPattern();
    this._makeLeadPattern();
  }

  setWarmth(v) {
    this.macro.warmth = clamp01(v);
  }

  triggerEnding() {
    if (this.phase !== 'normal') return;
    this.movementEndBar = 0;
  }
}

const PROGRESSIONS = [
  [0, 0, 3, 0],
  [0, 3, 0, 4],
  [0, 4, 3, 0],
  [0, 0, 5, 3],
];
