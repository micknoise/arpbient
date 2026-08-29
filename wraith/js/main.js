import { AudioCore } from './audioCore.js';
import { Conductor } from './conductor.js';
import { Visualizer } from './visualizer.js';

const playBtn = document.getElementById('playBtn');
const volSlider = document.getElementById('vol');
const dreadSlider = document.getElementById('dread');
const tensionSlider = document.getElementById('tension');
const bassSlider = document.getElementById('bass');
const tempoSlider = document.getElementById('tempo');
const statusEl = document.getElementById('status');
const canvas = document.getElementById('viz');

let core = null;
let conductor = null;
let viz = null;

const MODE_LABELS = { aeolian: 'aeolian', dorian: 'dorian', phrygian: 'phrygian' };

function updateStatus() {
  if (!conductor) return;
  const t = Math.round(conductor.tension * 100);
  statusEl.textContent = `${MODE_LABELS[conductor.mode]} · root midi ${conductor.root} · ${conductor.bpm} bpm · tension ${t}%`;
}

function init() {
  core = new AudioCore();
  conductor = new Conductor(core);
  viz = new Visualizer(canvas, core.analyser);

  core.setMasterVolume(parseFloat(volSlider.value));
  conductor.setDarknessOverride(parseFloat(dreadSlider.value));
  conductor.setDensityOverride(parseFloat(tensionSlider.value));
  conductor.setBassDensityOverride(parseFloat(bassSlider.value));
  conductor.setTempo(parseFloat(tempoSlider.value));
}

playBtn.addEventListener('click', async () => {
  if (!core) init();

  if (!conductor.running) {
    await core.start();
    conductor.start();
    viz.start();
    playBtn.textContent = 'STOP';
    updateStatus();
  } else {
    conductor.stop();
    viz.stop();
    await core.stop();
    playBtn.textContent = 'PLAY';
  }
});

// Keep the status readout (tension/phase) live without a render loop.
setInterval(updateStatus, 400);

volSlider.addEventListener('input', (e) => {
  if (core) core.setMasterVolume(parseFloat(e.target.value));
});
dreadSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setDarknessOverride(parseFloat(e.target.value));
});
tensionSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setDensityOverride(parseFloat(e.target.value));
});
bassSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setBassDensityOverride(parseFloat(e.target.value));
});
tempoSlider.addEventListener('input', (e) => {
  if (conductor) {
    conductor.setTempo(parseFloat(e.target.value));
    updateStatus();
  }
});
