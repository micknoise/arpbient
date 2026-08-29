# Wraith

An endless, generative **horror** music engine for the browser. Carpenter-esque: a sub-octave
drone bed, hollow organ swells, a sparse defiant bass melody, metallic "eerie melody" bells, a
forever-rising Shepard dread glide, and ambient texture punctuation (scrape, creak, crackle,
wind) — all synthesized live with the Web Audio API.
No samples, no build step, no dependencies.

It plays in **movements**: each one is a short, distinct piece (~one minute) with its own key,
mode, tempo, mix character and bass-line density. Tension builds through the movement, it
**detonates** in a terminating flourish (organ swell + metallic ring + sub drop + bell run), exhales into a
long lonely tail — then a fresh movement begins.

Reference points: John Carpenter, the *Halloween* score, early Gary Numan, Kyle
Dixon/Michael Stein's *Stranger Things* score.

## Running it standalone

It's plain ES modules, so it needs to be served over HTTP (module imports are blocked on
`file://` by CORS) — no build step or install required:

```sh
python3 -m http.server 8000
# open http://localhost:8000/wraith/   (or `cd wraith` and open http://localhost:8000/)
```

Click **PLAY** (audio requires a user gesture to start in-browser). The **Volume / Dread /
Tension / Bass / Tempo** sliders are live macro controls:

| Slider | What it does |
| --- | --- |
| **Volume** | master level |
| **Dread** | dissonance, grit and overall darkness |
| **Tension** | how fast the texture thickens and the build gets loud |
| **Bass** | temporal density of the bass melody — sparse (1–2 notes / 10 s) to dense (5–8 / 10 s). Each movement picks a density around this value, so it's both a per-movement feature and a live control |
| **Tempo** | center for the tempo; each movement settles within ~±7 bpm of it |

Everything else — key, mode, progression, when the next ending happens, the mix balance — is
generated on its own. Headphones recommended.

## How it's structured

| File | Role |
| --- | --- |
| `js/audioCore.js` | `AudioContext`, master bus: sum → saturation → limiter → master gain, plus shared reverb, delay and a heavy "grit" send/return |
| `js/theory.js` | Dark modal scales, diatonic chord building, drone/bell note pools |
| `js/effects.js` | Saturation curves, chorus, feedback delay, noise beds |
| `js/reverb.js` | `Reverb` — a self-contained, **synthesized** reverb in the spirit of [simple-reverb](https://github.com/web-audio-components/simple-reverb): early reflections + dB-linear decay + spectral tilt, no samples |
| `js/drone.js` | `DroneLayer` — the always-present sub-octave pressure bed (detuned sine pairs, breathing LFO, optional saw body) |
| `js/organ.js` | `OrganLayer` — hollow swells of detuned voices with a slow filter LFO |
| `js/metallic.js` | `MetallicLayer` — inharmonic bell/strike and ring voices for the high "eerie melody" |
| `js/bass.js` | `BassLayer` — the low, resonant, long-decay bass melody voice (+ sub drop for the stinger) |
| `js/shepard.js` | `ShepardLayer` — the "forever rising" dread glissando |
| `js/texture.js` | `TextureLayer` — continuous wind bed + scrape / creak / crackle punctuation |
| `js/conductor.js` | `Conductor` — the composer: harmony, scheduling, tension, movement/ending structure |
| `js/visualizer.js` | Canvas oscilloscope, purely cosmetic |
| `js/main.js` | Wires the DOM controls to `AudioCore`/`Conductor` for the standalone page |

`Conductor` is the only piece that knows about musical time. Everything else is a dumb voice
factory: you hand it a MIDI note and a time and it plays. That split is what makes embedding
straightforward — see below.

### Musical structure

The piece runs in **movements**, roughly a minute long:

1. **Build** — a fixed key, mode and progression (baroque minor: i, iv, V, bVI — the insistent
   i/bVI horror signature) hold steady while tension rises bar by bar. The drone rides up, organ
   swells brighten, the high bells thicken, texture punctuation quickens, and a
   Shepard dread glide climbs underneath. At most one mid-movement "breath" (a withheld, slow
   release) eases the tension part-way before it builds again.
2. **Ending** — at the movement's bar, a terminating flourish: a hard organ swell + metallic
   ring + sub drop, a bell-pool flourish run (ascending / descending / arch / scattered), then a long,
   lonely swell over the sunk drone floor.
3. **New movement** — new key, mode, progression, tempo (within the slider's center), bass
   density and mix character. Tempo and key only ever change at this boundary, never mid-movement.

The **bass line** is a sparse minor *melody*, not an ostinato: each bar's note count is derived
from the movement's density (1.5–8 notes per 10 s), the pitches come from an open-minor pool
(root, 5th, octave, minor 3rd, b2, 7th) with short-term melodic memory, and the hits land on
weighted eighth-note slots. It moves and changes from bar to bar instead of repeating a fixed
pattern.

### Reverb

There's no reverb *sample* and no third-party file — `js/reverb.js` is a small, self-contained
reverb in the spirit of
[simple-reverb](https://github.com/web-audio-components/simple-reverb) (same API shape:
`new Reverb(ctx, { seconds, decay })`, with the convolver exposed as both `input` and
`output`), but instead of raw decaying noise it synthesizes a *room-sounding* impulse at
startup: early-reflection taps for a defined space "front", an exponential (linear-in-dB) late
decay, a one-pole spectral tilt so highs die faster than lows, and independent noise and tails
per channel for width.

To change the space, set `core.reverb.seconds` / `core.reverb.decay` (or build with your own
`early` / `tilt` in `js/audioCore.js`). The return level is `core.reverbReturn.gain`; each
layer's share of the send is set in its `reverbAmount` option in `js/conductor.js`.

## Embedding it in another app

Everything is a plain ES module with no build step, so you can drop the `js/` folder
(minus `main.js`, which is just the standalone page's wiring) into any project that can
serve static files and use `<script type="module">` or a bundler that understands ESM.

### Minimal setup

```js
import { AudioCore } from './js/audioCore.js';
import { Conductor } from './js/conductor.js';

// Create these in response to a user gesture (click/tap) -- browsers
// block audio from starting on page load.
button.addEventListener('click', async () => {
  const core = new AudioCore();
  const conductor = new Conductor(core);

  await core.start();      // ramps master gain in over ~3.5s
  conductor.start();       // begins the generative scheduler
});
```

To stop:

```js
conductor.stop();
await core.stop();         // ramps master gain out, then suspends the context
```

Both are safe to call repeatedly and in quick succession (stop → play → stop → play).

### Controlling parameters

These are safe to call at any time, including while it's playing:

```js
core.setMasterVolume(0.8);          // 0..1
conductor.setDarknessOverride(0.7); // 0..1 -- dissonance, grit, darkness
conductor.setDensityOverride(0.5);  // 0..1 -- how fast the texture thickens
conductor.setTimbreOverride(0.3);   // 0..1 -- detune width, metallic edge
conductor.setBassDensityOverride(0.6); // 0..1 -- bass melody temporal density
conductor.setTempo(90);             // center for the tempo; each movement settles
                                     // within ~±7 bpm of it (clamped 46..100)
```

Each of these sets a *center* that the generative system wanders around — overrides, not
locks. The sliders in the standalone page are wired to exactly these.

### Triggering events

A host can force the current movement's ending any time:

```js
conductor.triggerEnding();  // the terminating flourish fires at the next bar,
                            // then a fresh movement begins (new key + tempo)
conductor.triggerStinger(); // same thing — a convenience alias
```

Both are no-ops if an ending is already in progress.

### Listening for events

Assign any of these on the `Conductor` instance to sync a light show, UI state, a game
event, subtitles, whatever — leave them `null` (the default) to ignore:

```js
conductor.onBar = (barIndex) => {
  // fires once per bar (4 beats). Useful as a generic sync clock.
};

conductor.onChord = ({ root, mode, degree, midiNotes }) => {
  // fires every time the harmony changes (every ~3-6 bars in normal play).
  // midiNotes is the actual voiced organ chord for this change.
};

conductor.onEnding = () => {
  // fires the instant the terminating flourish triggers -- the moment to cue a
  // scene transition, a flash, a screen shake, etc.
};

conductor.onMovementStart = ({ root, mode, bpm, bassDensity }) => {
  // fires when a new movement begins after an ending -- new key, tempo, bass density.
};
```

Example: fade a UI element to black exactly when the ending flourish hits, and back up once
the new movement starts:

```js
conductor.onEnding = () => fadeOverlay(1, 2000);       // fade to black over 2s
conductor.onMovementStart = () => fadeOverlay(0, 3000); // fade back over 3s
```

### Reading state

`conductor.root`, `.mode`, `.bpm`, `.phase` (`'normal'` or `'ending'`), `.tension`
(0..1, rising through the movement), `.movementEndBar`, `.movementBassDensity`, and
`.macro` (`{ dread, density, timbre, droneLevel, organLevel, bassLevel, metallicLevel,
textureLevel }`) are plain public fields, safe to read (not write, except via the setters
above) at any time — useful if you'd rather poll from a render loop than use the callbacks.

### Notes

- Each `new AudioCore()` creates its own `AudioContext`. Don't create more than one per
  page unless you specifically want independent, unmixed audio graphs.
- `AudioCore` exposes `core.analyser` (a standard `AnalyserNode`) if you want to drive your
  own visualization instead of `js/visualizer.js`.
- Nothing here depends on `window` except the `AudioContext`/`webkitAudioContext` fallback
  lookup and `devicePixelRatio` in the visualizer — the audio engine itself has no DOM
  dependency and could be used from a non-browser Web Audio host (e.g. Electron) unchanged.

## Where this lives

This app sits in `wraith/` of the repo, alongside its dark-ambient sibling
**[Arpbient](../arpbient/)** in `arpbient/`. The repo root has a landing page linking to
both, and a top-level [README](../README.md) describing the layout.

`v4-horror` is the development branch Wraith was built on and now lives in `main/wraith/`;
it's kept as a historical snapshot. `v1`–`v3` are Arpbient's development history.

## License

No license is granted. The source is public for reading and reference, but no permission
is given to reuse, modify, or redistribute it.
