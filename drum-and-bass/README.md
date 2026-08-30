# Drum & Bass

An endless, generative drum & bass engine for the browser. The classic
2-step break — kick on 1 and the "and" of 3, snare on 2 and 4 — over a
rolling Reese bass (two detuned saws with an AM wobble locked to the 16th
grid, plus a sine sub) and a bright, syncopated liquid top. Sections rotate
between full groove, drumless breaks (bass + lead floating), and liquid
moments (long singing notes over a sparse bass). Fixed tempo and key per
movement, 170–176bpm. All synthesized live with the Web Audio API — no
samples, no build step, no dependencies.

Reference points: liquid DnB (Liquid Soul, the *Neuro* label's melodic end),
reese bass (the Portishead / *Bass* tradition), the 2-step break itself.

## Running it standalone

```sh
python3 -m http.server 8000
# open http://localhost:8000/drum-and-bass/
```

Click **PLAY**. **Volume / Reese / Liquid** are live; **Tempo** is a
target applied at the next movement boundary.

## How it's structured

| File | Role |
| --- | --- |
| `js/audioCore.js` | shared master bus (duck/pump, saturation, reverb + delay sends) |
| `js/theory.js` | shared scales, chord building, voicings, note pools |
| `js/effects.js` | shared chorus, reverb impulse, delays, noise |
| `js/drum.js` | shared synthesized kit (kick, snare, clap, hats, rim, tom, risers) |
| `js/bass.js` | Reese bass (detuned saws + AM wobble + sub, sub drop) |
| `js/lead.js` | bright piano-ish plucks + long singing notes + sustained chord |
| `js/conductor.js` | composer: 2-step break, rolling bass, section rotation, movements |
| `js/visualizer.js` | canvas oscilloscope (cosmetic) |
| `js/main.js` | standalone page wiring |

The rolling Reese bass is held 4–8 bars; the 2-step stays locked (the DnB
anchor) while ghost/fill texture mutates; the lead occasionally runs a
polyrhythmic phrase (3-against-2, 5-against-4) off the grid.

Embedding: same `AudioCore` + `Conductor` pattern as
[Techno](../techno/).
