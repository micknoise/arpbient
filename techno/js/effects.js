// Reusable effect builders shared by every engine: analog-style saturation,
// Juno-style chorus, an algorithmically synthesized reverb impulse, a
// tempo-able feedback delay, a dub-style ping-pong delay, and noise buffers.

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

// Synthesizes a decaying-noise impulse response for ConvolverNode --
// no external audio asset needed.
export function createReverbImpulse(ctx, duration = 4.5, decay = 3.2) {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * duration);
  const impulse = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
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

  return { input, output, delayNode: delay, setDelayTime: (v) => { delay.delayTime.value = v; }, setFeedback: (v) => { fb.gain.value = v; } };
}

// Alternating L/R echo with shared lowpass feedback -- the dub "ping-pong"
// echo. Wet-only output, like createDelay.
export function createPingPongDelay(ctx, { time = 0.42, feedback = 0.5, cutoff = 2400 } = {}) {
  const input = ctx.createGain();
  const output = ctx.createGain();

  const dL = ctx.createDelay(2.0);
  dL.delayTime.value = time;
  const dR = ctx.createDelay(2.0);
  dR.delayTime.value = time;

  const fb = ctx.createGain();
  fb.gain.value = feedback;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  filter.Q.value = 0.3;

  const pL = ctx.createStereoPanner();
  pL.pan.value = -0.7;
  const pR = ctx.createStereoPanner();
  pR.pan.value = 0.7;

  input.connect(dL);
  dL.connect(pL);
  pL.connect(output);
  pL.connect(filter);
  filter.connect(fb);
  fb.connect(dR);
  dR.connect(pR);
  pR.connect(output);
  pR.connect(filter);

  return {
    input,
    output,
    setDelayTime: (v) => { dL.delayTime.value = v; dR.delayTime.value = v; },
    setFeedback: (v) => { fb.gain.value = v; },
  };
}

// A shared pool of white noise for percussive voices -- each hit picks a
// random start offset so no two hits sound identical.
export function createNoiseBuffer(ctx, seconds = 2) {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}
