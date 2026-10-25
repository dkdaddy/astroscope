export class FocusGraph {
  private ctx: CanvasRenderingContext2D;
  private rawHistory: number[] = [];
  private smoothedHistory: number[] = [];
  private maxHistory = 140;

  private currentRaw = 0;
  private currentSmoothed = 0;
  private peakScore = 0;
  private emaAlpha = 0.25; // Fast exponential moving average for shake-resistant reading

  constructor(private canvas: HTMLCanvasElement) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('Canvas 2D context unavailable for FocusGraph');
    this.ctx = c;
  }

  pushScore(rawScore: number): {
    raw: number;
    smoothed: number;
    peak: number;
    percentOfPeak: number;
  } {
    this.currentRaw = rawScore;
    if (this.smoothedHistory.length === 0) {
      this.currentSmoothed = rawScore;
    } else {
      this.currentSmoothed =
        this.emaAlpha * rawScore + (1 - this.emaAlpha) * this.currentSmoothed;
    }

    if (this.currentSmoothed > this.peakScore) {
      this.peakScore = this.currentSmoothed;
    }

    this.rawHistory.push(rawScore);
    this.smoothedHistory.push(this.currentSmoothed);
    if (this.rawHistory.length > this.maxHistory) {
      this.rawHistory.shift();
      this.smoothedHistory.shift();
    }

    this.render();

    const percentOfPeak =
      this.peakScore > 0.1
        ? Math.min(100, Math.max(0, (this.currentSmoothed / this.peakScore) * 100))
        : 0;

    return {
      raw: this.currentRaw,
      smoothed: this.currentSmoothed,
      peak: this.peakScore,
      percentOfPeak
    };
  }

  resetPeak(): void {
    this.peakScore = this.currentSmoothed;
    this.rawHistory = [];
    this.smoothedHistory = [];
    this.render();
  }

  render(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, w, h);

    // Subtle background grid
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const y = (h / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    if (this.smoothedHistory.length < 2) return;

    const maxVal = Math.max(this.peakScore * 1.08, 10);
    const minVal = 0;
    const mapY = (v: number) => h - 8 - ((v - minVal) / (maxVal - minVal)) * (h - 18);

    // 1. Draw Peak horizontal reference line
    if (this.peakScore > 0) {
      const py = mapY(this.peakScore);
      ctx.save();
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.7)';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(w, py);
      ctx.stroke();
      ctx.restore();
    }

    // 2. Draw raw instantaneous trace (faint cyan)
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let i = 0; i < this.rawHistory.length; i++) {
      const x = (i / (this.maxHistory - 1)) * w;
      const y = mapY(this.rawHistory[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 3. Draw smoothed focus curve (bright emerald/amber depending on proximity to peak)
    const ratio = this.peakScore > 0 ? this.currentSmoothed / this.peakScore : 0;
    const lineColor = ratio >= 0.94 ? '#10b981' : ratio >= 0.75 ? '#38bdf8' : '#f59e0b';

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i < this.smoothedHistory.length; i++) {
      const x = (i / (this.maxHistory - 1)) * w;
      const y = mapY(this.smoothedHistory[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}
