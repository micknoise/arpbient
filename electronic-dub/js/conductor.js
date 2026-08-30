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

    // Bass ostinato held 4-8 bars before it takes a new phrase.
    this.bassHoldBars = randInt(4, 8);
    // Bar index whose grid lead is replaced by a polyrhythmic phrase.
    this.polyBar = -1;

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

    // Tempo from the slider is a *target*: it only takes effect at a
    // movement boundary, so tempo never changes mid-movement.
    this.userTempo = null;

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
    this._makeLeadPattern();
    this._makeHatPattern();
    this.kickPat = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    this.clapPat = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
    this.rimPat = new Array(16).fill(0);
    this.skankPat = [0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.8, 0];
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

    // Kick -- lighter pump than techno; dub is about the tails, not the
    // thump.
    const kv = this.kickPat[barStep];
    if (kv > 0) {
      this.kit.playKick(time, { velocity: kv, decay: 0.35, click: 0.25 });
      this.core.pump(time, { depth: 0.3, release: 0.25 });
    }

    const cv = this.clapPat[barStep];
    if (cv > 0) this.kit.playClap(time, { velocity: cv * 0.9, frequency: 1300, hits: 2, pan: 0.1 });

    if (this.hatPat[barStep] > 0) {
      this.kit.playHat(time, {
        velocity: this.hatPat[barStep],
        frequency: 9500,
        decay: 0.03,
        pan: barStep % 8 === 2 ? -0.35 : 0.35,
      });
    }

    if (this.rimPat[barStep] > 0) {
      this.kit.playRim(time, { velocity: this.rimPat[barStep], frequency: 800, pan: -0.2 });
    }

    // Long-decay syncopated bass. Sometimes this is the only thing going.
    const b = this.bassPat[barStep];
    if (b) {
      this.bass.playNote(this.root - 12 + b.pc, time, {
        cutoffBase: 380 + b.vel * 200,
        cutoffFloor: 60,
        q: 2.5,
        velocity: b.vel,
        decay: b.len,
        subLevel: 0.75,
      });
      // Occasional echo swell riding the bass tail.
      if (Math.random() < 0.06) this._echoBurst(time);
    }

    // Skank stabs -- the offbeat chord that defines the reggae feel.
    const sv = this.skankPat[barStep];
    if (sv > 0 && this.macro.section === 'full') {
      this.lead.stab(this.stabNotes, time, {
        cutoffBase: 2200 + this.macro.intensity * 900,
        q: 1.2,
        velocity: sv * 0.45,
        decay: 0.16,
      });
    }

    // Sparse long melody notes (skipped on the polyrhythm bar).
    const l = this.leadPat[barStep];
    if (l && this.macro.section === 'full' && barIndex !== this.polyBar) {
      this.lead.note(this.leadPool[l.noteIdx % this.leadPool.length], time, {
        cutoffBase: 1400 + this.macro.intensity * 900,
        q: 3,
        velocity: l.vel,
        decay: 0.5 + this.macro.intensity * 0.6,
        vibrato: 0.2,
      });
    }
  }

  _onBar(barIndex, time) {
    if (this.onBar) this.onBar(barIndex);

    // One chord per bar, cycling the slow i-rooted cell. Bar 0 already has
    // the chord established at movement start.
    if (barIndex > 0) this._advanceChord(time);

    // Section switches: full groove vs "stripped" dub-out (kick + bass +
    // tails only).
    if (barIndex >= this.sectionUntilBar && barIndex > 0) {
      const r = Math.random();
      this.macro.section = r < 0.65 ? 'full' : 'stripped';
      this.sectionUntilBar = barIndex + (this.macro.section === 'stripped' ? randInt(4, 8) : randInt(8, 16));
      this._applyLevels();
    }

    // Mutations -- the bass ostinato holds its phrase for 4-8 bars; the
    // skank and hats stay fluid.
    if (Math.random() < 0.2) this._mutateKick();
    if (Math.random() < 0.3) this._mutateSkank();
    if (Math.random() < 0.35) this._makeHatPattern();
    this.bassHoldBars--;
    if (this.bassHoldBars <= 0) {
      this._makeBassPattern();
      this.bassHoldBars = randInt(4, 8);
    }
    if (this.macro.section === 'full' && Math.random() < 0.4) this._makeLeadPattern();

    // The dub magic: random dropouts and echo swells, scaled by the
    // Dropouts slider.
    if (this.macro.dropout > 0 && Math.random() < this.macro.dropout * 0.55) {
      this._dropout(time);
    }
    if (Math.random() < 0.1 + this.macro.dropout * 0.2) {
      this._echoBurst(time + this._stepDuration() * 4);
    }

    // Occasionally the melody runs a polyrhythmic phrase (3-against-2,
    // 5-against-4, ...) against the grid.
    if (this.macro.section === 'full' && barIndex > 0 && Math.random() < 0.15) {
      this.polyBar = barIndex;
      this._playPolyPhrase(time);
    }

    // Macro drift
    const target = 0.25 + Math.random() * 0.5;
    this.macro.intensity = clamp01(this.macro.intensity + (target - this.macro.intensity) * 0.4);

    if (barIndex >= this.movementEndBar) {
      this._beginEnding(time);
    }
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

  // Long-decay one-drop bass phrases, held for 4-8 bars.
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

  _mutateSkank() {
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

  _mutateKick() {
    const r = Math.random();
    if (r < 0.3) {
      // Extra backbeat answer.
      this.kickPat[10] = 0.55;
    } else if (r < 0.5) {
      this.kickPat[10] = 0;
      this.kickPat[12] = 0.6;
    } else {
      this.kickPat[10] = 0;
      this.kickPat[12] = 0;
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

  // Polyrhythmic melody phrase: N evenly-spaced notes over M beats,
  // scheduled off the 16th grid.
  _playPolyPhrase(time) {
    const barDur = (4 * 60) / this.bpm;
    const [n, beats] = pick([[3, 2], [5, 4], [7, 4], [5, 2]]);
    const span = beats * (barDur / 4);
    const start = time + (Math.random() < 0.5 ? 0 : barDur / 2);
    for (let i = 0; i < n; i++) {
      const t = start + (span * i) / n;
      this.lead.note(pick(this.leadPool), t, {
        cutoffBase: 1800,
        q: 3,
        velocity: 0.32,
        decay: 0.7,
        vibrato: 0.25,
      });
    }
  }

  _pickMovementLength() {
    return randInt(24, 48); // ~70s-135s at dub tempos
  }

  _pickNewTempo() {
    return randInt(74, 92);
  }

  _applyLevels() {
    const s = this.macro.section;
    const bassL = s === 'stripped' ? 0.6 : 0.5 + this.macro.intensity * 0.15;
    const leadL = s === 'stripped' ? 0.0 : 0.35 + this.macro.intensity * 0.15;
    const drumL = s === 'stripped' ? 0.75 : 0.85;
    this.bass.setLevel(clamp01(bassL));
    this.lead.setLevel(clamp01(leadL));
    this.kit.setLevel(clamp01(drumL));
    this.kit.setKickLevel(0.9);
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
    this.baseBpm = this.userTempo != null ? this.userTempo : this._pickNewTempo();
    this.bpm = this.baseBpm;
    this.root = pick([40, 43, 45, 47, 48]);
    this.mode = Math.random() < 0.6 ? 'aeolian' : 'major';
    this.progression = pick(PROGRESSIONS);
    this.movementEndBar = this._pickMovementLength();
    this.sectionUntilBar = 0;
    this._initMovement();
    this._syncDelay();
    this.nextStepTime = Math.max(this.nextStepTime, time + 0.05);
    if (this.onMovementStart) this.onMovementStart({ root: this.root, mode: this.mode, bpm: this.bpm });
  }

  // Sync the shared delay to the movement's tempo (dotted-8th -- the
  // classic dub echo length).
  _syncDelay() {
    this.core.setDelayTime((60 / this.bpm) * 0.75);
  }

  // Target tempo only -- applied at the next movement boundary (or on the
  // next start), never mid-movement.
  setTempo(bpm) {
    this.userTempo = bpm;
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
