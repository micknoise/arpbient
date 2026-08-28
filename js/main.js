import { AudioCore } from './audioCore.js';
import { Conductor } from './conductor.js';
import { Visualizer } from './visualizer.js';

const playBtn = document.getElementById('playBtn');
const volSlider = document.getElementById('vol');
const darkSlider = document.getElementById('dark');
const densSlider = document.getElementById('dens');
const tempoSlider = document.getElementById('tempo');
const statusEl = document.getElementById('status');
const canvas = document.getElementById('viz');

let core = null;
let conductor = null;
let viz = null;

const MODE_LABELS = { aeolian: 'aeolian', phrygian: 'phrygian' };

function updateStatus() {
  if (!conductor) return;
  statusEl.textContent = `${MODE_LABELS[conductor.mode]} · root midi ${conductor.root} · ${conductor.bpm} bpm`;
}

function init() {
  core = new AudioCore();
  conductor = new Conductor(core);
  viz = new Visualizer(canvas, core.analyser);

  core.setMasterVolume(parseFloat(volSlider.value));
  conductor.setDarknessOverride(parseFloat(darkSlider.value));
  conductor.setDensityOverride(parseFloat(densSlider.value));
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
    await core.stop();
    playBtn.textContent = 'PLAY';
  }
});

volSlider.addEventListener('input', (e) => {
  if (core) core.setMasterVolume(parseFloat(e.target.value));
});
darkSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setDarknessOverride(parseFloat(e.target.value));
});
densSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setDensityOverride(parseFloat(e.target.value));
});
tempoSlider.addEventListener('input', (e) => {
  if (conductor) {
    conductor.setTempo(parseFloat(e.target.value));
    updateStatus();
  }
});
