# Ambient Techno

An endless, generative ambient-techno engine for the browser. Soft half-time or
broken kick, long reverbed hats, slow deep sub swells, a wide evolving pad
(one chord per two bars, cross-faded), and sparse long singing lead notes with
big reverb and a long dotted delay. Slow, spacious, hypnotic — movements run
~32–56 bars (about 70s to 2 minutes) at a fixed tempo and key. All synthesized
live with the Web Audio API — no samples, no build step, no dependencies.

Reference points: slow/ambient techno (e.g. the "hypnotic minimal" end of the
spectrum), slow-motion dub, spacious IDM ambience.

## Running it standalone

```sh
python3 -m http.server 8000
# open http://localhost:8000/ambient-techno/
```

Click **PLAY**. **Volume / Space / Density / Warmth** are live; **Tempo** is a
target applied at the next movement boundary.

## How it's structured

| File | Role |
| --- | --- |
| `js/audioCore.js` | shared master bus (duck/pump, saturation, reverb + delay sends) |
| `js/theory.js` | shared scales, chord building, voicings, note pools |
| `js/effects.js` | shared chorus, reverb impulse, delays, noise |
| `js/drum.js` | shared synthesized kit (kick, clap, hats, rim, risers) |
| `js/pad.js` | wide slow evolving pad (detuned saws + sub, slow filter LFO, chorus) |
| `js/bass.js` | deep sub swells + slow rolling plucks |
| `js/lead.js` | sparse long singing notes + quiet ticks |
| `js/conductor.js` | composer: sparse patterns, chord per 2 bars, movements, endings |
| `js/visualizer.js` | canvas oscilloscope (cosmetic) |
| `js/main.js` | standalone page wiring |

The bass ostinato is held 4–8 bars; the lead occasionally runs a polyrhythmic
phrase (3-against-4, 5-against-4) off the grid.

Embedding: same `AudioCore` + `Conductor` pattern as [Techno](../techno/).
