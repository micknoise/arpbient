import { AudioCore } from './audioCore.js';
import { Conductor } from './conductor.js';
import { Visualizer } from './visualizer.js';

const playBtn = document.getElementById('playBtn');
const volSlider = document.getElementById('vol');
const densSlider = document.getElementById('dens');
const glitchSlider = document.getElementById('glitch');
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
    reverb: { duration: 3.2, decay: 3.0, dark: 4200, return: 0.45 },
    delay: { time: 0.3, feedback: 0.35, cutoff: 3200, return: 0.4 },
  });
  conductor = new Conductor(core);
  new Visualizer(canvas, core.analyser, {
    gradient: ['#7b2cbf', '#c04cff', '#4cc9f0'],
    fade: 'rgba(11,7,20,0.22)',
    glow: 'rgba(192,76,255,0.4)',
  });

  core.setMasterVolume(parseFloat(volSlider.value));
  conductor.setDensity(parseFloat(densSlider.value));
  conductor.setGlitch(parseFloat(glitchSlider.value));
  conductor.setTempo(parseFloat(tempoSlider.value));
  conductor.onMovementStart = updateStatus;
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
densSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setDensity(parseFloat(e.target.value));
});
glitchSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setGlitch(parseFloat(e.target.value));
});
tempoSlider.addEventListener('input', (e) => {
  if (conductor) {
    conductor.setTempo(parseFloat(e.target.value));
    updateStatus();
  }
});
