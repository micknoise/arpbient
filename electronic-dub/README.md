# Electronic Dub

An endless, generative electronic-dub engine for the browser. The classic
one-drop groove — kick on 1, claps on 2 and 4, skank chord stabs on the
offbeats — over a long-decay syncopated bass, with sparse melody notes that
live mostly in the delay. The dub character comes from live mix automation:
random **dropouts** (delay + reverb returns cut out for a beat), **echo
swells** (delay feedback pushed up), and **stripped** sections where the
drums thin to kick-and-bass and the tails take over. Fixed tempo and key
per movement. All synthesized live with the Web Audio API — no samples, no
build step, no dependencies.

Reference points: classic dub (King Tubby, Augustus Pablo), reggae skank,
lo-fi/electronic dub (Shag, Madlib's beat tape work).

## Running it standalone

```sh
python3 -m http.server 8000
# open http://localhost:8000/electronic-dub/
```

Click **PLAY**. **Volume / Echo / Dropouts** are live; **Tempo** is a
target applied at the next movement boundary.

## How it's structured

| File | Role |
| --- | --- |
| `js/audioCore.js` | shared master bus (duck/pump, saturation, reverb + delay sends, `setEffectsMuted` dropouts, `delayBurst` echo swells) |
| `js/theory.js` | shared scales, chord building, voicings, note pools |
| `js/effects.js` | shared chorus, reverb impulse, delays, noise |
| `js/drum.js` | shared synthesized kit (kick, clap, hats, rim, risers) |
| `js/bass.js` | long-decay one-drop bass (detuned saws + sub, big delay send) |
| `js/lead.js` | skank stabs + long echoey melody notes + sustained final chord |
| `js/conductor.js` | composer: one-drop patterns, dropouts, echo swells, stripped sections, movements |
| `js/visualizer.js` | canvas oscilloscope (cosmetic) |
| `js/main.js` | standalone page wiring |

The bass ostinato is held 4–8 bars; the melody occasionally runs a
polyrhythmic phrase (3-against-2, 5-against-4) off the grid.

Embedding: same `AudioCore` + `Conductor` pattern as
[Techno](../techno/).
