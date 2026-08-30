// Harmony + scale helpers shared by every engine: modal scales, diatonic
// chord building, voicings, and note-pool builders. Genre-specific roots
// and progressions live in each engine's conductor.

export const MODES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function randInt(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

function degreeToSemitone(mode, degree) {
  const scale = MODES[mode];
  const len = scale.length;
  const idx = ((degree % len) + len) % len;
  const octaves = Math.floor(degree / len);
  return scale[idx] + 12 * octaves;
}

// Returns semitone offsets (relative to root) for a diatonic chord built
// on the given scale degree, stacking thirds within the mode.
export function buildChord(mode, degree, { seventh = true, add9 = false } = {}) {
  const tones = [degree, degree + 2, degree + 4];
  if (seventh) tones.push(degree + 6);
  if (add9) tones.push(degree + 8);
  return tones.map((d) => degreeToSemitone(mode, d));
}

// Spreads chord tones across octaves for an open, non-muddy pad voicing.
export function voiceChordOpen(rootMidi, chordSemitones) {
  return chordSemitones.map((semi, i) => {
    const pitchClass = ((semi % 12) + 12) % 12;
    let octaveShift;
    if (i === 0) octaveShift = 0;
    else if (i === 1) octaveShift = 12;
    else if (i === 2) octaveShift = 12;
    else octaveShift = 24;
    return rootMidi + pitchClass + octaveShift;
  });
}

// Builds a higher-register note pool (two octaves) from chord tones,
// for arpeggiators and sequenced leads.
export function buildArpPool(rootMidi, chordSemitones, baseOctaveShift = 12) {
  const classes = chordSemitones.map((s) => ((s % 12) + 12) % 12);
  const pool = [];
  [0, 12].forEach((add) => {
    classes.forEach((pc) => pool.push(rootMidi + baseOctaveShift + add + pc));
  });
  return pool;
}

// A scale-tone melodic pool spanning `octaves` octaves above the root.
// Used for leads that should roam the mode rather than just the chord.
export function buildScalePool(rootMidi, mode, { fromOctave = 12, octaves = 2 } = {}) {
  const scale = MODES[mode];
  const pool = [];
  for (let o = 0; o < octaves; o++) {
    scale.forEach((semi) => pool.push(rootMidi + fromOctave + o * 12 + semi));
  }
  return pool;
}

// Blend of chord tones and scale tones, so a lead stays mostly on the
// harmony but has a few passing notes.
export function buildLeadPool(rootMidi, mode, chordSemitones, { fromOctave = 12, octaves = 2 } = {}) {
  const scale = buildScalePool(rootMidi, mode, { fromOctave, octaves });
  const chord = chordSemitones
    .map((s) => ((s % 12) + 12) % 12)
    .flatMap((pc) => [rootMidi + fromOctave + pc, rootMidi + fromOctave + 12 + pc]);
  // Keep the first pass of the chord so it reads as the harmonic anchor.
  return scale.filter((n) => chord.includes(n)).concat(chord);
}
