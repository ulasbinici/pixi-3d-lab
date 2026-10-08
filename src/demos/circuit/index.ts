import type { Hemisphere, Scene3DSource } from '@pixi/3d';
import {
  AmbientLight,
  Container3D,
  CubeGeometry,
  DirectionalLight,
  Material3D,
  Mesh3D,
  Model3D,
  PlaneGeometry,
  PointLight,
  SphereGeometry,
  SpotLight,
  View3D,
} from '@pixi/3d';
import * as dat from 'dat.gui';
import { Assets, Container, Text } from 'pixi.js';
import type { Texture } from 'pixi.js';

import type { DemoContext, DemoHandle } from '../types';
import { GameAudio } from './Audio';
import { BotDriver, makePersonality } from './Bot';
import { DriveCamera } from './Camera';
import { Controls } from './Controls';
import {
  cellWorld,
  findPitLane,
  generateRaceLoop,
  loopToPieces,
  type PitLane,
  type TrackPiece,
} from './maze';
import { botMapColor, Minimap } from './Minimap';
import type { WallSpec } from './Physics';
import { PhysicsWorld } from './Physics';
import { gridSlot, RacePath } from './RacePath';
import { GaugeHud } from './GaugeHud';
import { MissileHud } from './MissileHud';
import { MissileSystem } from './Missiles';
import { SmokeFX } from './SmokeFX';
import { TireMarks } from './TireMarks';
import { MAX_SPEED, Vehicle } from './Vehicle';

const CELL = 7.5;
/** Slightly larger field so soft outer sweeps have room. */
const COLS = 13;
const ROWS = 11;
const HEADLIGHT_INTENSITY = 140;
const HEADLIGHT_FILL = 22;
const MAX_BOTS = 5;

const ASSET = {
  truck: '/assets/racing/models/vehicle-truck-yellow.glb',
  forest: '/assets/racing/models/decoration-forest.glb',
  empty: '/assets/racing/models/decoration-empty.glb',
  straight: '/assets/racing/models/track-straight.glb',
  corner: '/assets/racing/models/track-corner.glb',
  finish: '/assets/racing/models/track-finish.glb',
  smoke: '/assets/racing/sprites/smoke.png',
  /** One consistent skid stamp — don't shuffle variants along the trail. */
  mark: '/assets/racing/sprites/marks/1.png',
  /** Remeshed from missle/ icon OBJ (raw file is ~900k tris). */
  missile: '/assets/racing/models/missile.glb',
};

type Coin = {
  mesh: Mesh3D;
  taken: boolean;
  x: number;
  z: number;
};

type Headlamp = { flood: SpotLight; pencil: SpotLight; fill: PointLight; scale: number };

function makeHeadlamp(side: -1 | 1, scale = 1): Headlamp {
  const flood = new SpotLight({
    color: 0xfff1c8,
    intensity: HEADLIGHT_INTENSITY * scale,
    range: 42 * Math.min(1, 0.75 + scale * 0.25),
    coneAngle: 26,
    penumbra: 0.4,
    castShadow: false,
  });
  const pencil = new SpotLight({
    color: 0xffffff,
    intensity: HEADLIGHT_INTENSITY * 0.7 * scale,
    range: 50 * Math.min(1, 0.75 + scale * 0.25),
    coneAngle: 11,
    penumbra: 0.2,
    castShadow: false,
  });
  const fill = new PointLight({
    color: 0xffe6b0,
    intensity: HEADLIGHT_FILL * scale,
    range: 6,
    castShadow: false,
  });
  const x = side * 0.48;
  flood.position.set(x, 0.82, 1.05);
  flood.rotation.set(-0.08, Math.PI, 0);
  pencil.position.set(x, 0.82, 1.05);
  pencil.rotation.set(-0.04, Math.PI, 0);
  fill.position.set(x, 0.78, 1.15);
  return { flood, pencil, fill, scale };
}

function attachHeadlamps(parent: Container3D, scale = 1): Headlamp[] {
  const lamps = [makeHeadlamp(-1, scale), makeHeadlamp(1, scale)];
  for (const lamp of lamps) parent.addChild(lamp.flood, lamp.pencil, lamp.fill);
  return lamps;
}

function applyHeadlampState(lamps: Headlamp[], on: boolean): void {
  for (const lamp of lamps) {
    lamp.flood.visible = lamp.pencil.visible = lamp.fill.visible = on;
    lamp.flood.intensity = on ? HEADLIGHT_INTENSITY * lamp.scale : 0;
    lamp.pencil.intensity = on ? HEADLIGHT_INTENSITY * 0.7 * lamp.scale : 0;
    lamp.fill.intensity = on ? HEADLIGHT_FILL * lamp.scale : 0;
  }
}

type DayMode = 'auto' | 'day' | 'night' | 'scrub';

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/**
 * Physics walls matched to the racing-pack meshes.
 * Straights get parallel side rails; corners get segmented inner/outer arcs
 * (axis-aligned cell edges leave open diagonals you could drive through).
 */
function buildTrackWalls(pieces: TrackPiece[], pit: PitLane | null): WallSpec[] {
  const S = 0.75;
  const CELL_RAW = CELL / S;
  const CELL_HALF = CELL_RAW / 2;
  const WALL_HALF_THICK = 0.25;
  const WALL_X = 4.75;
  /** Local-X of outer pit rail — flush with dual-lane asphalt edge (not deep in grass). */
  const PIT_OUTER_LX = WALL_X + CELL_RAW * 0.96;
  const WALL_HALF_H = 1.5;
  const pitSet = new Set(pit?.pieceIndices ?? []);

  const wallY = (0.5 + WALL_HALF_H) * S - 0.5;
  const hThick = WALL_HALF_THICK * S;
  const hHeight = WALL_HALF_H * S;
  const hLen = CELL_HALF * S;

  const ARC_SPAN = -Math.PI / 2;
  const ARC_CENTER_X = -CELL_HALF;
  const ARC_CENTER_Z = CELL_HALF;
  const OUTER_R = 2 * CELL_HALF - WALL_HALF_THICK;
  const OUTER_SEG = 10;
  const OUTER_SEG_HALF_LEN = ((OUTER_R * (Math.PI / 2)) / OUTER_SEG / 2) * S;
  const INNER_R = WALL_HALF_THICK + 0.35;
  const INNER_SEG = 4;
  const INNER_SEG_HALF_LEN = ((INNER_R * (Math.PI / 2)) / INNER_SEG / 2) * S;

  const walls: WallSpec[] = [];

  for (let pi = 0; pi < pieces.length; pi++) {
    const piece = pieces[pi]!;
    const { x: cx, z: cz } = cellWorld(piece.cell, CELL);
    const rad = piece.yaw;
    const cr = Math.cos(rad);
    const sr = Math.sin(rad);
    const isPitFork = pitSet.has(pi);

    if (piece.kind === 'straight' || piece.kind === 'finish') {
      for (const side of [-1, 1] as const) {
        // Fork stretch: no divider between main and pit — only the inner rail stays.
        if (isPitFork && pit && side === pit.side) continue;
        const lx = side * WALL_X;
        const wx = cx + lx * cr * S;
        const wz = cz + -lx * sr * S;
        walls.push({
          halfExtents: [hThick, hHeight, hLen],
          position: [wx, wallY, wz],
          quaternion: [0, Math.sin(rad / 2), 0, Math.cos(rad / 2)],
        });
      }
      // Outer rail flush with dual-lane asphalt edge (not deep in the grass).
      if (isPitFork && pit) {
        const lx = pit.side * PIT_OUTER_LX;
        walls.push({
          halfExtents: [hThick, hHeight, hLen],
          position: [cx + lx * cr * S, wallY, cz + -lx * sr * S],
          quaternion: [0, Math.sin(rad / 2), 0, Math.cos(rad / 2)],
        });
      }
    } else {
      const wcx = cx + (ARC_CENTER_X * cr + ARC_CENTER_Z * sr) * S;
      const wcz = cz + (-ARC_CENTER_X * sr + ARC_CENTER_Z * cr) * S;
      const arcStart = -rad;
      addArcWalls(walls, wcx, wcz, arcStart, OUTER_R, OUTER_SEG, OUTER_SEG_HALF_LEN, hThick, hHeight, wallY, ARC_SPAN, S);
      addArcWalls(walls, wcx, wcz, arcStart, INNER_R, INNER_SEG, INNER_SEG_HALF_LEN, hThick, hHeight, wallY, ARC_SPAN, S);
    }
  }

  // End caps seal only the pit-side grass pocket (WALL_X → outer rail).
  // Do NOT span the racing lane — that blocked the road.
  if (pit && pit.pieceIndices.length > 0) {
    const capYaw = pit.yaw + Math.PI / 2;
    const halfAng = capYaw / 2;
    const fwdX = Math.sin(pit.yaw);
    const fwdZ = Math.cos(pit.yaw);
    const rightX = Math.cos(pit.yaw);
    const rightZ = -Math.sin(pit.yaw);
    const capHalfLen = ((PIT_OUTER_LX - WALL_X) * S) / 2;
    const capMidLx = ((WALL_X + PIT_OUTER_LX) / 2) * S;
    const ends = [
      { pi: pit.pieceIndices[0]!, along: -1 },
      { pi: pit.pieceIndices[pit.pieceIndices.length - 1]!, along: 1 },
    ];
    for (const end of ends) {
      const main = cellWorld(pieces[end.pi]!.cell, CELL);
      const ex =
        main.x + fwdX * end.along * (CELL * 0.5) + rightX * pit.side * capMidLx;
      const ez =
        main.z + fwdZ * end.along * (CELL * 0.5) + rightZ * pit.side * capMidLx;
      walls.push({
        halfExtents: [hThick, hHeight, capHalfLen],
        position: [ex, wallY, ez],
        quaternion: [0, Math.sin(halfAng), 0, Math.cos(halfAng)],
      });
    }
  }

  return walls;
}

const CURB_RED = new Material3D({ baseColor: 0xe23b3b, metallic: 0.05, roughness: 0.55 });
const CURB_WHITE = new Material3D({ baseColor: 0xf2f4f8, metallic: 0.05, roughness: 0.55 });

/** Red/white candy curbs along a rail (matches racing-pack vibe). */
function addCandyCurb(
  root: Container3D,
  cx: number,
  cz: number,
  yaw: number,
  length: number,
): void {
  const seg = 0.75;
  const count = Math.max(2, Math.round(length / seg));
  const fwdX = Math.sin(yaw);
  const fwdZ = Math.cos(yaw);
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count - 0.5;
    const block = new Mesh3D({
      geometry: new CubeGeometry({ width: 0.32, height: 0.55, depth: seg * 0.92 }),
      material: i % 2 === 0 ? CURB_RED : CURB_WHITE,
      castShadow: true,
      receiveShadow: true,
    });
    block.position.set(cx + fwdX * t * length, 0.28, cz + fwdZ * t * length);
    block.rotation.y = yaw;
    root.addChild(block);
  }
}

function makePitGlass(color: number): Material3D {
  // Tinted glass — transmission from pixi-3d-beta examples.
  return new Material3D({
    baseColor: color,
    metallic: 0,
    roughness: 0.05,
    transmission: { factor: 0.9, thickness: 0.55 },
    ior: 1.5,
  });
}

type PitStation = {
  root: Container3D;
  canopy: Mesh3D;
  setCanopyColor: (tone: 'blue' | 'red') => void;
  setVisible: (on: boolean) => void;
};

/**
 * Dual-lane asphalt fork + gas station (pumps + glass canopy).
 * Track GLBs on these pieces are skipped so baked curbs don't block the split.
 */
function buildPitFork(parent: Container3D, pieces: TrackPiece[], pit: PitLane): PitStation {
  const station = new Container3D();
  parent.addChild(station);

  const asphaltMat = new Material3D({ baseColor: 0x353a44, metallic: 0, roughness: 0.88 });
  const lineMat = new Material3D({
    baseColor: 0xffd24a,
    metallic: 0.05,
    roughness: 0.5,
    emissive: { color: 0xffb000, strength: 0.4 },
  });
  const pumpMat = new Material3D({ baseColor: 0x1a1f28, metallic: 0.4, roughness: 0.35 });
  const pumpGlow = new Material3D({
    baseColor: 0xff8a3d,
    metallic: 0.2,
    roughness: 0.4,
    emissive: { color: 0xff6a00, strength: 1.4 },
  });
  const pillarMat = new Material3D({ baseColor: 0x2a3340, metallic: 0.35, roughness: 0.45 });
  const glassBlue = makePitGlass(0x3d8cff);
  const glassRed = makePitGlass(0xff3b4a);

  const S = 0.75;
  const CELL_RAW = CELL / S;
  const WALL_X = 4.75;
  const PIT_OUTER_LX = WALL_X + CELL_RAW * 0.96;
  const rightX = Math.cos(pit.yaw);
  const rightZ = -Math.sin(pit.yaw);
  const fwdX = Math.sin(pit.yaw);
  const fwdZ = Math.cos(pit.yaw);
  const cr = Math.cos(pit.yaw);
  const sr = Math.sin(pit.yaw);

  for (let i = 0; i < pit.pieceIndices.length; i++) {
    const piece = pieces[pit.pieceIndices[i]!]!;
    const main = cellWorld(piece.cell, CELL);
    const pad = pit.pads[i]!;
    const cx = (main.x + pad.x) / 2;
    const cz = (main.z + pad.z) / 2;

    const slab = new Mesh3D({
      geometry: new CubeGeometry({ width: CELL * 1.92, height: 0.1, depth: CELL * 0.98 }),
      material: asphaltMat,
      castShadow: false,
      receiveShadow: true,
    });
    slab.position.set(cx, 0.02, cz);
    slab.rotation.y = pit.yaw;
    station.addChild(slab);

    const dash = new Mesh3D({
      geometry: new CubeGeometry({ width: 0.16, height: 0.06, depth: CELL * 0.42 }),
      material: lineMat,
      castShadow: false,
      receiveShadow: true,
    });
    dash.position.set(cx, 0.08, cz);
    dash.rotation.y = pit.yaw;
    station.addChild(dash);

    const innerLx = -pit.side * WALL_X;
    const outerLx = pit.side * PIT_OUTER_LX;
    addCandyCurb(station, main.x + innerLx * cr * S, main.z + -innerLx * sr * S, pit.yaw, CELL * 0.98);
    addCandyCurb(station, main.x + outerLx * cr * S, main.z + -outerLx * sr * S, pit.yaw, CELL * 0.98);
  }

  // Entry/exit curbs: only the pit apron mouth (not across the racing line).
  const capYaw = pit.yaw + Math.PI / 2;
  const capLen = (PIT_OUTER_LX - WALL_X) * S;
  const capMidLx = ((WALL_X + PIT_OUTER_LX) / 2) * S;
  const ends = [
    { pi: pit.pieceIndices[0]!, along: -1 },
    { pi: pit.pieceIndices[pit.pieceIndices.length - 1]!, along: 1 },
  ];
  for (const end of ends) {
    const main = cellWorld(pieces[end.pi]!.cell, CELL);
    const ex = main.x + fwdX * end.along * (CELL * 0.5) + rightX * pit.side * capMidLx;
    const ez = main.z + fwdZ * end.along * (CELL * 0.5) + rightZ * pit.side * capMidLx;
    addCandyCurb(station, ex, ez, capYaw, capLen);
  }

  const midPad = pit.pads[Math.floor(pit.pads.length / 2)]!;
  const pumpOffsets = pit.pads.length >= 2 ? [-CELL * 0.35, CELL * 0.35] : [0];
  for (const lane of pumpOffsets) {
    const baseX = midPad.x + rightX * pit.side * (CELL * 0.22) + fwdX * lane;
    const baseZ = midPad.z + rightZ * pit.side * (CELL * 0.22) + fwdZ * lane;

    const body = new Mesh3D({
      geometry: new CubeGeometry({ width: 0.6, height: 1.25, depth: 0.5 }),
      material: pumpMat,
      castShadow: true,
      receiveShadow: true,
    });
    body.position.set(baseX, 0.62, baseZ);
    body.rotation.y = pit.yaw;
    station.addChild(body);

    const lamp = new Mesh3D({
      geometry: new CubeGeometry({ width: 0.4, height: 0.2, depth: 0.4 }),
      material: pumpGlow,
      castShadow: false,
      receiveShadow: false,
    });
    lamp.position.set(baseX, 1.35, baseZ);
    lamp.rotation.y = pit.yaw;
    station.addChild(lamp);

    // Support pillar under the glass roof.
    const pillar = new Mesh3D({
      geometry: new CubeGeometry({ width: 0.18, height: 2.1, depth: 0.18 }),
      material: pillarMat,
      castShadow: true,
      receiveShadow: true,
    });
    pillar.position.set(baseX + rightX * pit.side * 0.55, 1.05, baseZ + rightZ * pit.side * 0.55);
    station.addChild(pillar);
  }

  const canopyLen = Math.max(CELL * 1.4, pit.pads.length * CELL * 0.85);
  const canopy = new Mesh3D({
    geometry: new CubeGeometry({ width: CELL * 1.05, height: 0.12, depth: canopyLen }),
    material: glassBlue,
    castShadow: false,
    receiveShadow: false,
  });
  canopy.position.set(
    midPad.x + rightX * pit.side * (CELL * 0.12),
    2.35,
    midPad.z + rightZ * pit.side * (CELL * 0.12),
  );
  canopy.rotation.y = pit.yaw;
  station.addChild(canopy);

  return {
    root: station,
    canopy,
    setCanopyColor: (tone) => {
      canopy.material = tone === 'red' ? glassRed : glassBlue;
    },
    setVisible: (on) => {
      station.visible = on;
    },
  };
}

/** True when the car is on the pit half of the fork (not the racing line). */
function inPitZone(pit: PitLane, x: number, z: number): boolean {
  const dx = x - pit.midX;
  const dz = z - pit.midZ;
  const fwdX = Math.sin(pit.yaw);
  const fwdZ = Math.cos(pit.yaw);
  const rightX = Math.cos(pit.yaw);
  const rightZ = -Math.sin(pit.yaw);
  const localAlong = dx * fwdX + dz * fwdZ;
  const localSide = dx * rightX + dz * rightZ;
  if (Math.abs(localAlong) > pit.halfAlong) return false;
  // Pit half is on pit.side of centerline.
  const sidePos = localSide * pit.side;
  return sidePos > CELL * 0.05 && sidePos < pit.halfSide;
}

function addArcWalls(
  walls: WallSpec[],
  wcx: number,
  wcz: number,
  arcStart: number,
  radius: number,
  numSeg: number,
  segHalfLen: number,
  hThick: number,
  hHeight: number,
  wallY: number,
  arcSpan: number,
  scale: number,
): void {
  for (let i = 0; i < numSeg; i++) {
    const aMid = arcStart + ((i + 0.5) / numSeg) * arcSpan;
    const wx = wcx + radius * Math.cos(aMid) * scale;
    const wz = wcz + radius * Math.sin(aMid) * scale;
    const halfAng = -aMid / 2;
    walls.push({
      halfExtents: [hThick, hHeight, segHalfLen],
      position: [wx, wallY, wz],
      quaternion: [0, Math.sin(halfAng), 0, Math.cos(halfAng)],
    });
  }
}

export async function runCircuit(ctx: DemoContext): Promise<DemoHandle> {
  const { app, goHome } = ctx;

  const { loop, seed } = generateRaceLoop(COLS, ROWS);
  const pieces = loopToPieces(loop);
  const pit = findPitLane(loop, pieces, CELL);
  const onTrack = new Set(loop.map((c) => `${c.x},${c.z}`));
  const pitPieceSet = new Set(pit?.pieceIndices ?? []);
  const pitBlocked = new Set<string>();
  if (pit) {
    for (const pi of pit.pieceIndices) {
      const c = pieces[pi]!.cell;
      pitBlocked.add(`${c.x},${c.z}`);
    }
    for (const c of pit.pitCells) {
      pitBlocked.add(`${c.x},${c.z}`);
      // One more cell out so trees don't hug the far pit wall.
      const rightX = Math.cos(pit.yaw);
      const rightZ = -Math.sin(pit.yaw);
      pitBlocked.add(`${c.x + Math.round(rightX * pit.side)},${c.z + Math.round(rightZ * pit.side)}`);
    }
  }

  const hemi: Hemisphere = { skyColor: 0x87b5e0, groundColor: 0x5a7a45, intensity: 1 };
  const view3d = new View3D({
    autoResize: true,
    shadowQuality: 'high',
    toneMapping: 'aces',
    exposure: 1.05,
    environment: hemi,
    background: hemi,
    fog: { type: 'linear', color: 0x87b5e0, near: 40, far: 110 },
  });
  app.stage.addChild(view3d);

  const sources = await Promise.all([
    Assets.load<Scene3DSource>(ASSET.truck),
    Assets.load<Scene3DSource>(ASSET.forest),
    Assets.load<Scene3DSource>(ASSET.empty),
    Assets.load<Scene3DSource>(ASSET.straight),
    Assets.load<Scene3DSource>(ASSET.corner),
    Assets.load<Scene3DSource>(ASSET.finish),
    Assets.load<Texture>(ASSET.smoke),
    Assets.load<Texture>(ASSET.mark),
    Assets.load<Scene3DSource>(ASSET.missile),
  ]);
  const [
    truckSrc,
    forestSrc,
    emptySrc,
    straightSrc,
    cornerSrc,
    finishSrc,
    smokeTex,
    markTex,
    missileSrc,
  ] = sources;

  const sun = new DirectionalLight({
    color: 0xfff1dc,
    intensity: 2.4,
    castShadow: true,
    shadow: { bias: 0.0008, normalBias: 0.05, maxDistance: 120, cascades: 3, lambda: 0.55 },
  });
  const ambient = new AmbientLight({ color: 0xbcd0ea, intensity: 0.85 });
  view3d.root.addChild(sun, ambient);

  const ground = new Mesh3D({
    geometry: new PlaneGeometry({ width: COLS * CELL + 40, height: ROWS * CELL + 40 }),
    material: new Material3D({ baseColor: 0x3f6b3a, metallic: 0, roughness: 0.95 }),
    castShadow: false,
    receiveShadow: true,
  });
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((COLS * CELL) / 2, -0.12, (ROWS * CELL) / 2);
  view3d.root.addChild(ground);

  const trackRoot = view3d.root;
  const pieceSource = (p: TrackPiece): Scene3DSource => {
    if (p.kind === 'finish') return finishSrc;
    if (p.kind === 'corner') return cornerSrc;
    return straightSrc;
  };

  for (let pi = 0; pi < pieces.length; pi++) {
    // Pit fork uses custom dual-lane asphalt (track GLB has a baked barrier).
    if (pitPieceSet.has(pi)) continue;
    const piece = pieces[pi]!;
    const model = new Model3D(pieceSource(piece));
    const { x, z } = cellWorld(piece.cell, CELL);
    model.position.set(x, 0, z);
    model.rotation.y = piece.yaw;
    model.scale.set(0.75);
    trackRoot.addChild(model);
  }

  const pitStation = pit ? buildPitFork(trackRoot, pieces, pit) : null;

  // Trees only in open grass — keep clear of the racing line.
  const treeColliders: WallSpec[] = [];
  for (let gx = -1; gx <= COLS; gx++) {
    for (let gz = -1; gz <= ROWS; gz++) {
      if (onTrack.has(`${gx},${gz}`)) continue;
      if (pitBlocked.has(`${gx},${gz}`)) continue;
      // Skip cells orthogonally adjacent to the track so barriers aren't buried in trees.
      const nearTrack =
        onTrack.has(`${gx + 1},${gz}`) ||
        onTrack.has(`${gx - 1},${gz}`) ||
        onTrack.has(`${gx},${gz + 1}`) ||
        onTrack.has(`${gx},${gz - 1}`);
      if (nearTrack) continue;
      if (Math.random() > 0.45) continue;

      const kind = Math.random() > 0.3 ? 'forest' : 'empty';
      const model = new Model3D(kind === 'forest' ? forestSrc : emptySrc);
      const { x, z } = cellWorld({ x: gx, z: gz }, CELL);
      model.position.set(x, 0, z);
      model.rotation.y = Math.random() * Math.PI * 2;
      model.scale.set(0.7);
      trackRoot.addChild(model);
      const half =
        kind === 'forest'
          ? ([2.8, 2.2, 2.8] as [number, number, number])
          : ([1.4, 1, 1.4] as [number, number, number]);
      treeColliders.push({ halfExtents: half, position: [x, half[1], z], quaternion: [0, 0, 0, 1] });
    }
  }

  // Coins along the loop (skip finish).
  const coinGeom = new SphereGeometry({ radius: 0.28, widthSegments: 16, heightSegments: 12 });
  const coinMat = new Material3D({
    baseColor: 0xffd24a,
    metallic: 1,
    roughness: 0.25,
    emissive: { color: 0xffb000, strength: 1.2 },
  });
  const coins: Coin[] = [];
  for (let i = 1; i < loop.length; i += 2) {
    const cell = loop[i]!;
    const { x, z } = cellWorld(cell, CELL);
    const mesh = new Mesh3D({ geometry: coinGeom, material: coinMat });
    mesh.position.set(x, 0.85, z);
    trackRoot.addChild(mesh);
    coins.push({ mesh, taken: false, x, z });
  }
  let coinsLeft = coins.length;
  let coinsTaken = 0;

  // Missile pickups — staggered vs coins so both litter the racing line.
  const missileSpots: { x: number; z: number }[] = [];
  for (let i = 2; i < loop.length; i += 3) {
    const cell = loop[i]!;
    const { x, z } = cellWorld(cell, CELL);
    // Slight lateral offset so they don't sit exactly on coin centers.
    const side = i % 2 === 0 ? 1.1 : -1.1;
    missileSpots.push({ x: x + side * 0.35, z: z + side * 0.15 });
  }

  const finish = pieces[0]!;
  const spawnWorld = cellWorld(finish.cell, CELL);
  const spawnYaw = finish.outDir === 0 ? Math.PI : finish.outDir === 1 ? Math.PI / 2 : finish.outDir === 2 ? 0 : -Math.PI / 2;
  // Nudge spawn forward a bit along outbound.
  const fx = Math.sin(spawnYaw);
  const fz = Math.cos(spawnYaw);
  const startPos: [number, number, number] = [
    spawnWorld.x + fx * 0.5,
    0.5,
    spawnWorld.z + fz * 0.5,
  ];
  const pole = gridSlot(0, startPos, spawnYaw);
  const spawn = pole.spawn;

  const physics = new PhysicsWorld();
  physics.addStaticGround([spawnWorld.x, -0.125, spawnWorld.z], [80, 0.01, 80]);
  for (const w of buildTrackWalls(pieces, pit)) physics.addStaticBox(w);
  for (const w of treeColliders) physics.addStaticBox(w);

  const racePath = new RacePath(loop, CELL);

  const audio = new GameAudio();
  void audio.load();
  const unlockAudio = (): void => {
    audio.unlock();
    window.removeEventListener('keydown', unlockAudio);
    window.removeEventListener('pointerdown', unlockAudio);
  };
  window.addEventListener('keydown', unlockAudio);
  window.addEventListener('pointerdown', unlockAudio);

  const playerBody = physics.createSphere(spawn);
  const vehicle = new Vehicle(truckSrc, physics, playerBody, spawn, spawnYaw);
  view3d.root.addChild(vehicle.container);
  const smokeFX = new SmokeFX(view3d.root, vehicle, smokeTex);
  const tireMarks = new TireMarks(view3d.root, [markTex]);
  const missiles = new MissileSystem(view3d.root, missileSrc, smokeTex, missileSpots);
  const missileHud = new MissileHud();
  const gaugeHud = new GaugeHud();
  const playerHeadlamps = attachHeadlamps(vehicle.container, 1);

  type BotEntry = { vehicle: Vehicle; ai: BotDriver; headlamps: Headlamp[] };
  const bots: BotEntry[] = [];
  let racing = false;
  let headlightsOn = false;
  /** Once the player hits L, auto day/night won't override until day-mode changes. */
  let lightsManual = false;
  let dayMode: DayMode = 'auto';

  const allVehicles = (): Vehicle[] => [vehicle, ...bots.map((b) => b.vehicle)];
  const allHeadlamps = (): Headlamp[] => [...playerHeadlamps, ...bots.flatMap((b) => b.headlamps)];

  const setHeadlights = (on: boolean): void => {
    headlightsOn = on;
    applyHeadlampState(allHeadlamps(), on);
  };

  const placeOnGrid = (): void => {
    const playerSlot = gridSlot(0, startPos, spawnYaw);
    vehicle.resetTo(playerSlot.spawn, playerSlot.yaw);
    bots.forEach((bot, i) => {
      const slot = gridSlot(i + 1, startPos, spawnYaw);
      bot.vehicle.resetTo(slot.spawn, slot.yaw);
    });
  };

  const addBot = (): void => {
    if (bots.length >= MAX_BOTS) return;
    const slot = gridSlot(bots.length + 1, startPos, spawnYaw);
    const body = physics.createSphere(slot.spawn);
    const botVehicle = new Vehicle(truckSrc, physics, body, slot.spawn, slot.yaw);
    botVehicle.randomizePaint();
    view3d.root.addChild(botVehicle.container);
    // Slightly dimmer than the player so a full grid doesn't blow the light budget.
    const headlamps = attachHeadlamps(botVehicle.container, 0.55);
    applyHeadlampState(headlamps, headlightsOn);
    const ai = new BotDriver(makePersonality(bots.length));
    bots.push({ vehicle: botVehicle, ai, headlamps });
    racing = false;
    placeOnGrid();
    raceText.text = `Bots ${bots.length}/${MAX_BOTS}  ·  ${ai.personality.name} joined  ·  G start`;
  };

  const startRace = (): void => {
    if (bots.length === 0) {
      raceText.text = 'Add bots with B first';
      return;
    }
    placeOnGrid();
    racing = true;
    raceText.text = `Racing!  ${bots.length} bots  ·  Backspace reset`;
  };

  const resetRace = (): void => {
    racing = false;
    placeOnGrid();
    raceText.text =
      bots.length === 0
        ? 'B add bot  ·  G start  ·  Backspace reset'
        : `Grid ready  ·  ${bots.length} bots  ·  G start`;
  };

  physics.listener = {
    onContactAdded(bodyA, bodyB) {
      if (bodyA !== vehicle.body && bodyB !== vehicle.body) return;
      const fxx = Math.sin(vehicle.yaw);
      const fzz = Math.cos(vehicle.yaw);
      const mv = vehicle.modelVelocity;
      audio.playImpact(Math.abs(mv.x * fxx + mv.z * fzz));
    },
  };

  const driveCamera = new DriveCamera(view3d.camera, app.canvas);
  driveCamera.setMapBounds((COLS * CELL) / 2, (ROWS * CELL) / 2, Math.max(COLS, ROWS) * CELL);
  const controls = new Controls();

  // ---- HUD (Pixi + DOM gauges) ----
  const hud = new Container();
  app.stage.addChild(hud);
  const info = new Text({
    text: `Track ${seed}  ·  WASD  ·  Space  ·  Q rocket  ·  F fuel  ·  B bot  ·  G race  ·  Esc`,
    style: { fontFamily: 'IBM Plex Mono, monospace', fontSize: 13, fill: 0xffffff },
  });
  const coinText = new Text({
    text: `Coins ${coinsTaken}/${coins.length}`,
    style: { fontFamily: 'IBM Plex Mono, monospace', fontSize: 18, fill: 0xffd24a },
  });
  const missileText = new Text({
    text: `Rockets ${missiles.ammo}`,
    style: { fontFamily: 'IBM Plex Mono, monospace', fontSize: 16, fill: 0x8dff4a },
  });
  const timeText = new Text({
    text: 'Day',
    style: { fontFamily: 'IBM Plex Mono, monospace', fontSize: 14, fill: 0xe8f0ff },
  });
  const raceText = new Text({
    text: pit
      ? 'Pit fork mid-lap  ·  dive into outer lane  ·  F refuel'
      : 'B add bot  ·  G start  ·  Backspace reset',
    style: { fontFamily: 'IBM Plex Mono, monospace', fontSize: 14, fill: 0x7dffb3 },
  });
  const fuelText = new Text({
    text: 'Fuel 100%',
    style: { fontFamily: 'IBM Plex Mono, monospace', fontSize: 16, fill: 0x7ec8ff },
  });
  const minimap = new Minimap(loop, CELL, COLS, ROWS, pit);
  hud.addChild(
    info,
    coinText,
    missileText,
    timeText,
    raceText,
    fuelText,
    minimap.root,
    missileHud.root,
    gaugeHud.root,
  );

  const gaugeEl = document.createElement('div');
  gaugeEl.id = 'circuit-gauges';
  gaugeEl.style.cssText =
    'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);display:none;gap:18px;' +
    'padding:10px 16px;border-radius:16px;border:1px solid rgba(120,190,255,0.28);' +
    'background:rgba(8,12,22,0.72);backdrop-filter:blur(12px);font:500 12px/1.4 "IBM Plex Mono",monospace;color:#e8f0ff;z-index:15;';
  gaugeEl.innerHTML =
    '<div>SPD <strong id="g-spd">0</strong></div>' +
    '<div>RPM <strong id="g-rpm">0</strong></div>' +
    '<div>FUEL <strong id="g-fuel">100</strong>%</div>';
  document.body.appendChild(gaugeEl);
  const gSpd = gaugeEl.querySelector('#g-spd')!;
  const gRpm = gaugeEl.querySelector('#g-rpm')!;
  const gFuel = gaugeEl.querySelector('#g-fuel')!;

  const dayBtn = document.createElement('button');
  dayBtn.type = 'button';
  dayBtn.id = 'circuit-daymode';
  dayBtn.style.cssText =
    'position:fixed;top:20px;right:20px;z-index:16;cursor:pointer;padding:10px 14px;' +
    'border-radius:14px;border:1px solid rgba(120,190,255,0.28);' +
    'background:rgba(8,12,22,0.78);backdrop-filter:blur(12px);' +
    'font:600 12px/1.2 "IBM Plex Mono",monospace;color:#e8f0ff;letter-spacing:0.04em;';
  document.body.appendChild(dayBtn);

  const layoutHud = (): void => {
    info.position.set(20, app.screen.height - 34);
    coinText.position.set(20, 20);
    missileText.position.set(20, 44);
    timeText.position.set(20, 70);
    raceText.position.set(20, 94);
    fuelText.position.set(20, 118);
    minimap.layout(app.screen.width, app.screen.height);
    gaugeHud.layout(app.screen.width, app.screen.height);
  };
  layoutHud();

  setHeadlights(false);

  let fuel = 100;
  let fuelHintT = 0;
  let timeOfDay = 0.25; // morning
  const DAY_LENGTH = 90; // seconds for full cycle
  let wasNight = false;

  const setFuelHud = (): void => {
    const pct = Math.round(fuel);
    fuelText.text = `Fuel ${pct}%`;
    fuelText.style.fill = pct <= 20 ? 0xff6b6b : pct <= 45 ? 0xffd24a : 0x7ec8ff;
    gFuel.textContent = String(pct);
  };

  const guiState = {
    music: true,
    sfx: true,
    musicVolume: 0.4,
    sfxVolume: 0.85,
    timeOfDay: 0.25,
    dayMode: 'auto' as 'auto' | 'day' | 'night',
    pitVisible: true,
    canopyColor: 'blue' as 'blue' | 'red',
    missiles: missiles.ammo,
    lockRange: missiles.lockRange,
    gaugeHud: false,
    addBot: () => addBot(),
    startRace: () => startRace(),
    resetRace: () => resetRace(),
    randomPaint: () => vehicle.randomizePaint(),
  };

  const dayModeLabel = (mode: DayMode): string => {
    if (mode === 'auto') return 'TIME  auto';
    if (mode === 'day') return 'TIME  day';
    if (mode === 'night') return 'TIME  night';
    return 'TIME  scrub';
  };

  // ---- dat.gui test settings ----
  const gui = new dat.GUI({ width: 280 });
  gui.domElement.style.marginTop = '56px';

  const applyDayMode = (mode: DayMode): void => {
    dayMode = mode;
    dayBtn.textContent = dayModeLabel(mode);
    lightsManual = false;
    if (mode === 'day') {
      timeOfDay = 0.25;
      setHeadlights(false);
      wasNight = false;
    } else if (mode === 'night') {
      timeOfDay = 0.75;
      setHeadlights(true);
      wasNight = true;
    }
    guiState.timeOfDay = timeOfDay;
    if (mode !== 'scrub') guiState.dayMode = mode;
  };

  const cycleDayMode = (): void => {
    const cycle: DayMode[] = ['auto', 'day', 'night'];
    const i = cycle.indexOf(dayMode === 'scrub' ? 'auto' : dayMode);
    applyDayMode(cycle[(i + 1) % cycle.length]!);
  };
  dayBtn.addEventListener('click', cycleDayMode);

  const audioFolder = gui.addFolder('Audio');
  audioFolder.add(guiState, 'music').name('Music').onChange((v: boolean) => audio.setMusicEnabled(v));
  audioFolder.add(guiState, 'sfx').name('SFX').onChange((v: boolean) => audio.setSfxEnabled(v));
  audioFolder.add(guiState, 'musicVolume', 0, 1, 0.01).name('Music vol').onChange((v: number) => audio.setMusicVolume(v));
  audioFolder.add(guiState, 'sfxVolume', 0, 1, 0.01).name('SFX vol').onChange((v: number) => audio.setSfxVolume(v));
  audioFolder.open();
  const timeFolder = gui.addFolder('Time');
  timeFolder
    .add(guiState, 'timeOfDay', 0, 1, 0.001)
    .name('Timeline')
    .listen()
    .onChange((v: number) => {
      dayMode = 'scrub';
      timeOfDay = v;
      dayBtn.textContent = dayModeLabel('scrub');
      lightsManual = false;
      const night = Math.max(0, Math.sin(v * Math.PI * 2)) < 0.45;
      setHeadlights(night);
      wasNight = night;
    });
  timeFolder
    .add(guiState, 'dayMode', ['auto', 'day', 'night'])
    .name('Mode')
    .onChange((v: 'auto' | 'day' | 'night') => applyDayMode(v));
  timeFolder.open();
  const pitFolder = gui.addFolder('Pit stop');
  pitFolder
    .add(guiState, 'pitVisible')
    .name('Show pit')
    .onChange((v: boolean) => pitStation?.setVisible(v));
  pitFolder
    .add(guiState, 'canopyColor', ['blue', 'red'])
    .name('Glass roof')
    .onChange((v: 'blue' | 'red') => pitStation?.setCanopyColor(v));
  pitFolder.open();

  const weaponsFolder = gui.addFolder('Weapons');
  weaponsFolder
    .add(guiState, 'missiles', 0, 20, 1)
    .name('Missiles')
    .listen()
    .onChange((v: number) => {
      missiles.ammo = Math.round(v);
      missileText.text = `Rockets ${missiles.ammo}`;
    });
  weaponsFolder
    .add(guiState, 'lockRange', 8, 40, 0.5)
    .name('Lock range')
    .onChange((v: number) => {
      missiles.lockRange = v;
    });
  weaponsFolder.open();

  const hudFolder = gui.addFolder('HUD');
  const applyGaugeHud = (on: boolean): void => {
    gaugeHud.visible = on;
    // Graphical meters replace the flat fuel / FPV text gauges.
    fuelText.visible = !on;
    if (on) gaugeEl.style.display = 'none';
    else if (driveCamera.mode === 'fpv') gaugeEl.style.display = 'flex';
  };
  hudFolder
    .add(guiState, 'gaugeHud')
    .name('Graphic meters')
    .onChange((v: boolean) => applyGaugeHud(v));
  hudFolder.open();

  const raceFolder = gui.addFolder('Race');
  raceFolder.add(guiState, 'addBot').name('Add bot (B)');
  raceFolder.add(guiState, 'startRace').name('Start race (G)');
  raceFolder.add(guiState, 'resetRace').name('Reset (Bksp)');
  raceFolder.add(guiState, 'randomPaint').name('Paint (R)');
  raceFolder.open();

  applyDayMode('auto');
  audio.setMusicEnabled(true);
  audio.setSfxEnabled(true);
  audio.setMusicVolume(guiState.musicVolume);
  audio.setSfxVolume(guiState.sfxVolume);

  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'KeyC') {
      const mode = driveCamera.toggle();
      gaugeEl.style.display = !guiState.gaugeHud && mode === 'fpv' ? 'flex' : 'none';
      timeText.text = `${timeText.text.split(' · ')[0]} · cam ${mode}`;
    }
    if (e.code === 'KeyL') {
      lightsManual = true;
      setHeadlights(!headlightsOn);
    }
    if (e.code === 'KeyT') {
      cycleDayMode();
    }
    if (e.code === 'KeyQ') {
      const fired = missiles.tryFire(vehicle);
      if (fired === 'guided' || fired === 'early' || fired === 'dumb') {
        missileText.text = `Rockets ${missiles.ammo}`;
        raceText.text =
          fired === 'guided'
            ? 'Guided hit locked — re-acquire'
            : fired === 'early'
              ? 'Early fire — may miss · re-acquire'
              : 'No lock — dumb fire · re-acquire';
        fuelHintT = 1.5;
      } else if (fired === 'empty') {
        raceText.text = 'No rockets — grab the glowing missiles on track';
        fuelHintT = 2;
      }
    }
    if (e.code === 'KeyF') {
      if (!pit || !inPitZone(pit, vehicle.spherePos.x, vehicle.spherePos.z)) {
        raceText.text = 'Use the yellow-split pit lane (outer fork) to refuel';
        fuelHintT = 2.2;
      } else if (Math.abs(vehicle.linearSpeed) > 0.35) {
        raceText.text = 'Slow down in the pit, then press F';
        fuelHintT = 2.2;
      } else {
        fuel = 100;
        setFuelHud();
        audio.playFuel();
        raceText.text = 'Refueled! 100%';
        fuelHintT = 2.5;
      }
    }
    if (e.code === 'KeyR') {
      vehicle.randomizePaint();
    }
    if (e.code === 'KeyB') {
      addBot();
    }
    if (e.code === 'KeyG') {
      startRace();
    }
    if (e.code === 'Backspace') {
      e.preventDefault();
      resetRace();
    }
    if (e.code === 'Escape') goHome();
  };
  window.addEventListener('keydown', onKey);

  const onTick = (): void => {
    const dt = Math.min(app.ticker.deltaMS / 1000, 1 / 30);
    const input = controls.update();
    const pack = allVehicles();

    physics.step(dt);
    vehicle.update(dt, input);
    for (const bot of bots) {
      const botInput = bot.ai.update(dt, bot.vehicle, racePath, pack, racing);
      bot.vehicle.update(dt, botInput);
    }
    smokeFX.update(app.ticker, vehicle, input.z);
    tireMarks.update(dt, vehicle);
    missiles.update(dt, app.ticker, vehicle, pack, view3d, app.screen.width, app.screen.height);
    guiState.missiles = missiles.ammo;
    const lockSnap = missiles.getLockSnapshot();
    missileText.text =
      missiles.ammo > 0 && lockSnap.progress > 0.05
        ? `Rockets ${missiles.ammo}  ·  ${lockSnap.locked ? 'LOCK' : `${Math.round(lockSnap.progress * 100)}%`}`
        : `Rockets ${missiles.ammo}`;
    missileHud.update(dt, view3d, driveCamera.mode, lockSnap, app.screen.width, app.screen.height);

    // Day / night — auto cycles; day/night/scrub lock or drive the clock.
    if (dayMode === 'auto') {
      timeOfDay = (timeOfDay + dt / DAY_LENGTH) % 1;
      guiState.timeOfDay = timeOfDay;
    } else if (dayMode === 'day') {
      timeOfDay = 0.25;
    } else if (dayMode === 'night') {
      timeOfDay = 0.75;
    }
    // scrub: timeOfDay already set by the timeline slider
    const sunAngle = timeOfDay * Math.PI * 2 - Math.PI / 2;
    const dayFactor = Math.max(0, Math.sin(timeOfDay * Math.PI * 2));
    const nightFactor = 1 - dayFactor;

    sun.intensity = 0.15 + dayFactor * 2.4;
    sun.color.setValue(lerpColor(0x6a7cff, 0xfff1dc, dayFactor));
    ambient.intensity = 0.18 + dayFactor * 0.75;
    ambient.color.setValue(lerpColor(0x1a2740, 0xbcd0ea, dayFactor));

    const sky = lerpColor(0x0b1220, 0x87b5e0, dayFactor);
    const groundCol = lerpColor(0x1d2a18, 0x5a7a45, dayFactor);
    hemi.skyColor = sky;
    hemi.groundColor = groundCol;
    hemi.intensity = 0.55 + dayFactor * 0.55;
    view3d.fog = { type: 'linear', color: sky, near: 40, far: 110 };

    const cx = vehicle.spherePos.x;
    const cz = vehicle.spherePos.z;
    sun.position.set(cx + Math.cos(sunAngle) * 30, 8 + dayFactor * 22, cz + Math.sin(sunAngle) * 30);
    sun.lookAt({ x: cx, y: 0, z: cz });

    // Auto headlights for everyone (player + bots) unless L was used manually.
    const isNight = nightFactor > 0.55;
    if (!lightsManual && isNight !== wasNight) {
      setHeadlights(isNight);
    }
    wasNight = isNight;

    const phase =
      dayFactor > 0.75 ? 'Day' : dayFactor > 0.35 ? 'Dusk' : dayFactor > 0.12 ? 'Night' : 'Dawn';
    timeText.text = `${phase}  ·  ${dayMode}  ·  cam ${driveCamera.mode}`;

    // Coins
    for (const coin of coins) {
      if (coin.taken) continue;
      coin.mesh.rotation.y += dt * 2.5;
      coin.mesh.position.y = 0.85 + Math.sin(performance.now() * 0.004 + coin.x) * 0.08;
      const dx = vehicle.container.position.x - coin.x;
      const dz = vehicle.container.position.z - coin.z;
      if (dx * dx + dz * dz < 1.6) {
        coin.taken = true;
        coin.mesh.visible = false;
        coinsTaken++;
        coinsLeft--;
        audio.playCoin();
        coinText.text = `Coins ${coinsTaken}/${coins.length}`;
        if (coinsLeft === 0) coinText.text = `Coins ${coinsTaken}/${coins.length} — CLEAR!`;
      }
    }

    // Fuel + gauges
    const speedNorm = Math.abs(vehicle.linearSpeed) / MAX_SPEED;
    fuel = Math.max(0, fuel - dt * (0.35 + speedNorm * 1.1));
    if (fuel <= 0) {
      vehicle.linearSpeed *= 0.96;
    }
    setFuelHud();

    if (pit && inPitZone(pit, vehicle.spherePos.x, vehicle.spherePos.z) && fuelHintT <= 0) {
      raceText.text =
        Math.abs(vehicle.linearSpeed) > 0.35
          ? 'Pit — slow down, then F to refuel'
          : 'Pit — press F to refuel';
    }
    if (fuelHintT > 0) fuelHintT -= dt;

    const rpmNorm = Math.min(
      1,
      Math.abs(vehicle.linearSpeed) / MAX_SPEED * 0.85 + Math.max(0, input.z) * 0.2 + (vehicle.handbrake ? 0.08 : 0),
    );
    if (!guiState.gaugeHud && driveCamera.mode === 'fpv') {
      gSpd.textContent = String(Math.round(speedNorm * 180));
      gRpm.textContent = String(Math.round(800 + rpmNorm * 7200));
      gFuel.textContent = String(Math.round(fuel));
    }
    gaugeHud.update(dt, speedNorm, rpmNorm, fuel);

    driveCamera.update(dt, vehicle.container.position, vehicle.modelVelocity, vehicle.yaw);
    audio.update(dt, speedNorm, input.z, vehicle.driftIntensity);

    minimap.update([
      { vehicle, label: 'P', color: 0x7dffb3, isPlayer: true },
      ...bots.map((b, i) => ({
        vehicle: b.vehicle,
        label: `B${i + 1}`,
        color: botMapColor(i),
      })),
    ]);
    layoutHud();
  };
  app.ticker.add(onTick);

  return {
    destroy: () => {
      app.ticker.remove(onTick);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', unlockAudio);
      window.removeEventListener('pointerdown', unlockAudio);
      controls.destroy();
      driveCamera.destroy();
      audio.destroy();
      gaugeEl.remove();
      dayBtn.remove();
      gui.destroy();
      app.stage.removeChild(view3d);
      app.stage.removeChild(hud);
      view3d.destroy({ children: true });
      hud.destroy({ children: true });
    },
  };
}
