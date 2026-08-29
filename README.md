# Arpbient & Wraith

Two self-contained, endless generative music engines for the browser — synthesized live
with the Web Audio API. No samples, no build step, no dependencies.

| App | Character | Where to find it |
| --- | --- | --- |
| **Arpbient** | dark-ambient: Juno-60/ARP-Odyssey pads and arpeggios, a resonant bass ostinato, movement → ending form | [`arpbient/`](arpbient/) |
| **Wraith** | horror: sub-octave drone, hollow organ swells, metallic "eerie melody", Shepard dread glide, sparse bass melody — it builds, detonates, and starts over in a new key | [`wraith/`](wraith/) |
| **Techno** | driving 4-on-the-floor: acid bass ostinato, off-beat hats, 16th plucks and syncopated stabs, sidechain pump, riser endings | [`techno/`](techno/) |
| **House** | warm syncopated groove: off-beat open hats (swung), chorus stabs, deep bouncy bass, groove/break/peak sections | [`house/`](house/) |
| **Ambient Techno** | slow & hypnotic: sparse drums, deep sub swells, wide evolving pads, long reverbed melodies, ~2-minute movements | [`ambient-techno/`](ambient-techno/) |

Reference points: John Carpenter, the *Halloween* score, early Gary Numan, Klaus Schulze,
Jean-Michel Jarre, Kyle Dixon/Michael Stein's *Stranger Things* score.

## Running it

Each app is plain ES modules, so it needs to be served over HTTP (module imports are blocked
on `file://` by CORS) — no build step or install required. From the repo root:

```sh
python3 -m http.server 8000
```

- landing page: http://localhost:8000/
- **Arpbient**: http://localhost:8000/arpbient/
- **Wraith**: http://localhost:8000/wraith/
- **Techno**: http://localhost:8000/techno/
- **House**: http://localhost:8000/house/
- **Ambient Techno**: http://localhost:8000/ambient-techno/

Or serve an app directory directly (`cd wraith && python3 -m http.server 8000`).
Click **PLAY** — audio requires a user gesture to start in-browser. Headphones recommended.

## Layout

```
index.html      landing page linking to both apps
arpbient/       the dark-ambient engine  (index.html, js/, style.css, README.md)
wraith/         the horror engine        (index.html, js/, style.css, README.md)
```

Each app directory is **complete and independent**: all of its imports are relative, so it can
be copied anywhere. To embed one in another project, drop its `js/` folder
(minus `main.js`, which is just the standalone page's wiring) into any project that can serve
static files and use `<script type="module">` or an ESM-capable bundler.

- **Arpbient** API & embedding guide: [`arpbient/README.md`](arpbient/README.md)
- **Wraith** API & embedding guide: [`wraith/README.md`](wraith/README.md)

## Branches

- `main` — both apps, as described above.
- `v4-horror` — the development branch Wraith was built on; its code now lives in
  [`wraith/`](wraith/), kept around as a historical snapshot.
- `v1-ambient-wash` — first working Arpbient version: full arpeggiator, wind + water texture
  beds, slow drone bass.
- `v2-carpenter-sinister` — an experiment narrowing the harmony to a strict minor-key i/bVI
  cell and replacing the arp with bright stab hits.
- `v3-good-bass` — Arpbient bass-voice development.

## License

No license is granted. The source is public for reading and reference, but no permission
is given to reuse, modify, or redistribute it.
