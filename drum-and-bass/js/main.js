import { AudioCore } from './audioCore.js';
import { Conductor } from './conductor.js';
import { Visualizer } from './visualizer.js';

const playBtn = document.getElementById('playBtn');
const volSlider = document.getElementById('vol');
const reeseSlider = document.getElementById('reese');
const liquidSlider = document.getElementById('liquid');
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
    saturation: 0.22,
    reverb: { duration: 3.4, decay: 3.0, dark: 4000, return: 0.5 },
    delay: { time: 0.3, feedback: 0.38, cutoff: 3000, return: 0.45 },
  });
  conductor = new Conductor(core);
  new Visualizer(canvas, core.analyser, {
    gradient: ['#0f9d58', '#2eff9e', '#ffd60a'],
    fade: 'rgba(4,10,8,0.22)',
    glow: 'rgba(46,255,158,0.4)',
  });

  core.setMasterVolume(parseFloat(volSlider.value));
  conductor.setReese(parseFloat(reeseSlider.value));
  conductor.setLiquid(parseFloat(liquidSlider.value));
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
reeseSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setReese(parseFloat(e.target.value));
});
liquidSlider.addEventListener('input', (e) => {
  if (conductor) conductor.setLiquid(parseFloat(e.target.value));
});
tempoSlider.addEventListener('input', (e) => {
  if (conductor) {
    conductor.setTempo(parseFloat(e.target.value));
    updateStatus();
  }
});
