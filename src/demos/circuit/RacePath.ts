import { cellWorld, type Cell } from './maze';

export type PathSample = {
  x: number;
  z: number;
  /** Travel yaw (atan2(dx, dz)). */
  yaw: number;
  /** Arc length from start along the loop. */
  s: number;
};

/**
 * Dense centerline for the race loop. Arcade NPCs chase a lookahead sample
 * (pure pursuit) instead of snapping cell-to-cell.
 */
export class RacePath {
  public readonly samples: PathSample[] = [];
  public readonly length: number;

  constructor(loop: Cell[], cellSize: number, step = cellSize * 0.35) {
    const n = loop.length;
    if (n < 3) {
      this.length = 0;
      return;
    }

    const corners: { x: number; z: number }[] = [];
    for (let i = 0; i < n; i++) {
      corners.push(cellWorld(loop[i]!, cellSize));
    }

    let s = 0;
    for (let i = 0; i < n; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % n]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 1e-4) continue;

      const count = Math.max(1, Math.ceil(segLen / step));
      for (let k = 0; k < count; k++) {
        const t = k / count;
        const x = a.x + dx * t;
        const z = a.z + dz * t;
        const yaw = Math.atan2(dx, dz);
        this.samples.push({ x, z, yaw, s });
        s += segLen / count;
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
        return {
          x: cur.x + (next.x - cur.x) * t,
          z: cur.z + (next.z - cur.z) * t,
          yaw: cur.yaw,
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
