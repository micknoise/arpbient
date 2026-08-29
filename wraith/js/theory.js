// Horror harmony helpers: dark modal scales, the insistent i/bVI (minor-six)
// cell with chromatic bII / iv approaches, dissonant cluster generation for
// stabs, low drone pitch sets, and high-register "eerie melody" bell pools.
//
// The vocabulary here is deliberately minor-key and dissonant — no major
// resolutions, no bright passing tones. The b2 (Phrygian) and the tritone
// (diabolus in musica) are the two notes a horror score reaches for first.

export const MODES = {
  aeolian: [0, 2, 3, 5, 7, 8, 10], // natural minor
  phrygian: [0, 1, 3, 5, 7, 8, 10], // b2 — the most "Carpenter" mode
  dorian: [0, 2, 3, 5, 7, 9, 10], // slightly lighter; used sparingly
};

// Low, dark root pitches (MIDI) to anchor each cycle in.
export const DARK_ROOTS = [40, 41, 42, 43, 45, 47]; // E2 F2 F#2 G2 A2 B2

// Scale-degree progressions (0-indexed). Straight, baroque minor harmony —
// plain root-position triads moving functionally among i (0), iv (3), V (4)
// and bVI (5). The i/bVI move is the insistent minor-six horror signature;
// iv→V gives the baroque drive. No 7ths, no 9ths, no chromatic passing —
// the "straight" part of the brief.
export const PROGRESSIONS = [
  [0, 0, 0, 4],
  [0, 0, 4, 0],
  [0, 5, 0, 0],
  [0, 5, 5, 0],
  [0, 3, 4, 0],
  [0, 0, 3, 4],
  [0, 4, 5, 0],
  [0, 3, 0, 5],
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

// Returns MIDI notes (absolute) for a diatonic chord built on the given scale
// degree, stacking thirds within the mode. Used for the hollow-organ swells.
export function buildChord(root, mode, degree, { seventh = true, add9 = false } = {}) {
  const tones = [degree, degree + 2, degree + 4];
  if (seventh) tones.push(degree + 6);
  if (add9) tones.push(degree + 8);
  return tones.map((d) => root + degreeToSemitone(mode, d));
}

// A dissonant "scream" cluster for stabs: the chord's own tones plus
// guaranteed clashes (minor 2nd, tritone, major 7th) above the chord root.
// Always includes at least one dissonance; spreads for register.
export function buildDissonantCluster(root, mode, degree, { size = 4, octave = 0 } = {}) {
  const base = root + degreeToSemitone(mode, degree) + 12 * octave;
  const chord = buildChord(root, mode, degree, { seventh: true });
  const dissonances = [base + 1, base + 6, base + 11]; // m2, tritone, M7
  const pool = [...chord, ...dissonances, base + 13, base + 15]; // + m9, m11
  const unique = [...new Set(pool)].sort((a, b) => a - b);

  const chosen = new Set([base]);
  // Guarantee a dissonant pair lands in the cluster.
  chosen.add(base + (Math.random() < 0.5 ? 1 : 6));
  let guard = 0;
  while (chosen.size < Math.max(size, 2) && guard++ < 60) {
    chosen.add(unique[Math.floor(Math.random() * unique.length)]);
  }
  return [...chosen].sort((a, b) => a - b);
}

// Low sub-drone pitches (MIDI) for the always-present pressure bed.
// interval: 7 = open fifth (default), 3 = minor third (darker), 0 = unison.
export function dronePitches(root, { interval = 7 } = {}) {
  const notes = [root - 12];
  if (interval) notes.push(root - 12 + interval);
  return notes;
}

// High-register note pool (2-3 octaves up) for the sparse "eerie melody" —
// plain triad chord tones, far above the bed so they read as bells/celesta
// over a low drone rather than a mid-range line. (Dissonance comes from the
// semitone-neighbor strikes, not from 7ths/9ths, so it stays "straight".)
export function bellPool(root, mode, degree, { octaves = 3 } = {}) {
  const chord = buildChord(root, mode, degree, { seventh: false });
  const classes = chord.map((s) => ((s % 12) + 12) % 12);
  const pool = [];
  for (let o = 2; o <= octaves; o++) {
    classes.forEach((pc) => pool.push(root + 12 * o + pc));
  }
  return pool;
}

// Base pitch (MIDI) for a Shepard / "forever rising" stack — one octave above
// the root so the glissando sits in an audible, unsettling register.
export function shepardBase(root) {
  return root + 12;
}

// Spreads chord tones across octaves for an open, non-muddy swell voicing.
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
