# Illbient

An endless, generative dark-ambient synth engine for the browser. Juno-60/ARP-Odyssey-style
pads and arpeggios, a punchy resonant bass ostinato, slow filter-LFO movement, and a
structured "movement → ending → movement" form, all synthesized live with the Web Audio API.
No samples, no build step, no dependencies.

Reference points: John Carpenter, early Gary Numan, Klaus Schulze, Jean-Michel Jarre,
Kyle Dixon/Michael Stein's *Stranger Things* score.

## Running it standalone

It's plain ES modules, so it needs to be served over HTTP (module imports are blocked on
`file://` by CORS) — no build step or install required:

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

Click **PLAY** (audio requires a user gesture to start in-browser). The **Volume /
Darkness / Density / Tempo** sliders are live macro controls; everything else — chord
progression, bass pattern, texture drift, when the next ending happens — is generated on
its own.

## How it's structured

| File | Role |
| --- | --- |
| `js/audioCore.js` | `AudioContext`, master bus: saturation → limiter → master gain, plus shared reverb and delay send/returns |
| `js/theory.js` | Modal scales, diatonic chord building, voicings, arpeggio note pools |
| `js/effects.js` | Chorus, algorithmic reverb impulse, feedback delay |
| `js/pads.js` | `PadLayer` — Juno-style pad voice (detuned saws + sub, shared filter LFO, gate stage) |
| `js/arp.js` | `ArpLayer` — plucked arpeggiator voice with its own filter envelope |
| `js/bass.js` | `BassLayer` — punchy resonant mono bass pluck |
| `js/conductor.js` | `Conductor` — the composer: harmony, scheduling, macro drift, movement/ending structure |
| `js/visualizer.js` | Canvas oscilloscope, purely cosmetic |
| `js/main.js` | Wires the DOM controls to `AudioCore`/`Conductor` for the standalone page |

`Conductor` is the only piece that knows about musical time. Everything else (`PadLayer`,
`ArpLayer`, `BassLayer`) is a dumb, stateless-ish voice factory: you hand it a MIDI note and
a time and it plays a note. That split is what makes embedding straightforward — see below.

### Musical structure

The piece runs in **movements**: a fixed key, mode, and tempo, with chords advancing every
4 bars over a narrow, repetitive progression. Roughly every 24–40 bars, or whenever
`triggerEnding()` is called, the movement **ends**: a huge multi-octave stab fires across
pad + bass + arp on the tonic chord, decays away, and leaves a single sustained pad ringing
out for 8–14 seconds. A new movement then begins — new tempo, new root key, chords resume.
Tempo and key only ever change at this boundary, never mid-movement.

A slow `intensity` value randomly surges and decays over the course of a movement, driving
resonance, arp/bass note density, and filter-LFO speed up and down without touching tempo. A
separate `timbre` value slowly drifts the pad/arp oscillator balance and detune width so the
piece travels through different textures over time.

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

### Controlling parameters

These are safe to call at any time, including while it's playing:

```js
core.setMasterVolume(0.8);          // 0..1
conductor.setDarknessOverride(0.7); // 0..1 -- lower filter cutoffs, darker tone
conductor.setDensityOverride(0.5);  // 0..1 -- arp note density / rest probability
conductor.setTimbreOverride(0.3);   // 0..1 -- oscillator balance, detune width, resonance
conductor.setTempo(90);             // BPM for the *current* movement; takes effect
                                     // immediately, but the generative system will still
                                     // pick a fresh tempo at the next ending
```

Each of these sets a starting point that the generative drift will continue to wander
away from on its own — they're overrides, not locks. If you want a parameter pinned, call
the setter again each time its drift would otherwise move it (e.g. from an `onBar` hook).

### Triggering events

The only event a host can currently force is the ending:

```js
conductor.triggerEnding(); // fires the big stab + fade-to-pad-alone at the next bar,
                            // then starts a fresh movement (new key + tempo)
```

It's a no-op if an ending is already in progress. There's no minimum movement length
enforced when called this way — you can call it as soon as `conductor.start()` returns if
you want an ending immediately.

### Listening for events

Assign any of these on the `Conductor` instance to sync a light show, UI state, a game
event, subtitles, whatever — leave them `null` (the default) to ignore:

```js
conductor.onBar = (barIndex) => {
  // fires once per bar (4 beats). Useful as a generic sync clock.
};

conductor.onChord = ({ root, mode, degree, midiNotes }) => {
  // fires every time the harmony changes (every 4 bars in normal play).
  // midiNotes is the actual voiced pad chord for this change.
};

conductor.onEnding = () => {
  // fires the instant the big stab triggers -- the moment to cue a
  // scene transition, a flash, a screen shake, etc.
};

conductor.onMovementStart = ({ root, mode, bpm }) => {
  // fires when a new movement begins after an ending -- new key and tempo.
};
```

Example: fade a UI element to black exactly when the ending stab hits, and back up once
the new movement starts:

```js
conductor.onEnding = () => fadeOverlay(1, 2000);       // fade to black over 2s
conductor.onMovementStart = () => fadeOverlay(0, 3000); // fade back over 3s
```

### Reading state

`conductor.root`, `.mode`, `.bpm`, `.phase` (`'normal'` or `'quiet'`), and
`.macro` (`{ darkness, density, timbre, intensity, padLevel, arpLevel, bassLevel }`) are
plain public fields, safe to read (not write, except via the setters above) at any time —
useful if you'd rather poll from a render loop than use the callbacks.

### Notes

- Each `new AudioCore()` creates its own `AudioContext`. Don't create more than one per
  page unless you specifically want independent, unmixed audio graphs.
- `AudioCore` exposes `core.analyser` (a standard `AnalyserNode`) if you want to drive your
  own visualization instead of `js/visualizer.js`.
- Nothing here depends on `window` except `AudioContext`/`OfflineAudioContext` fallback
  lookup and `devicePixelRatio` in the visualizer — the audio engine itself has no DOM
  dependency and could be used from a non-browser Web Audio host (e.g. Electron) unchanged.

## Branches

- `main` — current version, described above.
- `v1-ambient-wash` — first working version: full arpeggiator, wind + water texture beds,
  slow drone bass.
- `v2-carpenter-sinister` — an experiment narrowing the harmony to a strict minor-key i/bVI
  cell and replacing the arp with bright stab hits. Superseded by `main`, kept for reference.

## License

No license is granted. The source is public for reading and reference, but no permission
is given to reuse, modify, or redistribute it.
