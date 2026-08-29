// Slow-persistence oscilloscope with a neon gradient stroke -- CRT-glow feel.
export class Visualizer {
  constructor(canvas, analyser) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.analyser = analyser;
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
    // Idempotent: cancel any existing loop first so repeated play/stop cycles
    // don't stack multiple rAF loops (each of which would keep drawing).
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
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

    ctx.fillStyle = 'rgba(5,8,7,0.22)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const dpr = window.devicePixelRatio || 1;
    ctx.lineWidth = 2 * dpr;
    const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
    grad.addColorStop(0, '#5a8f2e');
    grad.addColorStop(0.5, '#c6ff3d');
    grad.addColorStop(1, '#d92b2b');
    ctx.strokeStyle = grad;
    ctx.shadowColor = 'rgba(217,43,43,0.35)';
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
