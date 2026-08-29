// Reusable effect builders: analog-style saturation, BBD-style chorus,
// an algorithmically synthesized dark reverb, and a filtered feedback delay.

export function createSaturationCurve(amount = 0.3) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * (1 + amount * 4));
  }
  return curve;
}

// Two modulated delay lines panned L/R, mixed with dry signal -- classic
// Juno-style ensemble chorus.
export function createChorus(ctx, { rateL = 0.17, rateR = 0.21, depth = 0.0035, baseDelay = 0.018, wet = 0.5 } = {}) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  dry.gain.value = 1 - wet;
  const wetGain = ctx.createGain();
  wetGain.gain.value = wet;

  input.connect(dry);
  dry.connect(output);

  const delayL = ctx.createDelay(1.0);
  delayL.delayTime.value = baseDelay;
  const delayR = ctx.createDelay(1.0);
  delayR.delayTime.value = baseDelay;

  const lfoL = ctx.createOscillator();
  lfoL.type = 'sine';
  lfoL.frequency.value = rateL;
  const lfoR = ctx.createOscillator();
  lfoR.type = 'sine';
  lfoR.frequency.value = rateR;

  const depthL = ctx.createGain();
  depthL.gain.value = depth;
  const depthR = ctx.createGain();
  depthR.gain.value = depth;

  lfoL.connect(depthL);
  depthL.connect(delayL.delayTime);
  lfoR.connect(depthR);
  depthR.connect(delayR.delayTime);
  lfoL.start();
  lfoR.start();

  const panL = ctx.createStereoPanner();
  panL.pan.value = -0.6;
  const panR = ctx.createStereoPanner();
  panR.pan.value = 0.6;

  input.connect(delayL);
  delayL.connect(panL);
  panL.connect(wetGain);
  input.connect(delayR);
  delayR.connect(panR);
  panR.connect(wetGain);
  wetGain.connect(output);

  return { input, output };
}

// Synthesizes a convincing reverb impulse response for ConvolverNode with no
// external audio asset. The old version was plain decaying white noise, which
// reads as a hiss burst, not a space. This one has the three things that make
// a reverb sound "real":
//   * EARLY REFLECTIONS — a few discrete, decaying taps in the first ~80 ms
//     give the room a defined "front" before the wash.
//   * NATURAL DECAY — the late field decays exponentially (linear in dB),
//     `2^(-53·t/RT60)`, so the tail fades the way an actual room does.
//   * FREQUENCY-DEPENDENT DECAY — a one-pole lowpass over the late noise so
//     high frequencies die faster than low ones, with a slightly different
//     corner per channel.
// Left and right use independent noise and slightly different tails/tilts for
// a wider, less "centered" image. The result is peak-normalized so the
// convolver doesn't pump the limiter.
export function createReverbImpulse(ctx, duration = 5.0, rt60 = 2.8) {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * duration);
  const impulse = ctx.createBuffer(2, length, rate);

  // One-pole lowpass coefficient for a given -3 dB corner frequency.
  const pole = (cornerHz) => 1 - Math.exp((-2 * Math.PI * cornerHz) / rate);

  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    const chRt60 = rt60 * (ch === 0 ? 1.0 : 0.92); // L/R tail mismatch
    const a = pole(ch === 0 ? 2600 : 2100);        // L/R tilt mismatch

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
      const amp = 0.9 * Math.pow(2, (-30 * delaySec) / chRt60) * (1 - 0.5 * frac);
      const pan = Math.random(); // per-reflection L/R split
      const gainCh = ch === 0 ? Math.sqrt(1 - pan) : Math.sqrt(pan);
      // A short noise burst (~4 ms) reads as a reflection, not a click.
      const burst = Math.floor(rate * 0.004);
      for (let j = 0; j < burst && idx + j < length; j++) {
        data[idx + j] += (Math.random() * 2 - 1) * amp * gainCh * (1 - j / burst);
      }
    }
  }

  // --- Peak-normalize across both channels to a comfortable ~0.5 peak. ---
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
    }
  }
  if (peak > 0) {
    const scale = 0.5 / peak;
    for (let ch = 0; ch < 2; ch++) {
      const d = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) d[i] *= scale;
    }
  }

  return impulse;
}

// A tempo-able feedback delay with a lowpass in the feedback loop so
// repeats darken over time. Used as a send/return effect (wet-only output).
export function createDelay(ctx, { time = 0.55, feedback = 0.38, cutoff = 2200 } = {}) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const delay = ctx.createDelay(3.0);
  delay.delayTime.value = time;
  const fb = ctx.createGain();
  fb.gain.value = feedback;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  filter.Q.value = 0.3;

  input.connect(delay);
  delay.connect(filter);
  filter.connect(fb);
  fb.connect(delay);
  filter.connect(output);

  return { input, output, delayNode: delay };
}

// Generates a stereo noise buffer (no external asset needed). type:
// 'white' (crackle/hiss), 'brown' (low rumble/wind bed), or 'pink' (a middle
// path for scrape/texture). Loopable.
export function createNoiseBuffer(ctx, seconds = 4, type = 'brown') {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    if (type === 'white') {
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.9;
    } else if (type === 'brown') {
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.012 * white) / 1.012;
        d[i] = last * 3.5; // brown noise is quiet; boost for a usable level
      }
    } else { // 'pink' — cheap Voss-style, sits between white and brown
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        d[i] = (b0 + b1 + b2 + white * 0.5362) * 0.2;
      }
    }
  }
  return buf;
}
