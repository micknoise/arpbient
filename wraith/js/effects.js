// Reusable effect builders: analog-style saturation, BBD-style chorus,
// a filtered feedback delay, and noise beds for the texture layer.
// (The reverb lives in its own module: reverb.js.)

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
