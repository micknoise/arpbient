import { AudioCore } from './audioCore.js';
import { Conductor } from './conductor.js';
import { Visualizer } from './visualizer.js';

const playBtn = document.getElementById('playBtn');
const volSlider = document.getElementById('vol');
const spaceSlider = document.getElementById('space');
const densSlider = document.getElementById('dens');
const warmSlider = document.getElementById('warm');
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
    saturation: 0.1,
    reverb: { duration: 6.5, decay: 2.6, dark: 3600, return: 0.65 },
    delay: { time: 1.2, feedback: 0.5, cutoff: 2400, return: 0.5 },
  });
  conductor = new Conductor(core);
  new Visualizer(canvas, core.analyser, {
    gradient: ['#3b5bdb', '#5b8cff', '#37d5c0'],
    fade: 'rgba(5,7,15,0.22)',
    glow: 'rgba(91,140,255,0.4)',
  });

  core.setMasterVolume(parseFloat(volSlider.value));
  conductor.setSpace(parseFloat(spaceSlider.value));
  conductor.setDensity(parseFloat(densSlider.value));
  conductor.setWarmth(parseFloat(warmSlider.value));
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
spaceSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setSpace(parseFloat(e.target.value));
});
densSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setDensity(parseFloat(e.target.value));
});
warmSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setWarmth(parseFloat(e.target.value));
});
tempoSlider.addEventListener('input', (e) => {
  if (conductor) {
    conductor.setTempo(parseFloat(e.target.value));
    updateStatus();
  }
});
