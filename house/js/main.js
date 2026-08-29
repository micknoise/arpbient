import { AudioCore } from './audioCore.js';
import { Conductor } from './conductor.js';
import { Visualizer } from './visualizer.js';

const playBtn = document.getElementById('playBtn');
const volSlider = document.getElementById('vol');
const warmSlider = document.getElementById('warm');
const swingSlider = document.getElementById('swing');
const densSlider = document.getElementById('dens');
const tempoSlider = document.getElementById('tempo');
const statusEl = document.getElementById('status');
const canvas = document.getElementById('viz');

let core = null;
let conductor = null;

function updateStatus() {
  if (!conductor) return;
  statusEl.textContent = `${conductor.mode} · root midi ${conductor.root} · ${conductor.bpm} bpm`;
}

function init() {
  core = new AudioCore({
    saturation: 0.2,
    reverb: { duration: 3.0, decay: 2.8, dark: 4200, return: 0.5 },
    delay: { time: 0.4, feedback: 0.45, cutoff: 2800, return: 0.55 },
  });
  conductor = new Conductor(core);
  new Visualizer(canvas, core.analyser, {
    gradient: ['#d97706', '#ffa028', '#2dd4bf'],
    fade: 'rgba(12,10,5,0.22)',
    glow: 'rgba(255,160,40,0.4)',
  });

  core.setMasterVolume(parseFloat(volSlider.value));
  conductor.setWarmth(parseFloat(warmSlider.value));
  conductor.setSwing(parseFloat(swingSlider.value));
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
warmSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setWarmth(parseFloat(e.target.value));
});
swingSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setSwing(parseFloat(e.target.value));
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
