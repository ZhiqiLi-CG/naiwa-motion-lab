/** One Euro filter (Casiez et al. 2012) over a vector: little smoothing when moving fast, a lot when still. */
export class OneEuro {
  private x: Float64Array | null = null;
  private dx: Float64Array | null = null;
  private t = 0;

  constructor(
    public minCutoff: number,
    public beta: number,
    private readonly dCutoff = 1,
  ) {}

  reset(): void {
    this.x = null;
  }

  /** Filter v (in place) at time tSec. */
  filter(v: Float64Array | number[], tSec: number): void {
    if (!this.x || this.x.length !== v.length) {
      this.x = Float64Array.from(v);
      this.dx = new Float64Array(v.length);
      this.t = tSec;
      return;
    }
    const dt = Math.max(1e-3, tSec - this.t);
    this.t = tSec;
    const alpha = (cutoff: number) => {
      const r = 2 * Math.PI * cutoff * dt;
      return r / (r + 1);
    };
    const ad = alpha(this.dCutoff);
    const x = this.x, dx = this.dx!;
    for (let i = 0; i < v.length; i++) {
      dx[i] += ad * ((v[i] - x[i]) / dt - dx[i]);
      x[i] += alpha(this.minCutoff + this.beta * Math.abs(dx[i])) * (v[i] - x[i]);
      v[i] = x[i];
    }
  }
}
