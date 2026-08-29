// A small, self-contained procedural reverb, in the style of
// web-audio-components/simple-reverb:
//
//     const reverb = new Reverb(ctx, { seconds: 5, decay: 2.8 });
//     input.connect(reverb.input);
//     reverb.output.connect(ctx.destination);
//
// No samples, no network, no dependencies: the impulse response is synthesized
// at construction time (and rebuilt whenever `seconds` or `decay` is set).
//
// The impulse has the three things that make a reverb read as a room rather
// than a hiss burst:
//   * EARLY REFLECTIONS — a few discrete, decaying taps in the first ~80 ms
//     give the space a defined "front" before the wash.
//   * NATURAL DECAY — the late field decays exponentially (linear in dB),
//     `2^(-53·t/RT60)`, so the tail fades the way an actual room does.
//   * FREQUENCY-DEPENDENT DECAY — a one-pole lowpass over the late noise so
//     highs die faster than lows, with a slightly different corner per
//     channel. Left and right use independent noise and tails for width.
//
// The buffer is normalized to unit energy per channel, so the convolver's
// steady-state gain is exactly 1.0 — wet level = dry × send × return, with
// plain, predictable mix math (see _buildImpulse's final block).

export class Reverb {
  constructor(context, { seconds = 5, decay = 2.8, early = 0.7, tilt = 2600, reverse = false } = {}) {
    this.context = context;
    // Like simple-reverb, a single convolver is both ends of the module.
    this.input = context.createConvolver();
    this.output = this.input;
    this._seconds = seconds;
    this._decay = decay;
    this._early = early;
    this._tilt = tilt;
    this._reverse = reverse;
    this._buildImpulse();
  }

  // The generated impulse response (for inspection and testing).
  get buffer() {
    return this.input.buffer;
  }

  connect(dest) {
    this.output.connect(dest.input ? dest.input : dest);
  }

  set seconds(v) {
    this._seconds = v;
    this._buildImpulse();
  }
  get seconds() {
    return this._seconds;
  }

  set decay(v) {
    this._decay = v;
    this._buildImpulse();
  }
  get decay() {
    return this._decay;
  }

  _buildImpulse() {
    const ctx = this.context;
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * this._seconds);
    const impulse = ctx.createBuffer(2, length, rate);
    const rt60 = this._decay;

    // One-pole lowpass coefficient for a given -3 dB corner frequency.
    const pole = (cornerHz) => 1 - Math.exp((-2 * Math.PI * cornerHz) / rate);

    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      const chRt60 = rt60 * (ch === 0 ? 1.0 : 0.92); // L/R tail mismatch
      const a = pole(this._tilt * (ch === 0 ? 1 : 0.8)); // L/R tilt mismatch

      // --- Late field: exponentially decaying (linear in dB) tilted noise. ---
      let lp = 0;
      for (let i = 0; i < length; i++) {
        const secs = i / rate;
        const amp = Math.pow(2, (-53 * secs) / chRt60);
        const white = Math.random() * 2 - 1;
        lp += a * (white - lp); // one-pole lowpass = spectral tilt
        const earlyFade = Math.min(1, secs / 0.02); // don't clash with the dry hit
        data[i] = lp * amp * earlyFade;
      }

      // --- Early reflections: scattered discrete taps in the first ~80 ms. ---
      const nEr = 9;
      for (let k = 0; k < nEr; k++) {
        const frac = (k + 0.5) / nEr;
        const delaySec = 0.004 + frac * 0.078;
        const idx = Math.floor(delaySec * rate);
        if (idx >= length) continue;
        const amp = this._early * 0.9 * Math.pow(2, (-30 * delaySec) / chRt60) * (1 - 0.5 * frac);
        const pan = Math.random(); // per-reflection L/R split
        const gainCh = ch === 0 ? Math.sqrt(1 - pan) : Math.sqrt(pan);
        // A short noise burst (~4 ms) reads as a reflection, not a click.
        const burst = Math.floor(rate * 0.004);
        for (let j = 0; j < burst && idx + j < length; j++) {
          data[idx + j] += (Math.random() * 2 - 1) * amp * gainCh * (1 - j / burst);
        }
      }

      if (this._reverse) {
        for (let i = 0, j = length - 1; i < j; i++, j--) {
          const t = data[i];
          data[i] = data[j];
          data[j] = t;
        }
      }
    }

    // --- Normalize each channel to unit energy (Σ h² = 1). ---
    //
    // Convolution with a stationary input scales the output's RMS by
    // √(Σ h²), so unit energy makes the convolver's steady-state gain
    // exactly 1.0: wet = dry × send × return, ordinary mix math.
    //
    // (Peak-normalizing a decaying noise tail — what simple-reverb's raw
    // impulse effectively does — crams almost all its energy near t=0 and
    // leaves the convolver ~40 dB under the dry signal: the classic
    // "reverb isn't audible" bug. A 5 s / RT60 2.8 s tail peak-normalized
    // to 0.5 has RMS ≈ 0.044, i.e. a convolver gain of ~0.04.)
    for (let ch = 0; ch < 2; ch++) {
      const d = impulse.getChannelData(ch);
      let sumSq = 0;
      for (let i = 0; i < length; i++) sumSq += d[i] * d[i];
      if (sumSq > 0) {
        const scale = 1 / Math.sqrt(sumSq);
        for (let i = 0; i < length; i++) d[i] *= scale;
      }
    }

    this.input.buffer = impulse;
  }
}
