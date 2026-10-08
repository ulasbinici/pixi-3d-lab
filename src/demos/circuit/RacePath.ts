import { cellWorld, type Cell } from './maze';

export type PathSample = {
  x: number;
  z: number;
  /** Travel yaw (atan2(dx, dz)). */
  yaw: number;
  /** Arc length from start along the loop. */
  s: number;
};

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/**
 * Dense centerline for the race loop. Corner cells are blended with Catmull-Rom
 * so the racing line sweeps instead of snapping through hard elbows.
 */
export class RacePath {
  public readonly samples: PathSample[] = [];
  public readonly length: number;

  constructor(loop: Cell[], cellSize: number, step = cellSize * 0.28) {
    const n = loop.length;
    if (n < 3) {
      this.length = 0;
      return;
    }

    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i < n; i++) {
      pts.push(cellWorld(loop[i]!, cellSize));
    }

    let s = 0;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n]!;
      const p1 = pts[i]!;
      const p2 = pts[(i + 1) % n]!;
      const p3 = pts[(i + 2) % n]!;

      // Estimate segment length along the spline for step count.
      let est = 0;
      let lx = p1.x;
      let lz = p1.z;
      for (let k = 1; k <= 8; k++) {
        const t = k / 8;
        const x = catmullRom(p0.x, p1.x, p2.x, p3.x, t);
        const z = catmullRom(p0.z, p1.z, p2.z, p3.z, t);
        est += Math.hypot(x - lx, z - lz);
        lx = x;
        lz = z;
      }

      const count = Math.max(2, Math.ceil(est / step));
      for (let k = 0; k < count; k++) {
        const t = k / count;
        const x = catmullRom(p0.x, p1.x, p2.x, p3.x, t);
        const z = catmullRom(p0.z, p1.z, p2.z, p3.z, t);
        const x2 = catmullRom(p0.x, p1.x, p2.x, p3.x, Math.min(1, t + 1 / count));
        const z2 = catmullRom(p0.z, p1.z, p2.z, p3.z, Math.min(1, t + 1 / count));
        const dx = x2 - x;
        const dz = z2 - z;
        const yaw = Math.atan2(dx, dz);
        const ds = Math.hypot(dx, dz);
        this.samples.push({ x, z, yaw, s });
        s += ds;
      }
    }

    this.length = s;
  }

  /** Closest sample index to a world point (coarse; fine for arcade AI). */
  public nearestIndex(x: number, z: number): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.samples.length; i++) {
      const p = this.samples[i]!;
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Sample ahead by arc length (wraps). */
  public ahead(index: number, distance: number): PathSample {
    const n = this.samples.length;
    if (n === 0) return { x: 0, z: 0, yaw: 0, s: 0 };

    let remaining = distance;
    let i = index;
    while (remaining > 0 && n > 1) {
      const cur = this.samples[i]!;
      const nextI = (i + 1) % n;
      const next = this.samples[nextI]!;
      let ds = next.s - cur.s;
      if (ds < 0) ds += this.length;
      if (ds < 1e-5) {
        i = nextI;
        continue;
      }
      if (remaining <= ds) {
        const t = remaining / ds;
        let yaw = cur.yaw + (next.yaw - cur.yaw) * t;
        // Unwrap yaw blend.
        let dy = next.yaw - cur.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        yaw = cur.yaw + dy * t;
        return {
          x: cur.x + (next.x - cur.x) * t,
          z: cur.z + (next.z - cur.z) * t,
          yaw,
          s: (cur.s + remaining) % this.length,
        };
      }
      remaining -= ds;
      i = nextI;
    }
    return this.samples[i]!;
  }

  /** Heading change over the next `distance` meters — higher = sharper corner. */
  public curvatureAhead(index: number, distance: number): number {
    const a = this.samples[index];
    if (!a) return 0;
    const b = this.ahead(index, distance);
    let d = b.yaw - a.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d);
  }
}

/** Starting-grid slot: index 0 = pole (player), then bots. */
export function gridSlot(
  index: number,
  start: readonly [number, number, number],
  yaw: number,
): { spawn: [number, number, number]; yaw: number } {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const row = Math.floor(index / 2);
  const col = index % 2 === 0 ? -1 : 1;
  const back = -row * 3.4;
  const side = col * 1.75;
  return {
    spawn: [start[0] + fx * back + rx * side, start[1], start[2] + fz * back + rz * side],
    yaw,
  };
}
