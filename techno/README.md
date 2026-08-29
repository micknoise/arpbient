# Techno

An endless, generative techno engine for the browser. 4-on-the-floor kick with
a sidechain pump, off-beat 8th/16th hats, a continuous TB-303-style acid bass
line, and alternating 16th-pluck arpeggios and syncopated chord stabs — all
synthesized live with the Web Audio API. No samples, no build step, no
dependencies.

Reference points: Richie Hawtin, Robert Hood, early Paul Kalkbrenner,
Detroit/EU acid.

## Running it standalone

Plain ES modules, so it needs HTTP (module imports are blocked on `file://`):

```sh
python3 -m http.server 8000
# open http://localhost:8000/techno/
```

Click **PLAY**. **Volume / Acidity / Drive / Density** are live; **Tempo** is a
target applied at the next movement boundary.

## How it's structured

| File | Role |
| --- | --- |
| `js/audioCore.js` | shared master bus: duck stage (kick pump) → saturation → limiter, reverb + delay sends |
| `js/theory.js` | shared scales, chord building, voicings, note pools |
| `js/effects.js` | shared saturation curve, chorus, reverb impulse, delays, noise |
| `js/drum.js` | shared synthesized kit: kick, snare, clap, hats, rim, tom, crash, risers |
| `js/bass.js` | acid bass voice (resonant saw + sub + drive) |
| `js/lead.js` | pluck arpeggio / chord stabs / sustained chords |
| `js/conductor.js` | the composer: patterns, sections (main/peak/breakdown), movements, endings |
| `js/visualizer.js` | canvas oscilloscope (cosmetic) |
| `js/main.js` | standalone page wiring |

Movements run ~32–64 bars at a fixed tempo and key (one chord per bar over a
short i-rooted progression). At the end: the groove thins, a riser swells, a
final hit across bass + lead + kit, then a lone sustained chord rings out
before the next movement drops in a new key/tempo. Tempo and key never change
mid-movement.

Embedding guide: see [arpbient/README.md](../arpbient/README.md) — the same
`AudioCore` + `Conductor` pattern applies, with `conductor.setAcidity()`,
`setDensity()`, `setTempo()` and `core.setSaturation()` as the live knobs.
