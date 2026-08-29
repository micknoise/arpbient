import { MODES, DARK_ROOTS, PROGRESSIONS, buildChord, buildDissonantCluster, voiceChordOpen, bellPool, shepardBase, midiToFreq } from './theory.js';
import { DroneLayer } from './drone.js';
import { OrganLayer } from './organ.js';
import { StabLayer } from './stabs.js';
import { MetallicLayer } from './metallic.js';
import { TextureLayer } from './texture.js';
import { ShepardLayer } from './shepard.js';
import { BassLayer } from './bass.js';

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// Generative horror composer. Owns musical time via a lookahead scheduler and
// drives seven voice layers around a TENSION CYCLE:
//
//   build  →  (loud stinger + near-silence)  |  (withheld, slow release)  →  build …
//
// A low drone bed is always present. During a "build", tension rises and every
// layer rides up with it — the organ swells brighten, dissonant stabs and the
// high metallic "eerie melody" come in thicker, texture punctuation (scrape,
// creak, crackle) gets more frequent, and a Shepard "forever-rising" dread
// glide climbs underneath. At the top of the build the cycle either pays off
// in a full-band dissonant stinger + sub-drop followed by near-silence, or
// withholds and exhales into a slow, lonely swell before a fresh cell begins.
//
// The public surface (setters, triggerEnding, on* hooks, public fields) is the
// same as the ambient version, so embedding code keeps working:
//   onEnding       = the payoff moment (stinger or withheld release)
//   onMovementStart = a new harmonic cell begins after the payoff

export class Conductor {
  constructor(audioCore) {
    this.core = audioCore;
    this.ctx = audioCore.ctx;

    this.drone = new DroneLayer(this.ctx, audioCore, { reverbAmount: 0.1 });
    this.organ = new OrganLayer(this.ctx, audioCore, { reverbAmount: 0.5, delayAmount: 0.05 });
    this.stabs = new StabLayer(this.ctx, audioCore, { reverbAmount: 0.5, delayAmount: 0.1, gritAmount: 0.5 });
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
    this.beatsPerBar = 4;
    this.stepsPerBeat = 4; // 16th-note grid (for event alignment, not a running arp)

    this.lookahead = 25; // ms scheduler tick
    this.scheduleAheadTime = 0.15; // seconds
    this.nextStepTime = 0;
    this.stepCount = 0;
    this.timerID = null;

    // Slowly drifting "character" of the mix (random-walked every few bars).
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

    // The tension cycle.
    this.tension = 0.1; // 0..1, rises through a build
    this.phase = 'build'; // 'build' | 'payoff'
    this.phaseUntil = 0;
    this.lastWasLoud = false;
    this.pendingPayoff = false;
    this.shepardActive = false;
    this.shepardEnd = 0;
    this._bassPlan = null;

    this.running = false;

    // Embedding hooks (leave null to ignore).
    this.onBar = null; // (barIndex) => void
    this.onChord = null; // ({ root, mode, degree, midiNotes }) => void, on each cell advance
    this.onEnding = null; // () => void, the instant the payoff triggers
    this.onMovementStart = null; // ({ root, mode, bpm }) => void, a new cell begins
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
    this.chordIndex = 0;
    this.stepCount = 0;
    this.phase = 'build';
    this.tension = 0.1;
    this.nextChordBar = 0;
    this.shepardActive = false;
    this.pendingPayoff = false;
    this.drone.start(this.root, 7); // sub root + fifth
    this.nextStepTime = this.ctx.currentTime + 0.1;
    this._advanceCell(0, this.nextStepTime);
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

    // Payoff in progress: resolve it once its window elapses, then no new events.
    if (this.phase !== 'build') {
      if (time >= this.phaseUntil) this._beginRebuild(barIndex, time);
      return;
    }

    if (barStep === 0) this._onBar(barIndex, time);

    const isBeat = barStep % this.stepsPerBeat === 0;

    // Bass — a sparse, defiant minor MELODY, not a pulse. One or two long,
    // resonant notes are planned at bar start (this._bassPlan) and fired here
    // on their beats, with real space between them.
    if (isBeat && this._bassPlan) {
      const beat = Math.floor(barStep / this.stepsPerBeat);
      const ev = this._bassPlan.find((e) => e.beat === beat);
      if (ev && this.macro.bassLevel > 0.05) this._fireBassNote(ev, time);
    }

    // Dissonant stabs — density rises with tension, on beats plus off-beat menace.
    if (isBeat) {
      const chance = 0.04 + this.tension * 0.3 + this.macro.density * 0.08;
      if (Math.random() < chance) this._fireStab(time);
    } else if (Math.random() < 0.004 + this.tension * 0.02) {
      this._fireStab(time);
    }

    // Sparse high "eerie melody" — a few bell notes per bar at most.
    if (isBeat && (barStep === 0 || barStep === this.stepsPerBeat * 2)) {
      const chance = 0.05 + this.tension * 0.12;
      if (Math.random() < chance && this.bellNotes.length) this._fireBell(time);
    }
  }

  // One bass-melody note: a low, resonant, long-decay tone an octave below the
  // cell's key, sometimes doubled by the octave-up synth-string voice.
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

  // Plan the bar's sparse bass line at bar start. A "defiant" minor spine —
  // mostly the root, fifth, and octave — with the odd passing minor-3rd /
  // b2 for menace. One note (mostly) or two, always on strong beats, so there
  // is real silence between them.
  _planBassBar() {
    const t = this.tension;
    const twoNotes = Math.random() < 0.22 + t * 0.35;
    const maybeUnison = () => Math.random() < 0.45;

    const spine = [0, 7, 12, 0, 7];   // root, fifth, octave — open-minor defiant
    const passing = [3, 1, 3, 7];     // minor 3rd, b2, minor 3rd, fifth

    const first = spine[Math.floor(Math.random() * spine.length)];
    const evs = [{ beat: 0, semi: first, unison: maybeUnison() }];

    if (twoNotes) {
      const beat2 = Math.random() < 0.5 ? 2 : 3;
      const semi2 = passing[Math.floor(Math.random() * passing.length)];
      evs.push({ beat: beat2, semi: semi2, unison: maybeUnison() });
    }
    return evs;
  }

  _fireStab(time) {
    const cluster = buildDissonantCluster(this.root, this.mode, this.currentDegree, { size: 3 + Math.floor(this.tension * 3) });
    this.stabs.playStab(cluster, time, {
      cutoffBase: 3200 + this.macro.dread * 2500 + this.tension * 1800,
      q: 4 + this.macro.dread * 5,
      velocity: 0.18 + this.tension * 0.2,
      decay: 0.3 + Math.random() * 0.3,
    });
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

    if (barIndex % 4 === 0) this._driftMacros();

    // Let a finished Shepard glide retire so we can start a fresh one.
    if (this.shepardActive && time >= this.shepardEnd) this.shepardActive = false;

    // Tension builds each bar through a cycle.
    this.tension = clamp01(this.tension + 0.012 + Math.random() * 0.022 + this.macro.density * 0.006);

    // Plan this bar's sparse bass melody (uses the freshly-updated tension).
    this._bassPlan = this._planBassBar();

    // Start a rising-dread glide once the build is underway.
    if (this.tension > 0.35 && !this.shepardActive) this._startShepard(time);

    this._maybeTexture(time);
    this._rideTension();

    // Top of the build: pay off, or a forced stinger.
    if (this.tension >= 1.0 || this.pendingPayoff) {
      this.pendingPayoff = false;
      this._beginPayoff(time);
    }
  }

  _advanceCell(barIndex, time) {
    const degree = this.progression[this.chordIndex % this.progression.length];
    this.chordIndex++;
    this.currentDegree = degree;
    if (this.chordIndex % this.progression.length === 0 && Math.random() < 0.3) {
      this.progression = PROGRESSIONS[Math.floor(Math.random() * PROGRESSIONS.length)];
    }

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

  // The payoff: a loud dissonant stinger + near-silence, or a withheld,
  // slow exhale. Either ends the build and leads into a fresh cell.
  _beginPayoff(time) {
    this.phase = 'payoff';
    this.shepardActive = false;
    if (this.onEnding) this.onEnding();
    const degree = this.currentDegree;
    const loud = Math.random() < 0.6;

    if (loud) {
      const cluster = buildDissonantCluster(this.root, this.mode, degree, { size: 6 });
      this.stabs.playStab(cluster, time, { cutoffBase: 6000, q: 6, velocity: 0.5, decay: 0.6 });
      this.stabs.playStab(buildDissonantCluster(this.root, this.mode, degree, { size: 5, octave: 1 }), time + 0.03, { cutoffBase: 4800, q: 6, velocity: 0.35, decay: 0.55 });
      const chord = buildChord(this.root, this.mode, degree, { seventh: false });
      this.organ.playSwell(chord, time, { attack: 0.06, hold: 1.6, release: 3.5, cutoff: 2400, velocity: 0.32, detune: 6 });
      this.metallic.ringAccent(time, { freq: midiToFreq(this.root + 24), ratio: 3.1, decay: 1.5, velocity: 0.18 });
      this.bass.subDrop(this.root - 24, time, { steps: 7, duration: 1.1, velocity: 0.7 });
      this.texture.crackle(time, { duration: 1.6, velocity: 0.32 });
      this.texture.swell(0.12, 0.2, 0.6, 1.6, time);
      this.phaseUntil = time + 3 + Math.random() * 2;
      this.lastWasLoud = true;
    } else {
      // Withheld release — a big slow swell, no stinger, then near-silence.
      const chord = buildChord(this.root, this.mode, degree, { seventh: false });
      const notes = voiceChordOpen(this.root, chord);
      this.organ.playSwell(notes, time, { attack: 3, hold: 4, release: 6, cutoff: 700, velocity: 0.24, detune: 5 });
      if (this.bellNotes.length) {
        this.metallic.strike(this.bellNotes[Math.floor(Math.random() * this.bellNotes.length)], time + 0.4, { decay: 4, ringAmount: 0.25 });
      }
      this.phaseUntil = time + 7 + Math.random() * 3;
      this.lastWasLoud = false;
    }

    // Sink the drone toward a low, lonely floor for the near-silence.
    this.drone.setLevel(this.macro.droneLevel * 0.35);
  }

  _beginRebuild(barIndex, time) {
    this.phase = 'build';
    this.tension = 0.08 + Math.random() * 0.08;
    this.shepardActive = false;
    this._bassPlan = this._planBassBar();

    this.root = DARK_ROOTS[Math.floor(Math.random() * DARK_ROOTS.length)];
    if (Math.random() < 0.4) this._shiftMode();
    this.progression = PROGRESSIONS[Math.floor(Math.random() * PROGRESSIONS.length)];
    this.chordIndex = 0;
    this.nextChordBar = 0;

    this.drone.setPitch(this.root); // glide the bed to the new key
    this._rideTension();

    if (this.onMovementStart) this.onMovementStart({ root: this.root, mode: this.mode, bpm: this.bpm });
    this._advanceCell(barIndex, time);
  }

  _shiftMode() {
    this.mode = this._pickMode();
  }

  _pickHoldBars() {
    const opts = [3, 4, 4, 5, 6];
    return opts[Math.floor(Math.random() * opts.length)];
  }

  _driftMacros() {
    this.macro.dread = clamp01(this.macro.dread + (Math.random() - 0.5) * 0.28);
    this.macro.density = clamp01(this.macro.density + (Math.random() - 0.5) * 0.22);
    this.macro.timbre = clamp01(this.macro.timbre + (Math.random() - 0.5) * 0.2);
    this.macro.droneLevel = clamp01(0.25 + Math.random() * 0.3);
    this.macro.organLevel = clamp01(0.2 + Math.random() * 0.25);
    this.macro.bassLevel = clamp01(0.4 + Math.random() * 0.3);
    this.macro.metallicLevel = clamp01(0.18 + Math.random() * 0.25);
    this.macro.textureLevel = clamp01(0.12 + Math.random() * 0.25);
    this.organ.setFilterRate(0.02 + this.tension * 0.12);
  }

  // ---- Public control surface (same names as the ambient version) ----

  setTempo(bpm) {
    this.baseBpm = bpm;
    this.bpm = bpm;
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

  // Force the payoff at the next bar instead of waiting for the build to peak.
  triggerEnding() {
    if (this.phase !== 'build') return;
    this.pendingPayoff = true;
  }

  // Convenience alias for horror hosts.
  triggerStinger() {
    this.triggerEnding();
  }
}
