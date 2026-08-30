// Slow-persistence oscilloscope with a neon gradient stroke -- CRT-glow
// feel. Purely cosmetic; colors come from the engine's theme.
export class Visualizer {
  constructor(canvas, analyser, {
    gradient = ['#7a2ff0', '#ff2d55', '#22d3c4'],
    fade = 'rgba(6,4,12,0.22)',
    glow = 'rgba(255,45,85,0.35)',
  } = {}) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.analyser = analyser;
    this.gradient = gradient;
    this.fade = fade;
    this.glow = glow;
    this.data = new Uint8Array(analyser.frequencyBinCount);
    this._raf = null;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
  }

  start() {
    const loop = () => {
      this._draw();
      this._raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _draw() {
    const { ctx2d: ctx, canvas, analyser, data } = this;
    analyser.getByteTimeDomainData(data);

    ctx.fillStyle = this.fade;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const dpr = window.devicePixelRatio || 1;
    ctx.lineWidth = 2 * dpr;
    const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
    grad.addColorStop(0, this.gradient[0]);
    grad.addColorStop(0.5, this.gradient[1]);
    grad.addColorStop(1, this.gradient[2]);
    ctx.strokeStyle = grad;
    ctx.shadowColor = this.glow;
    ctx.shadowBlur = 8 * dpr;

    ctx.beginPath();
    const slice = canvas.width / data.length;
    let x = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i] / 128.0;
      const y = (v * canvas.height) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += slice;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}
