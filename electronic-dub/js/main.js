import { AudioCore } from './audioCore.js';
import { Conductor } from './conductor.js';
import { Visualizer } from './visualizer.js';

const playBtn = document.getElementById('playBtn');
const volSlider = document.getElementById('vol');
const echoSlider = document.getElementById('echo');
const dropSlider = document.getElementById('drop');
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
    saturation: 0.16,
    reverb: { duration: 4.0, decay: 3.2, dark: 3600, return: 0.55 },
    delay: { time: 0.55, feedback: 0.5, cutoff: 2400, return: 0.65 },
  });
  conductor = new Conductor(core);
  new Visualizer(canvas, core.analyser, {
    gradient: ['#1d8f52', '#3ddc84', '#ff5a3c'],
    fade: 'rgba(5,12,8,0.22)',
    glow: 'rgba(61,220,132,0.4)',
  });

  core.setMasterVolume(parseFloat(volSlider.value));
  conductor.setEcho(parseFloat(echoSlider.value));
  conductor.setDropouts(parseFloat(dropSlider.value));
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
echoSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setEcho(parseFloat(e.target.value));
});
dropSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setDropouts(parseFloat(e.target.value));
});
tempoSlider.addEventListener('input', (e) => {
  if (conductor) {
    conductor.setTempo(parseFloat(e.target.value));
    updateStatus();
  }
});
