import { midiToFreq, dronePitches } from './theory.js';

// The always-present low "pressure" bed: a sub-octave drone built from
// slightly detuned sine pairs (so it breathes and wobbles rather than sitting
// as a static pitch), a slow amplitude LFO, a slow pitch-creep LFO, and an
// optional low saw body for harmonic weight. It never fully stops during a
// session — the conductor rides its level and re-aims its pitch at key
// changes. Felt in the chest more than heard: most of it sits under 100 Hz.
export class DroneLayer {
  constructor(ctx, audioCore, { reverbAmount = 0.1 } = {}) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;

    // voiceMix -> lowpass -> breath (LFO'd) -> levelGain -> output
    this.voiceMix = ctx.createGain();
    this.voiceMix.gain.value = 1;

    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 220;
    this.lowpass.Q.value = 0.7;

    this.breath = ctx.createGain();
    this.breath.gain.value = 1;

    this.levelGain = ctx.createGain();
    this.levelGain.gain.value = 0;

    this.voiceMix.connect(this.lowpass);
    this.lowpass.connect(this.breath);
    this.breath.connect(this.levelGain);
    this.levelGain.connect(this.output);
    audioCore.connectLayerOutput(this.output, { reverbAmount });
    audioCore.connectGrit(this.output, 0.12);

    // Slow "breathing" LFO on the breath gain. Started once here for the
    // context's lifetime (like the organ/texture LFOs) and never stopped — a
    // Web Audio oscillator CANNOT be started again once stopped, so reusing
    // these across start()/stop() would throw on the second play and wedge
    // the whole engine.
    this.ampLfo = ctx.createOscillator();
    this.ampLfo.type = 'sine';
    this.ampLfo.frequency.value = 0.04;
    this.ampLfoDepth = ctx.createGain();
    this.ampLfoDepth.gain.value = 0.25;
    this.ampLfo.connect(this.ampLfoDepth);
    this.ampLfoDepth.connect(this.breath.gain);
    this.ampLfo.start();

    // Slow pitch-creep LFO (in cents) shared by every voice's detune.
    this.pitchLfo = ctx.createOscillator();
    this.pitchLfo.type = 'sine';
    this.pitchLfo.frequency.value = 0.02;
    this.pitchLfoDepth = ctx.createGain();
    this.pitchLfoDepth.gain.value = 6;
    this.pitchLfo.start();

    this.voices = []; // { oscA, oscB, gain, offset }
    this.saw = null;
    this.sawGain = null;
    this.baseMidi = 33;
    this.interval = 7;
    this.started = false;
  }

  start(baseMidi = 33, interval = 7) {
    if (this.started) return;
    this.started = true;
    this.baseMidi = baseMidi;
    this.interval = interval;
    // The LFOs are already running (started once in the constructor); only
    // the voices are (re)built here.
    this._buildVoices();
  }

  _buildVoices() {
    const ctx = this.ctx;
    const pitches = dronePitches(this.baseMidi, { interval: this.interval });
    this.voices = [];
    pitches.forEach((p, i) => {
      const offset = p - this.baseMidi;
      const freq = midiToFreq(p);
      const oscA = ctx.createOscillator();
      oscA.type = 'sine';
      oscA.frequency.value = freq;
      oscA.detune.value = -4;
      const oscB = ctx.createOscillator();
      oscB.type = 'sine';
      oscB.frequency.value = freq;
      oscB.detune.value = 4;
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 0.6 : 0.34;
      this.pitchLfoDepth.connect(oscA.detune);
      this.pitchLfoDepth.connect(oscB.detune);
      oscA.connect(g);
      oscB.connect(g);
      g.connect(this.voiceMix);
      oscA.start();
      oscB.start();
      this.voices.push({ oscA, oscB, gain: g, offset });
    });

    // Low saw body for harmonic weight; level rides setDepth.
    this.saw = ctx.createOscillator();
    this.saw.type = 'sawtooth';
    this.saw.frequency.value = midiToFreq(this.baseMidi);
    this._sawLp = ctx.createBiquadFilter();
    this._sawLp.type = 'lowpass';
    this._sawLp.frequency.value = 130;
    this.sawGain = ctx.createGain();
    this.sawGain.gain.value = 0.0;
    this.pitchLfoDepth.connect(this.saw.detune);
    this.saw.connect(this._sawLp);
    this._sawLp.connect(this.sawGain);
    this.sawGain.connect(this.voiceMix);
    this.saw.start();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    // The voices/saw are rebuilt fresh every start() (a new movement), but
    // their gains stay wired into the persistent voiceMix/pitchLfoDepth
    // buses until explicitly disconnected -- otherwise every movement
    // leaves behind a stopped, orphaned copy of this whole voice graph
    // still attached to those long-lived nodes.
    this.voices.forEach((v) => {
      v.oscA.stop();
      v.oscB.stop();
      try { v.oscA.disconnect(); } catch (e) { /* already disconnected */ }
      try { v.oscB.disconnect(); } catch (e) { /* already disconnected */ }
      try { v.gain.disconnect(); } catch (e) { /* already disconnected */ }
      try { this.pitchLfoDepth.disconnect(v.oscA.detune); } catch (e) { /* already disconnected */ }
      try { this.pitchLfoDepth.disconnect(v.oscB.detune); } catch (e) { /* already disconnected */ }
    });
    if (this.saw) {
      this.saw.stop();
      try { this.saw.disconnect(); } catch (e) { /* already disconnected */ }
      try { this._sawLp.disconnect(); } catch (e) { /* already disconnected */ }
      try { this.sawGain.disconnect(); } catch (e) { /* already disconnected */ }
      try { this.pitchLfoDepth.disconnect(this.saw.detune); } catch (e) { /* already disconnected */ }
    }
    // The LFOs keep running (they're started once for the context's life and
    // cannot be re-started after being stopped) — with no voices connected
    // they're inert, and the next start() rebuilds fresh voices onto them.
    this.voices = [];
  }

  setLevel(v) {
    this.levelGain.gain.setTargetAtTime(v, this.ctx.currentTime, 1.2);
  }

  // 0..1 — how much low saw body/edge sits under the sines.
  setDepth(v) {
    if (this.sawGain) this.sawGain.gain.setTargetAtTime(v * 0.2, this.ctx.currentTime, 1.5);
  }

  setBreathing(rateHz, amount) {
    this.ampLfo.frequency.setTargetAtTime(rateHz, this.ctx.currentTime, 2);
    this.ampLfoDepth.gain.setTargetAtTime(amount, this.ctx.currentTime, 2);
  }

  // Glide the whole drone to a new base pitch (key change) without a click.
  setPitch(baseMidi) {
    const now = this.ctx.currentTime;
    this.baseMidi = baseMidi;
    this.voices.forEach((v) => {
      const f = midiToFreq(baseMidi + v.offset);
      v.oscA.frequency.setTargetAtTime(f, now, 2.0);
      v.oscB.frequency.setTargetAtTime(f, now, 2.0);
    });
    if (this.saw) this.saw.frequency.setTargetAtTime(midiToFreq(baseMidi), now, 2.0);
  }

  // 0..1 — open the lowpass (brighter/more present) or close it (darker).
  setCutoff(v) {
    this.lowpass.frequency.setTargetAtTime(130 + v * 620, this.ctx.currentTime, 2);
  }
}
