// Harmony helpers: dark modal scales, diatonic chord building, spread voicings.

export const MODES = {
  aeolian: [0, 2, 3, 5, 7, 8, 10],  // natural minor
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

// Low, dark root pitches (MIDI) to anchor each session in.
export const DARK_ROOTS = [40, 41, 42, 43, 45, 47]; // E2 F2 F#2 G2 A2 B2

// Scale-degree progressions (0-indexed). Heavy repetition / small motion
// on purpose -- Carpenter/Stranger-Things style pedal-driven harmony.
export const PROGRESSIONS = [
  [0, 0, 5, 3],
  [0, 3, 0, 4],
  [0, 5, 3, 4],
  [0, 0, 3, 3],
  [0, 2, 5, 3],
  [0, 4, 3, 0],
];

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
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
export function buildChord(root, mode, degree, { seventh = true, add9 = false } = {}) {
  const tones = [degree, degree + 2, degree + 4];
  if (seventh) tones.push(degree + 6);
  if (add9) tones.push(degree + 8);
  return tones.map((d) => root + degreeToSemitone(mode, d));
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

// Builds a higher-register note pool (two octaves) for the arpeggiator.
export function buildArpPool(rootMidi, chordSemitones, baseOctaveShift = 12) {
  const classes = chordSemitones.map((s) => ((s % 12) + 12) % 12);
  const pool = [];
  [0, 12].forEach((add) => {
    classes.forEach((pc) => pool.push(rootMidi + baseOctaveShift + add + pc));
  });
  return pool;
}
