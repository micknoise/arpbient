import { midiToFreq } from './theory.js';

// Shepard / "forever rising" layer. N octave-spaced sine voices carry a
// static bell-shaped amplitude window (middle voices loudest) while all of
// them glide by the same semitone amount over the duration. Because the
// loudest region stays fixed in the stack but every voice is moving, the
// perceptual pitch keeps climbing (or, with direction=-1, falling) and never
// resolves — the classic "dread is building" device.
export class ShepardLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.6 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.4;
    this.bus.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount });
  }

  setLevel(v) {
    this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 1.0);
  }

  // direction: +1 = rising dread, -1 = falling. steps: semitones climbed over
  // the duration (12 = a full octave, the textbook Shepard).
  glide(startTime, { duration = 14, direction = 1, velocity = 0.12, baseMidi = 45, steps = 12 } = {}) {
    const ctx = this.ctx;
    const N = 4;
    const base = midiToFreq(baseMidi);

    const master = ctx.createGain();
    master.gain.value = 0.0001;
    master.connect(this.bus);

    const t0 = startTime;
    const fade = Math.min(1.5, duration * 0.2);
    master.gain.setValueAtTime(0.0001, t0);
    master.gain.linearRampToValueAtTime(velocity, t0 + fade);
    master.gain.setValueAtTime(velocity, t0 + Math.max(t0 + fade, duration - fade));
    master.gain.linearRampToValueAtTime(0.0001, t0 + duration);

    const stopTime = t0 + duration + 0.5;

    for (let k = 0; k < N; k++) {
      const bell = Math.sin((Math.PI * (k + 0.5)) / N); // static amplitude window
      const f0 = base * Math.pow(2, k);
      const f1 = f0 * Math.pow(2, (direction * steps) / 12);

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f0, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + duration);

      const g = ctx.createGain();
      g.gain.value = bell;

      osc.connect(g);
      g.connect(master);
      osc.start(t0);
      osc.stop(stopTime);
    }
  }
}
