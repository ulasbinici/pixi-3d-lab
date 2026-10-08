/** Grid cell in track space. */
export type Cell = { x: number; z: number };

export type Dir = 0 | 1 | 2 | 3; // N E S W

export const DIR_DELTA: ReadonlyArray<readonly [number, number]> = [
  [0, -1], // N
  [1, 0], // E
  [0, 1], // S
  [-1, 0], // W
];

export function opposite(d: Dir): Dir {
  return ((d + 2) % 4) as Dir;
}

export function dirBetween(a: Cell, b: Cell): Dir {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (dx === 1 && dz === 0) return 1;
  if (dx === -1 && dz === 0) return 3;
  if (dx === 0 && dz === 1) return 2;
  return 0;
}

function key(c: Cell): string {
  return `${c.x},${c.z}`;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function rectLoop(x0: number, z0: number, x1: number, z1: number): Cell[] {
  const loop: Cell[] = [];
  for (let x = x0; x <= x1; x++) loop.push({ x, z: z0 });
  for (let z = z0 + 1; z <= z1; z++) loop.push({ x: x1, z });
  for (let x = x1 - 1; x >= x0; x--) loop.push({ x, z: z1 });
  for (let z = z1 - 1; z > z0; z--) loop.push({ x: x0, z });
  return loop;
}

/**
 * Racing-style simple circuit: start from an inset rectangle, then randomly
 * push edges in/out so each seed feels different — never a filled maze.
 * Guarantees a single non-self-intersecting loop.
 */
export function generateRaceLoop(
  cols: number,
  rows: number,
  seed = (Math.random() * 1e9) | 0,
): { loop: Cell[]; seed: number } {
  const rng = mulberry32(seed);

  // Keep a grass margin so the track sits in the middle of the field.
  const margin = 1;
  let x0 = margin;
  let z0 = margin;
  let x1 = cols - 1 - margin;
  let z1 = rows - 1 - margin;

  // Shrink a bit more randomly for variety.
  x0 += Math.floor(rng() * 2);
  z0 += Math.floor(rng() * 2);
  x1 -= Math.floor(rng() * 2);
  z1 -= Math.floor(rng() * 2);
  if (x1 - x0 < 3) {
    x0 = margin;
    x1 = cols - 1 - margin;
  }
  if (z1 - z0 < 3) {
    z0 = margin;
    z1 = rows - 1 - margin;
  }

  let loop = rectLoop(x0, z0, x1, z1);
  const mutations = 10 + Math.floor(rng() * 14);

  for (let m = 0; m < mutations; m++) {
    const next = tryPushEdge(loop, cols, rows, rng);
    if (next) loop = next;
  }

  // Rotate so "start" (finish line) sits on a long straight if possible.
  loop = preferStraightStart(loop);

  return { loop, seed };
}

/** @deprecated use generateRaceLoop */
export const generateMazeLoop = generateRaceLoop;

/**
 * Pick a loop edge and push it one cell outward (away from interior) or
 * rarely inward, keeping a simple cycle with no revisited cells.
 */
function tryPushEdge(
  loop: Cell[],
  cols: number,
  rows: number,
  rng: () => number,
): Cell[] | null {
  const n = loop.length;
  if (n < 8) return null;

  const occupied = new Set(loop.map(key));
  let cx = 0;
  let cz = 0;
  for (const c of loop) {
    cx += c.x;
    cz += c.z;
  }
  cx /= n;
  cz /= n;

  const i = Math.floor(rng() * n);
  const a = loop[i]!;
  const b = loop[(i + 1) % n]!;
  const along = dirBetween(a, b);

  // Perpendiculars; pick the one pointing away from the track centroid as "outward".
  const left = ((along + 3) % 4) as Dir;
  const right = ((along + 1) % 4) as Dir;
  const midX = (a.x + b.x) / 2;
  const midZ = (a.z + b.z) / 2;
  const [ldx, ldz] = DIR_DELTA[left]!;
  const leftAway = (midX + ldx - cx) * ldx + (midZ + ldz - cz) * ldz;
  const outward = leftAway > 0 ? left : right;
  const inward = opposite(outward);
  const pushDir = rng() < 0.8 ? outward : inward;
  const [dx, dz] = DIR_DELTA[pushDir]!;

  const a2 = { x: a.x + dx, z: a.z + dz };
  const b2 = { x: b.x + dx, z: b.z + dz };

  if (!inBounds(a2, cols, rows) || !inBounds(b2, cols, rows)) return null;
  if (occupied.has(key(a2)) || occupied.has(key(b2))) return null;
  if (Math.abs(a2.x - b2.x) + Math.abs(a2.z - b2.z) !== 1) return null;

  // Replace edge a→b with a→a2→b2→b (adds a rectangular bay / jut).
  const next = [...loop.slice(0, i + 1), a2, b2, ...loop.slice(i + 1)];
  const seen = new Set<string>();
  for (const c of next) {
    const k = key(c);
    if (seen.has(k)) return null;
    seen.add(k);
  }
  return next;
}

function inBounds(c: Cell, cols: number, rows: number): boolean {
  return c.x >= 0 && c.z >= 0 && c.x < cols && c.z < rows;
}

function preferStraightStart(loop: Cell[]): Cell[] {
  const n = loop.length;
  let best = 0;
  let bestRun = 0;

  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n]!;
    const cur = loop[i]!;
    const next = loop[(i + 1) % n]!;
    const d0 = dirBetween(prev, cur);
    const d1 = dirBetween(cur, next);
    if (d0 !== d1) continue;

    let run = 1;
    for (let k = 1; k < n; k++) {
      const a = loop[(i + k - 1) % n]!;
      const b = loop[(i + k) % n]!;
      const c = loop[(i + k + 1) % n]!;
      if (dirBetween(a, b) !== dirBetween(b, c)) break;
      run++;
    }
    if (run > bestRun) {
      bestRun = run;
      best = i;
    }
  }

  if (best === 0) return loop;
  return [...loop.slice(best), ...loop.slice(0, best)];
}

export type TrackPieceKind = 'straight' | 'corner' | 'finish';

export type TrackPiece = {
  cell: Cell;
  kind: TrackPieceKind;
  /** Yaw in radians for the piece model. */
  yaw: number;
  /** Travel direction leaving this cell toward the next. */
  outDir: Dir;
};

/** Map a closed cell loop to straight / corner / finish pieces with yaw. */
export function loopToPieces(loop: Cell[]): TrackPiece[] {
  const n = loop.length;
  if (n < 3) return [];

  const pieces: TrackPiece[] = [];

  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n]!;
    const cur = loop[i]!;
    const next = loop[(i + 1) % n]!;
    const inDir = dirBetween(prev, cur);
    const outDir = dirBetween(cur, next);

    if (i === 0) {
      pieces.push({
        cell: cur,
        kind: 'finish',
        yaw: dirToYaw(outDir),
        outDir,
      });
      continue;
    }

    if (inDir === outDir) {
      pieces.push({
        cell: cur,
        kind: 'straight',
        yaw: dirToYaw(outDir),
        outDir,
      });
    } else {
      pieces.push({
        cell: cur,
        kind: 'corner',
        yaw: cornerYaw(inDir, outDir),
        outDir,
      });
    }
  }

  return pieces;
}

function dirToYaw(d: Dir): number {
  // Straight/finish GLBs run along local ±Z; yaw 0 = north-south (+Z south).
  switch (d) {
    case 0:
      return Math.PI;
    case 1:
      return Math.PI / 2;
    case 2:
      return 0;
    case 3:
      return -Math.PI / 2;
  }
}

/**
 * Corner GLB at yaw 0 opens West + South (racing pack). Positive yaw is CCW from above:
 * 0→W+S, 90°→S+E, 180°→E+N, 270°→N+W.
 */
function cornerYaw(inDir: Dir, outDir: Dir): number {
  const entrySide = opposite(inDir);
  const exitSide = outDir;
  const open = new Set<Dir>([entrySide, exitSide]);

  if (open.has(3) && open.has(2)) return 0;
  if (open.has(2) && open.has(1)) return Math.PI / 2;
  if (open.has(1) && open.has(0)) return Math.PI;
  if (open.has(0) && open.has(3)) return -Math.PI / 2;
  return 0;
}

export function cellWorld(cell: Cell, cellSize: number): { x: number; z: number } {
  return {
    x: (cell.x + 0.5) * cellSize,
    z: (cell.z + 0.5) * cellSize,
  };
}

/**
 * Mid-lap road fork: main lane + parallel pit lane (no barrier between).
 * Track GLBs on these pieces are skipped so baked curbs don't block the split.
 */
export type PitLane = {
  /** Main-loop piece indices that become the open dual carriageway. */
  pieceIndices: number[];
  side: -1 | 1;
  yaw: number;
  /** Pit-lane cell centers (world). */
  pads: { x: number; z: number }[];
  /** Parallel pit grid cells (for tree clearing). */
  pitCells: Cell[];
  midX: number;
  midZ: number;
  halfAlong: number;
  halfSide: number;
};

/** @deprecated use PitLane */
export type PitBay = PitLane;

function collectStraightRuns(pieces: TrackPiece[], runLen: number): number[][] {
  const n = pieces.length;
  const runs: number[][] = [];
  for (let i = 1; i < n - 1; i++) {
    const indices: number[] = [];
    let ok = true;
    for (let k = 0; k < runLen; k++) {
      const p = pieces[i + k];
      if (!p || p.kind !== 'straight') {
        ok = false;
        break;
      }
      if (k > 0 && p.yaw !== pieces[i]!.yaw) {
        ok = false;
        break;
      }
      indices.push(i + k);
    }
    if (ok) runs.push(indices);
  }
  return runs;
}

function tryPitOnRun(
  pieces: TrackPiece[],
  indices: number[],
  onTrack: Set<string>,
  centroid: { x: number; z: number },
  cellSize: number,
  preferOutward: boolean,
): PitLane | null {
  const first = pieces[indices[0]!]!;
  const yaw = first.yaw;
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  const { x: wx, z: wz } = cellWorld(first.cell, cellSize);
  const awayX = wx - centroid.x;
  const awayZ = wz - centroid.z;
  const outward: -1 | 1 = awayX * rightX + awayZ * rightZ >= 0 ? 1 : -1;
  const sides: Array<-1 | 1> = preferOutward ? [outward, (outward === 1 ? -1 : 1)] : [outward === 1 ? -1 : 1, outward];

  for (const side of sides) {
    const dgx = Math.round(rightX * side);
    const dgz = Math.round(rightZ * side);
    if (dgx === 0 && dgz === 0) continue;

    const pitCells: Cell[] = [];
    let free = true;
    for (const pi of indices) {
      const c = pieces[pi]!.cell;
      const pc = { x: c.x + dgx, z: c.z + dgz };
      // Allow off-grid grass; only reject if another track cell occupies it.
      if (onTrack.has(`${pc.x},${pc.z}`)) {
        free = false;
        break;
      }
      pitCells.push(pc);
    }
    if (!free) continue;

    const pads = pitCells.map((c) => cellWorld(c, cellSize));
    const mains = indices.map((pi) => cellWorld(pieces[pi]!.cell, cellSize));
    const midX =
      (mains.reduce((s, p) => s + p.x, 0) / mains.length + pads.reduce((s, p) => s + p.x, 0) / pads.length) / 2;
    const midZ =
      (mains.reduce((s, p) => s + p.z, 0) / mains.length + pads.reduce((s, p) => s + p.z, 0) / pads.length) / 2;

    return {
      pieceIndices: indices,
      side,
      yaw,
      pads,
      pitCells,
      midX,
      midZ,
      halfAlong: (indices.length * cellSize) / 2,
      halfSide: cellSize * 0.95,
    };
  }
  return null;
}

/**
 * Always try to open a pit fork on a straight stretch (3 cells → 2 → 1).
 * Prefers mid-lap outward side; falls back aggressively so a station always exists.
 */
export function findPitLane(loop: Cell[], pieces: TrackPiece[], cellSize: number): PitLane | null {
  const n = pieces.length;
  if (n < 4) return null;

  const onTrack = new Set(loop.map((c) => `${c.x},${c.z}`));
  let cx = 0;
  let cz = 0;
  for (const c of loop) {
    cx += c.x;
    cz += c.z;
  }
  cx = (cx / loop.length + 0.5) * cellSize;
  cz = (cz / loop.length + 0.5) * cellSize;
  const centroid = { x: cx, z: cz };
  const mid = Math.floor(n / 2);

  for (const runLen of [3, 2, 1]) {
    const runs = collectStraightRuns(pieces, runLen);
    runs.sort((a, b) => {
      const am = a[Math.floor(a.length / 2)]!;
      const bm = b[Math.floor(b.length / 2)]!;
      return Math.abs(am - mid) - Math.abs(bm - mid);
    });
    for (const indices of runs) {
      const pit = tryPitOnRun(pieces, indices, onTrack, centroid, cellSize, true);
      if (pit) return pit;
    }
  }

  // Last resort: any non-finish piece with a free lateral cell.
  for (let i = 1; i < n; i++) {
    const p = pieces[i]!;
    if (p.kind === 'corner') continue;
    const pit = tryPitOnRun(pieces, [i], onTrack, centroid, cellSize, true);
    if (pit) return pit;
  }

  return null;
}

/** @deprecated use findPitLane */
export const findPitBay = findPitLane;
