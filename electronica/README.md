# Electronica

An endless, generative IDM/electronica engine for the browser. Dense 16th
"noodle" arpeggios that mutate every bar, a gliding syncopated bass (with
portamento and pitch bends), pitched-glitch hats, and sections that rotate
between drum-driven noodle, drumless breaks (arps and bass floating), and
sparse groove. The Glitch slider adds octave jumps, micro-stutters, and hat
rate wobbles. Fixed tempo and key per movement. All synthesized live with
the Web Audio API — no samples, no build step, no dependencies.

Reference points: Aphex Twin (*Selected Ambient Works* / *Come On Dilly*),
Boards of Canada, Autechre, Squarepusher.

## Running it standalone

```sh
python3 -m http.server 8000
# open http://localhost:8000/electronica/
```

Click **PLAY**. **Volume / Noodle / Glitch** are live; **Tempo** is a
target applied at the next movement boundary.

## How it's structured

| File | Role |
| --- | --- |
| `js/audioCore.js` | shared master bus (duck/pump, saturation, reverb + delay sends) |
| `js/theory.js` | shared scales, chord building, voicings, note pools |
| `js/effects.js` | shared chorus, reverb impulse, delays, noise |
| `js/drum.js` | shared synthesized kit (kick, clap, hats, rim, tom, risers) |
| `js/bass.js` | gliding noodle bass (detuned saws + sub, portamento, bends) |
| `js/lead.js` | fast square/saw plucks (with glitch jumps/stutters) + long tones |
| `js/conductor.js` | composer: 16th arps, section rotation, glitch automation, movements |
| `js/visualizer.js` | canvas oscilloscope (cosmetic) |
| `js/main.js` | standalone page wiring |

The noodle bass is held 4–8 bars; the arps are deliberately fluid (re-rolled
most bars); the lead occasionally runs a polyrhythmic phrase (3-against-2,
5-against-4) off the grid.

Embedding: same `AudioCore` + `Conductor` pattern as
[Techno](../techno/).
