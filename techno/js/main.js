import { AudioCore } from './audioCore.js';
import { Conductor } from './conductor.js';
import { Visualizer } from './visualizer.js';

const playBtn = document.getElementById('playBtn');
const volSlider = document.getElementById('vol');
const acidSlider = document.getElementById('acid');
const driveSlider = document.getElementById('drive');
const densSlider = document.getElementById('dens');
const tempoSlider = document.getElementById('tempo');
const statusEl = document.getElementById('status');
const canvas = document.getElementById('viz');

let core = null;
let conductor = null;

function updateStatus() {
  if (!conductor) return;
  const modeLabel = conductor.mode;
  statusEl.textContent = `${modeLabel} · root midi ${conductor.root} · ${conductor.bpm} bpm`;
}

function init() {
  core = new AudioCore({
    saturation: 0.35,
    reverb: { duration: 2.2, decay: 2.4, dark: 4500, return: 0.4 },
    delay: { time: 0.42, feedback: 0.42, cutoff: 3200, return: 0.5 },
  });
  conductor = new Conductor(core);
  new Visualizer(canvas, core.analyser, {
    gradient: ['#d7142c', '#ff3b30', '#22d3c4'],
    fade: 'rgba(11,6,8,0.22)',
    glow: 'rgba(255,59,48,0.4)',
  });

  core.setMasterVolume(parseFloat(volSlider.value));
  conductor.setAcidity(parseFloat(acidSlider.value));
  core.setSaturation(0.1 + parseFloat(driveSlider.value) * 0.45);
  conductor.setDensity(parseFloat(densSlider.value));
  conductor.setTempo(parseFloat(tempoSlider.value));
}

playBtn.addEventListener('click', async () => {
  if (!core) init();

  if (!conductor.running) {
    await core.start();
    conductor.start();
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
acidSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setAcidity(parseFloat(e.target.value));
});
driveSlider.addEventListener('input', (e) => {
  if (core) core.setSaturation(0.1 + parseFloat(e.target.value) * 0.45);
});
densSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setDensity(parseFloat(e.target.value));
});
tempoSlider.addEventListener('input', (e) => {
  if (conductor) {
    conductor.setTempo(parseFloat(e.target.value));
    updateStatus();
  }
});
