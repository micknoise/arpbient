import { AudioCore } from './audioCore.js';
import { Conductor } from './conductor.js';
import { Visualizer } from './visualizer.js';

const playBtn = document.getElementById('playBtn');
const volSlider = document.getElementById('vol');
const stutterSlider = document.getElementById('stutter');
const breakSlider = document.getElementById('breaks');
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
    saturation: 0.26,
    reverb: { duration: 2.8, decay: 2.6, dark: 5000, return: 0.4 },
    delay: { time: 0.22, feedback: 0.32, cutoff: 4000, return: 0.35 },
  });
  conductor = new Conductor(core);
  new Visualizer(canvas, core.analyser, {
    gradient: ['#ff2e88', '#c8ff00', '#ff7a00'],
    fade: 'rgba(18,5,12,0.22)',
    glow: 'rgba(255,46,136,0.45)',
  });

  core.setMasterVolume(parseFloat(volSlider.value));
  conductor.setStutter(parseFloat(stutterSlider.value));
  conductor.setBreaks(parseFloat(breakSlider.value));
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
stutterSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setStutter(parseFloat(e.target.value));
});
breakSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setBreaks(parseFloat(e.target.value));
});
tempoSlider.addEventListener('input', (e) => {
  if (conductor) {
    conductor.setTempo(parseFloat(e.target.value));
    updateStatus();
  }
});
