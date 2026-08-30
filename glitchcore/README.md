# Glitchcore

An endless, generative glitchcore / breakcore-flavoured engine for the
browser. Fast breakbeat chaos — heavily mutated 16th drum patterns (snare
ghosts, kick pickups, rim blips, pitched-glitch hats) — over a punchy
syncopated bass and a square "stutter" lead: notes fired in scheduled
micro-repeats with random octave jumps. Sections rotate between drum chaos,
builds, full detonation, and drumless holds where the stutters float.
Endings build and cut out hard. Fixed tempo and key per movement,
140–170bpm. All synthesized live with the Web Audio API — no samples, no
build step, no dependencies.

Reference points: breakcore (Venetian Snares, the Aphex Twin *RHYTHM-02* /
*Viper* end), glitch (Filk, early Squarepusher), hardcore breakbeats.

## Running it standalone

```sh
python3 -m http.server 8000
# open http://localhost:8000/glitchcore/
```

Click **PLAY**. **Volume / Stutter / Breaks** are live; **Tempo** is a
target applied at the next movement boundary.

## How it's structured

| File | Role |
| --- | --- |
| `js/audioCore.js` | shared master bus (duck/pump, saturation, reverb + delay sends) |
| `js/theory.js` | shared scales, chord building, voicings, note pools |
| `js/effects.js` | shared chorus, reverb impulse, delays, noise |
| `js/drum.js` | shared synthesized kit (kick, snare, clap, hats, rim, tom, risers) |
| `js/bass.js` | punchy syncopated bass (saw+square, sub drop, optional glides) |
| `js/lead.js` | stutter micro-repeats, square blips, detuned stabs, long tones |
| `js/conductor.js` | composer: drum chaos mutation, stutter scheduling, sections, hard-cut endings |
| `js/visualizer.js` | canvas oscilloscope (cosmetic) |
| `js/main.js` | standalone page wiring |

The punchy bass is held 4–8 bars as the anchor; drums and stabs re-roll
constantly; the lead occasionally runs a polyrhythmic phrase (3-against-2,
5-against-4) off the grid.

Embedding: same `AudioCore` + `Conductor` pattern as
[Techno](../techno/).
