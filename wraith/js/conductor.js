import { MODES, DARK_ROOTS, PROGRESSIONS, buildChord, voiceChordOpen, bellPool, shepardBase, midiToFreq } from './theory.js';
import { DroneLayer } from './drone.js';
import { OrganLayer } from './organ.js';
import { MetallicLayer } from './metallic.js';
import { TextureLayer } from './texture.js';
import { ShepardLayer } from './shepard.js';
import { BassLayer } from './bass.js';

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Generative horror composer. Owns musical time via a lookahead scheduler and
// drives six voice layers around MOVEMENTS:
//
//   normal (build) … (one optional mid-movement "breath") …
//   ending (loud flourish + long tail)  →  normal …
//
// A movement is one short piece (~one minute): it holds a single key, mode,
// progression, tempo, mix character and bass-line density steady, while
// tension rises bar by bar (drone rides up, organ swells brighten, the high
// "eerie melody" and texture punctuation thicken, and a Shepard
// "forever-rising" dread glide climbs underneath). It ends in a terminating
// flourish — a hard organ swell + sub drop + a bell-pool run — followed by a
// long, lonely swell over the low drone floor.
// Then a fresh movement begins with a new key, tempo, character and bass
// density, so the session reads as a series of distinct short pieces.
//
// The bass line is a sparse, defiant minor melody whose TEMPORAL DENSITY is
// a per-movement feature (1.5–8 notes per 10 s, biased by the host's slider):
// note counts are derived from that density each bar, pitches come from an
// open-minor pool with short-term melodic memory, and the hits land on
// weighted eighth-note slots — so the line moves and changes instead of
// repeating a fixed root/5th pattern.
//
// The public surface (setters, triggerEnding, on* hooks, public fields)
// matches the ambient version, so embedding code keeps working:
//   onBar           = each bar index
//   onChord         = ({ root, mode, degree, midiNotes }) on each cell advance
//   onEnding        = () at the instant the terminating flourish triggers
//   onMovementStart = ({ root, mode, bpm, bassDensity }) a new movement begins

export class Conductor {
  constructor(audioCore) {
    this.core = audioCore;
    this.ctx = audioCore.ctx;

    this.drone = new DroneLayer(this.ctx, audioCore, { reverbAmount: 0.1 });
    this.organ = new OrganLayer(this.ctx, audioCore, { reverbAmount: 0.5, delayAmount: 0.05 });
    this.metallic = new MetallicLayer(this.ctx, audioCore, { reverbAmount: 0.8, delayAmount: 0.3 });
    this.texture = new TextureLayer(this.ctx, audioCore, { reverbAmount: 0.85 });
    this.shepard = new ShepardLayer(this.ctx, audioCore, { reverbAmount: 0.7 });
    this.bass = new BassLayer(this.ctx, audioCore, { reverbAmount: 0.65 });

    this.root = DARK_ROOTS[Math.floor(Math.random() * DARK_ROOTS.length)];
    this.mode = this._pickMode();
    this.progression = PROGRESSIONS[Math.floor(Math.random() * PROGRESSIONS.length)];
    this.chordIndex = 0;
    this.currentDegree = 0;
    this.nextChordBar = 0;
    this.bellNotes = [];

    this.baseBpm = 72;
    this.bpm = this.baseBpm;
    this.userTempo = null; // one-shot slider target, consumed at movement start
    this.beatsPerBar = 4;
    this.stepsPerBeat = 4; // 16th-note grid (for event alignment, not a running arp)

    this.lookahead = 25; // ms scheduler tick
    this.scheduleAheadTime = 0.15; // seconds
    this.nextStepTime = 0;
    this.stepCount = 0;
    this.timerID = null;

    // The mix's "character" — re-rolled per movement (anchored around the
    // user's slider settings), then only gently drifted within a movement.
    this.macro = {
      dread: 0.55, // dissonance / grit / timbre
      density: 0.55, // event density
      timbre: 0.5, // detune width / metallic edge
      droneLevel: 0.4,
      organLevel: 0.3,
      bassLevel: 0.4,
      metallicLevel: 0.28,
      textureLevel: 0.24,
    };

    // The movement.
    this.tension = 0.1; // 0..1, rises through a movement toward its ending
    this.phase = 'normal'; // 'normal' | 'ending'
    this.phaseUntil = 0;
    this.movementEndBar = 0; // global bar index at which this movement ends
    this.pendingEnding = false;
    this.breathed = false; // at most one mid-movement "breath" per movement
    this.shepardActive = false;
    this.shepardEnd = 0;

    // Bass line: the host's slider is the center; each movement picks a
    // density around it. The bar's plan (eighth slots + pitches) is made at
    // bar start and fired as the bar's steps elapse.
    this.bassDensityBase = 0.5;
    this.movementBassDensity = 0.5;
    this.lastBassSemi = 0; // melodic memory: offset of the last planned note
    this._bassPlan = null;

    this.running = false;

    // Embedding hooks (leave null to ignore).
    this.onBar = null; // (barIndex) => void
    this.onChord = null; // ({ root, mode, degree, midiNotes }) => void, on each cell advance
    this.onEnding = null; // () => void, the instant the terminating flourish triggers
    this.onMovementStart = null; // ({ root, mode, bpm, bassDensity }) => void, a new movement begins
  }

  _stepDuration() {
    return 60 / this.bpm / this.stepsPerBeat;
  }

  _pickMode() {
    const r = Math.random();
    if (r < 0.55) return 'aeolian';
    if (r < 0.85) return 'phrygian';
    return 'dorian';
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stepCount = 0;
    this.nextStepTime = this.ctx.currentTime + 0.1;
    this._beginNewMovement(0, this.nextStepTime, { first: true });
    this.drone.start(this.root, 7); // sub-octave bed: root + fifth
    this._rideTension();
    this.timerID = setInterval(() => this._scheduler(), this.lookahead);
  }

  stop() {
    this.running = false;
    if (this.timerID) clearInterval(this.timerID);
    this.timerID = null;
    this.drone.stop();
  }

  _scheduler() {
    while (this.nextStepTime < this.ctx.currentTime + this.scheduleAheadTime) {
      this._scheduleStep(this.stepCount, this.nextStepTime);
      this.nextStepTime += this._stepDuration();
      this.stepCount++;
    }
  }

  _scheduleStep(step, time) {
    const stepsPerBar = this.beatsPerBar * this.stepsPerBeat;
    const barIndex = Math.floor(step / stepsPerBar);
    const barStep = step % stepsPerBar;

    // Ending in progress: let the flourish and tail play out; no new events.
    if (this.phase !== 'normal') {
      if (time >= this.phaseUntil) this._beginNewMovement(barIndex, time);
      return;
    }

    if (barStep === 0) {
      this._onBar(barIndex, time);
      if (this.phase !== 'normal') return; // an ending just began — let it play
    }

    // Bass — the movement's sparse minor melody, fired on its eighth slots.
    if (this._bassPlan && barStep % 2 === 0 && this.macro.bassLevel > 0.05) {
      const ev = this._bassPlan.find((e) => e.eighth === barStep / 2);
      if (ev) this._fireBassNote(ev, time);
    }

    const isBeat = barStep % this.stepsPerBeat === 0;

    // Sparse high "eerie melody" — a few bell notes per bar at most.
    if (isBeat && (barStep === 0 || barStep === this.stepsPerBeat * 2)) {
      const chance = 0.05 + this.tension * 0.12;
      if (Math.random() < chance && this.bellNotes.length) this._fireBell(time);
    }
  }

  // One bass-melody note: a low, resonant, long-decay tone an octave below the
  // movement's key, sometimes doubled by the octave-up synth-string voice.
  _fireBassNote(ev, time) {
    const midi = this.root + ev.semi - 12;
    this.bass.playNote(midi, time, {
      velocity: 0.4 + this.tension * 0.2,
      attack: 0.25 + (1 - this.tension) * 0.35,
      hold: 0.5 + Math.random() * 0.6,
      release: 2.6 + Math.random() * 2.2,
      bright: 0.55 + this.macro.timbre * 0.35,
      detune: 6,
      unison: ev.unison,
    });
  }

  // Plan the bar's bass melody at bar start. The note count is derived from
  // the movement's density (roughly 1.5–8 notes per 10 s, scaled by the bar's
  // length), the notes land on weighted eighth-note positions, and the
  // pitches come from a "defiant" open-minor pool with short-term melodic
  // memory — so the line moves and changes from bar to bar instead of
  // repeating a fixed root/fifth pattern.
  _planBassBar() {
    const density = this.movementBassDensity;
    const notesPer10s = 1.5 + density * 6.5;
    const barDuration = this.beatsPerBar * (60 / this.bpm);
    const expected = notesPer10s * (barDuration / 10);

    let count = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0);
    count = Math.min(count, 4); // at most one note per eighth slot

    if (count === 0) return [];

    return this._pickBassEighths(count, density).map((eighth) => {
      const semi = this._pickBassSemi();
      this.lastBassSemi = semi;
      return { eighth, semi, unison: Math.random() < 0.4 };
    });
  }

  // Weighted pick of `count` distinct eighth-note slots (0..7) in the bar.
  // Downbeat-weighted; the off-beat slots open up as the density rises.
  _pickBassEighths(count, density) {
    const slots = [0, 1, 2, 3, 4, 5, 6, 7];
    const weight = (s) => (s % 2 === 0 ? 2.0 : 0.6 + density * 1.6) + (s === 0 ? 0.8 : 0);
    const chosen = [];
    while (chosen.length < count) {
      const remaining = slots.filter((s) => !chosen.includes(s));
      let total = 0;
      for (const s of remaining) total += weight(s);
      let r = Math.random() * total;
      let picked = remaining[remaining.length - 1];
      for (const s of remaining) {
        r -= weight(s);
        if (r <= 0) {
          picked = s;
          break;
        }
      }
      chosen.push(picked);
    }
    return chosen.sort((a, b) => a - b);
  }

  // A pitch from the movement's "defiant" open-minor pool: mostly root,
  // fifth and octave, with minor-3rd / b2 / 7th for menace. Half the time it
  // stays within ±4 semitones of the previous note, so the line reads as a
  // melody with memory rather than a roll call.
  _pickBassSemi() {
    const pool = [
      [0, 0.28], // root
      [7, 0.16], // fifth
      [12, 0.14], // octave
      [3, 0.14], // minor 3rd
      [1, 0.12], // b2 — Phrygian menace
      [10, 0.09], // minor 7th
      [8, 0.07], // minor 6th
    ];
    if (this.lastBassSemi != null && Math.random() < 0.5) {
      const near = pool.filter(([semi]) => Math.abs(semi - this.lastBassSemi) <= 4);
      if (near.length) {
        let total = 0;
        for (const [, w] of near) total += w;
        let r = Math.random() * total;
        for (const [semi, w] of near) {
          r -= w;
          if (r <= 0) return semi;
        }
      }
    }
    let total = 0;
    for (const [, w] of pool) total += w;
    let r = Math.random() * total;
    for (const [semi, w] of pool) {
      r -= w;
      if (r <= 0) return semi;
    }
    return pool[pool.length - 1][0];
  }

  _fireBell(time) {
    const midi = this.bellNotes[Math.floor(Math.random() * this.bellNotes.length)];
    this.metallic.strike(midi, time, { decay: 2 + Math.random() * 3, ringAmount: 0.2 + this.macro.timbre * 0.3, beats: 6 + this.macro.dread * 8 });
    // Occasionally a dissonant neighbor a semitone away for extra unease.
    if (Math.random() < 0.3) {
      const neighbor = midi + (Math.random() < 0.5 ? 1 : -1);
      this.metallic.strike(neighbor, time + 0.02, { decay: 1.5, ringAmount: 0.3, beats: 10 });
    }
  }

  _onBar(barIndex, time) {
    if (this.onBar) this.onBar(barIndex);

    if (barIndex >= this.nextChordBar) this._advanceCell(barIndex, time);

    // Small character drift within the movement (otherwise held steady).
    if (barIndex % 4 === 0) this._driftMacros();

    // Let a finished Shepard glide retire so a fresh one can start.
    if (this.shepardActive && time >= this.shepardEnd) this.shepardActive = false;

    // Tension builds bar by bar toward the movement's ending.
    this.tension = clamp01(this.tension + (1 - this.tension) * (0.06 + Math.random() * 0.05));

    // At most one mid-movement "breath": a withheld, slow release that eases
    // the tension back down, then the build continues in the same key.
    if (!this.breathed && this.tension >= 0.62 && Math.random() < 0.5) {
      this.breathed = true;
      this._midMovementBreath(time);
    }

    // Plan this bar's bass melody (uses the freshly-updated tension/density).
    this._bassPlan = this._planBassBar();

    // Start a rising-dread glide once the build is underway.
    if (this.tension > 0.35 && !this.shepardActive) this._startShepard(time);

    this._maybeTexture(time);
    this._rideTension();

    // End of the movement (or a host-forced ending): the terminating flourish.
    if (barIndex >= this.movementEndBar || this.pendingEnding) {
      this.pendingEnding = false;
      this._beginEnding(time);
    }
  }

  _advanceCell(barIndex, time) {
    const degree = this.progression[this.chordIndex % this.progression.length];
    this.chordIndex++;
    this.currentDegree = degree;

    const chordSemis = buildChord(0, this.mode, degree, { seventh: false });
    const swellNotes = voiceChordOpen(this.root, chordSemis);

    const holdBars = this._pickHoldBars();
    this.nextChordBar = barIndex + holdBars;
    const holdDuration = holdBars * this.beatsPerBar * (60 / this.bpm);

    const t = this.tension;
    const cutoff = 420 + (1 - this.macro.dread) * 500 + t * 1000;
    const attack = Math.max(1.2, 4 - t * 2.5);
    const hold = Math.max(0.5, holdDuration - attack - 3);
    this.organ.playSwell(swellNotes, time, { attack, hold, release: 5, cutoff, velocity: 0.13 + t * 0.15, detune: 4 + this.macro.timbre * 5 });

    this.bellNotes = bellPool(this.root, this.mode, degree);

    if (this.onChord) this.onChord({ root: this.root, mode: this.mode, degree, midiNotes: swellNotes });
  }

  _startShepard(time) {
    this.shepardActive = true;
    const duration = 8 + Math.random() * 8;
    this.shepard.glide(time, { duration, direction: 1, velocity: 0.06 + this.tension * 0.06, baseMidi: shepardBase(this.root), steps: 12 });
    this.shepardEnd = time + duration;
  }

  _maybeTexture(time) {
    const t = this.tension;
    const roll = Math.random();
    const base = 0.02 + t * 0.1 + this.macro.textureLevel * 0.05;
    if (roll < base * 0.5) {
      this.texture.scrape(time, { duration: 1.5 + Math.random() * 2, velocity: 0.08 + t * 0.12, fromHz: 420 + Math.random() * 400, toHz: 150 + Math.random() * 120 });
    } else if (roll < base) {
      this.texture.creak(time, { duration: 2 + Math.random() * 3, velocity: 0.06 + t * 0.1, fromMidi: 30 + Math.floor(Math.random() * 5), toMidi: 22 + Math.floor(Math.random() * 4) });
    } else if (roll < base * 1.3) {
      this.texture.crackle(time, { duration: 0.8 + Math.random(), velocity: 0.1 + t * 0.15 });
    }
    // Occasional wind/room swell underneath.
    if (Math.random() < 0.05 + t * 0.05) {
      this.texture.swell(0.06 + t * 0.08, 3 + Math.random() * 3, 2 + Math.random() * 3, 4 + Math.random() * 4, time);
    }
  }

  // Ride every layer's level and character up with the current tension.
  _rideTension() {
    const t = this.tension;
    this.drone.setLevel(this.macro.droneLevel * (0.45 + t * 0.9));
    this.drone.setDepth(0.15 + t * 0.5);
    this.drone.setCutoff(0.2 + t * 0.5);
    this.organ.setLevel(this.macro.organLevel * (0.7 + t * 0.5));
    this.bass.setLevel(this.macro.bassLevel * (0.9 + t * 0.6));
    this.metallic.setLevel(this.macro.metallicLevel * (0.6 + t * 0.6));
    this.texture.setWindLevel(this.macro.textureLevel * (0.35 + t * 0.8));
  }

  // The terminating flourish of a movement: a loud dissonant payoff, a
  // bell-pool flourish run, then a long, lonely tail over the low drone
  // floor — after which a fresh movement begins.
  _beginEnding(time) {
    this.phase = 'ending';
    this.shepardActive = false;
    if (this.onEnding) this.onEnding();

    const degree = this.currentDegree;
    const chord = buildChord(this.root, this.mode, degree, { seventh: false });
    const notes = voiceChordOpen(this.root, chord);

    // The detonation: a hard organ swell + metallic ring + sub drop + texture snap.
    this.organ.playSwell(notes, time, { attack: 0.06, hold: 1.6, release: 3.5, cutoff: 2400, velocity: 0.32, detune: 6 });
    this.metallic.ringAccent(time, { freq: midiToFreq(this.root + 24), ratio: 3.1, decay: 1.5, velocity: 0.18 });
    this.bass.subDrop(this.root - 24, time, { steps: 7, duration: 1.1, velocity: 0.7 });
    this.texture.crackle(time, { duration: 1.6, velocity: 0.32 });

    // The flourish: a bell-pool run — ascending, descending, an arch, or a
    // scattered run — just after the detonation.
    this._flourishRun(time + 0.12);

    // The tail: one lone, long, lonely swell, and a final bell to hang in
    // the reverb over the sunk drone floor.
    const tailAttack = 2.5 + Math.random() * 1.5;
    const tailHold = 4 + Math.random() * 4;
    this.organ.playSwell(notes, time + 0.5, { attack: tailAttack, hold: tailHold, release: 6, cutoff: 700, velocity: 0.22, detune: 5 });
    if (this.bellNotes.length) {
      this.metallic.strike(this.bellNotes[Math.floor(Math.random() * this.bellNotes.length)], time + 0.5, { decay: 4, ringAmount: 0.25 });
    }
    this.texture.swell(0.1, 0.3, 1.5, 2.0, time + 0.5);

    // Sink the drone toward a low, lonely floor for the tail.
    this.drone.setLevel(this.macro.droneLevel * 0.35);

    this.phaseUntil = time + 0.5 + tailAttack + tailHold + 3;
  }

  // The flourish run of the ending: a quick pass over the movement's bell
  // pool in a chosen shape and pacing, struck with the metallic voice.
  _flourishRun(start) {
    const pool = this.bellNotes.slice().sort((a, b) => a - b);
    if (!pool.length) return;

    const roll = Math.random();
    let notes;
    if (roll < 0.3) {
      notes = pool; // ascending
    } else if (roll < 0.6) {
      notes = pool.slice().reverse(); // descending
    } else if (roll < 0.8) {
      notes = pool.concat(pool.slice(0, -1).reverse()); // arch
    } else {
      notes = pool.slice(); // scattered
      for (let i = notes.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [notes[i], notes[j]] = [notes[j], notes[i]];
      }
    }

    // Pacing: even, accelerating, or decelerating.
    const baseGap = 0.05 + Math.random() * 0.06;
    const pacing = Math.random();
    let t = 0;
    notes.forEach((midi, i) => {
      if (i > 0) {
        const frac = i / (notes.length - 1);
        const gap = pacing < 0.33 ? baseGap * (1 - 0.5 * frac) : pacing < 0.66 ? baseGap * (1 + frac) : baseGap;
        t += gap;
      }
      this.metallic.strike(midi, start + t, {
        decay: 1.5 + Math.random() * 2,
        ringAmount: 0.25 + this.macro.timbre * 0.2,
        beats: 6,
      });
    });
  }

  // A withheld mid-movement release: a big slow swell, no stinger — then the
  // tension eases and the same key keeps building toward the ending.
  _midMovementBreath(time) {
    const chord = buildChord(this.root, this.mode, this.currentDegree, { seventh: false });
    this.organ.playSwell(voiceChordOpen(this.root, chord), time, { attack: 3, hold: 3, release: 5, cutoff: 650, velocity: 0.2, detune: 5 });
    if (this.bellNotes.length) {
      this.metallic.strike(this.bellNotes[Math.floor(Math.random() * this.bellNotes.length)], time + 0.4, { decay: 4, ringAmount: 0.2 });
    }
    this.drone.setLevel(this.macro.droneLevel * 0.45);
    this.tension = 0.28 + Math.random() * 0.08;
  }

  // A fresh movement: new key, mode, progression, tempo, bass density and mix
  // character — all held (roughly) steady until this movement's ending.
  _beginNewMovement(barIndex, time, { first = false } = {}) {
    this.phase = 'normal';
    this.breathed = false;
    this.pendingEnding = false;
    this.tension = 0.08 + Math.random() * 0.08;
    this.shepardActive = false;
    this.lastBassSemi = 0;

    this.root = DARK_ROOTS[Math.floor(Math.random() * DARK_ROOTS.length)];
    this.mode = this._pickMode();
    this.progression = PROGRESSIONS[Math.floor(Math.random() * PROGRESSIONS.length)];
    this.chordIndex = 0;
    this.currentDegree = 0;
    // Tempo is a one-shot slider target or a fresh re-roll around the base
    // -- never pinned across movements.
    const t = this.userTempo;
    this.userTempo = null;
    this.bpm = t != null ? Math.round(clamp(t, 46, 100))
      : Math.round(clamp(this.baseBpm + (Math.random() - 0.5) * 14, 46, 100));
    this._syncDelay();
    this.movementBassDensity = clamp01(this.bassDensityBase + (Math.random() - 0.5) * 0.5);
    this._rollCharacter();

    // A fresh length: roughly one minute of bars at this tempo.
    const bars = Math.round((this.bpm / 4) * (0.8 + Math.random() * 0.5));
    this.movementEndBar = barIndex + Math.max(8, bars);

    this.drone.setPitch(this.root); // glide the bed to the new key
    this._rideTension();

    if (!first && this.onMovementStart) {
      this.onMovementStart({ root: this.root, mode: this.mode, bpm: this.bpm, bassDensity: this.movementBassDensity });
    }

    // Let the harmony begin, and have a bass plan ready for the first bar.
    this._advanceCell(barIndex, time);
    this._bassPlan = this._planBassBar();
  }

  // Re-roll the mix's character for a new movement: a clear step from the
  // last movement, but anchored around the user's slider settings so the
  // sliders stay meaningful as centers.
  _rollCharacter() {
    this.macro.dread = clamp01(this.macro.dread + (Math.random() - 0.5) * 0.5);
    this.macro.density = clamp01(this.macro.density + (Math.random() - 0.5) * 0.4);
    this.macro.timbre = clamp01(this.macro.timbre + (Math.random() - 0.5) * 0.5);
    this.macro.droneLevel = clamp01(0.25 + Math.random() * 0.3);
    this.macro.organLevel = clamp01(0.2 + Math.random() * 0.25);
    this.macro.bassLevel = clamp01(0.4 + Math.random() * 0.3);
    this.macro.metallicLevel = clamp01(0.18 + Math.random() * 0.25);
    this.macro.textureLevel = clamp01(0.12 + Math.random() * 0.25);
    this.organ.setFilterRate(0.02 + this.tension * 0.12);
  }

  // Small drift within a movement (every few bars) — the character is
  // otherwise held steady until the ending.
  _driftMacros() {
    this.macro.dread = clamp01(this.macro.dread + (Math.random() - 0.5) * 0.1);
    this.macro.density = clamp01(this.macro.density + (Math.random() - 0.5) * 0.08);
    this.macro.timbre = clamp01(this.macro.timbre + (Math.random() - 0.5) * 0.1);
  }

  _pickHoldBars() {
    const opts = [3, 4, 4, 5, 6];
    return opts[Math.floor(Math.random() * opts.length)];
  }

  // Re-roll the delay time each movement: one of three BPM-locked
  // spacings (3/4 beat, 1 beat, just under 2 beats for the cascade tail).
  // This logic is identical across all nine engines.
  _syncDelay() {
    const beats = [0.75, 1, 1.9][Math.floor(Math.random() * 3)];
    this.core.setDelayTime((60 / this.bpm) * beats);
  }

  // ---- Public control surface (same names as the ambient version) ----

  setTempo(bpm) {
    // One-shot: applied to the next movement start, then re-rolls freely.
    this.userTempo = bpm;
  }

  setDarknessOverride(v) {
    this.macro.dread = clamp01(v);
  }

  setDensityOverride(v) {
    this.macro.density = clamp01(v);
  }

  setTimbreOverride(v) {
    this.macro.timbre = clamp01(v);
  }

  // Bias the bass line's temporal density (0 = very sparse, 1 = dense). Each
  // movement picks a density around this value; the slider applies live to
  // the current movement too.
  setBassDensityOverride(v) {
    this.bassDensityBase = clamp01(v);
    this.movementBassDensity = clamp01(this.bassDensityBase + (Math.random() - 0.5) * 0.2);
  }

  // Force the movement's ending at the next bar instead of waiting for its
  // scheduled length.
  triggerEnding() {
    if (this.phase !== 'normal') return;
    this.pendingEnding = true;
  }

  // Convenience alias for horror hosts.
  triggerStinger() {
    this.triggerEnding();
  }
}
