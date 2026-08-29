# House

An endless, generative house engine for the browser. Round 4-on-the-floor kick
with a gentle sidechain pump, the signature off-beat open hats (swung),
syncopated closed-hat ghosts, a warm syncopated bass (off-beat 8ths, octave
pops, "the-and-a" syncopation), syncopated chorus-processed chord stabs, and a
sparse vibrato melody. Sections rotate between full **groove**, drumless
**break**, and melody-forward **peak**. Movements run 32–64 bars at a fixed
tempo and key. All synthesized live with the Web Audio API — no samples, no
build step, no dependencies.

Reference points: classic Chicago/UK house, warm analog stabs, deep-bass grooves.

## Running it standalone

```sh
python3 -m http.server 8000
# open http://localhost:8000/house/
```

Click **PLAY**. **Volume / Warmth / Swing / Groove** are live; **Tempo** is a
target applied at the next movement boundary.

## How it's structured

| File | Role |
| --- | --- |
| `js/audioCore.js` | shared master bus (duck/pump, saturation, reverb + delay sends) |
| `js/theory.js` | shared scales, chord building, voicings, note pools |
| `js/effects.js` | shared chorus, reverb impulse, delays, noise |
| `js/drum.js` | shared synthesized kit (kick, clap, hats, rim, risers) |
| `js/bass.js` | warm chorus bass voice (detuned saws + sub, plucks + sustain) |
| `js/lead.js` | chorus lead: chord stabs, vibrato melody, wide sustains |
| `js/conductor.js` | composer: patterns, swing, sections, movements, endings |
| `js/visualizer.js` | canvas oscilloscope (cosmetic) |
| `js/main.js` | standalone page wiring |

The bass ostinato is held 4–8 bars before changing (repetition locks the
groove in); the melody occasionally runs a polyrhythmic phrase (3-against-2,
5-against-4) off the 16th grid.

Embedding: same `AudioCore` + `Conductor` pattern as [Techno](../techno/).
