import type { Container3D } from '@pixi/3d';
import { Geometry3D, Material3D, Mesh3D } from '@pixi/3d';
import type { Texture } from 'pixi.js';

import type { Vehicle } from './Vehicle';

/** Max path samples kept alive (each becomes a ribbon cross-section). */
const MAX_POINTS = 110;
/** Seconds on asphalt before a sample is gone. */
const LIFE = 16;
const FADE_START = 0.5;
/** Min travel before a new sample — denser = smoother curves. */
const MIN_SPACING = 0.28;
/** Half-width of the dual-tire stamp across the rear axle. */
const HALF_WIDTH = 0.5;
/** World metres per texture repeat along the skid. */
const UV_TILE = 1.35;
/** Peak opacity — reads as rubber baked into asphalt, not a sticker. */
const PEAK_ALPHA = 0.4;
/** Sit flush on asphalt (track ~0, pit slab ~0.02). */
const GROUND_Y = 0.008;
/** Stop connecting ribbon segments after this gap (new skid streak). */
const BREAK_GAP = 1.35;

type Sample = {
  x: number;
  z: number;
  age: number;
  /** Cumulative path length for tiling UVs along the curve. */
  dist: number;
  /** False = start of a new streak (no quad to previous sample). */
  linked: boolean;
};

/**
 * Path-following skid ribbon: samples the rear axle while sliding, builds a
 * dynamic strip whose UVs run along the motion. On corners the strip bends with
 * the path so the mark warps like paint on asphalt, not a rigid stamp.
 */
export class TireMarks {
  private readonly _samples: Sample[] = [];
  private readonly _geometry: Geometry3D | null = null;
  private readonly _mesh: Mesh3D | null = null;
  private readonly _positions: Float32Array;
  private readonly _uvs: Float32Array;
  private readonly _colors: Float32Array;
  private _wasSkidding = false;
  private _lastX = Number.NaN;
  private _lastZ = Number.NaN;
  private _pathLen = 0;

  constructor(parent: Container3D, textures: Texture | Texture[]) {
    const list = Array.isArray(textures) ? textures : [textures];
    const tex = list.find(Boolean);
    const vertCount = MAX_POINTS * 2;
    this._positions = new Float32Array(vertCount * 3);
    this._uvs = new Float32Array(vertCount * 2);
    this._colors = new Float32Array(vertCount * 4);
    const normals = new Float32Array(vertCount * 3);
    for (let i = 0; i < vertCount; i++) {
      normals[i * 3 + 1] = 1;
      this._colors[i * 4] = 1;
      this._colors[i * 4 + 1] = 1;
      this._colors[i * 4 + 2] = 1;
    }

    const maxSeg = MAX_POINTS - 1;
    const indices = new Uint16Array(maxSeg * 6);
    for (let s = 0; s < maxSeg; s++) {
      const a = s * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      const o = s * 6;
      indices[o] = a;
      indices[o + 1] = b;
      indices[o + 2] = c;
      indices[o + 3] = b;
      indices[o + 4] = d;
      indices[o + 5] = c;
    }

    if (!tex) return;

    const geometry = new Geometry3D({
      positions: this._positions,
      normals,
      uvs: this._uvs,
      colors: this._colors,
      indices,
      indexCount: 0,
      dynamic: true,
    });

    const material = new Material3D({
      baseColorTexture: tex,
      // Slight charcoal tint so white maps still read as rubber on pale asphalt.
      baseColor: 0x2a2a2a,
      metallic: 0,
      roughness: 1,
      alphaMode: 'blend',
      alpha: 1,
      doubleSided: true,
    });
    material.vertexColors = true;
    material.state.depthMask = false;
    material.state.polygonOffset = 1;

    const mesh = new Mesh3D({
      geometry,
      material,
      castShadow: false,
      receiveShadow: false,
    });
    mesh.visible = false;
    parent.addChild(mesh);

    this._geometry = geometry;
    this._mesh = mesh;
  }

  public update(dt: number, vehicle: Vehicle): void {
    if (!this._geometry || !this._mesh) return;

    for (let i = this._samples.length - 1; i >= 0; i--) {
      const s = this._samples[i]!;
      s.age += dt;
      if (s.age >= LIFE) this._samples.splice(i, 1);
    }

    const speed = Math.abs(vehicle.linearSpeed);
    const skidding =
      (vehicle.handbrake && speed > 0.15) ||
      (vehicle.driftIntensity > 0.65 && speed > 0.22);

    if (skidding) {
      const fx = Math.sin(vehicle.yaw);
      const fz = Math.cos(vehicle.yaw);
      // Rear axle centre — rubber leaves the mark under the truck.
      const x = vehicle.spherePos.x - fx * 0.5;
      const z = vehicle.spherePos.z - fz * 0.5;

      let step = 0;
      if (!Number.isNaN(this._lastX)) {
        const dx = x - this._lastX;
        const dz = z - this._lastZ;
        step = Math.hypot(dx, dz);
        if (step < MIN_SPACING) {
          this._rebuild();
          return;
        }
      }

      const linked =
        this._wasSkidding &&
        !Number.isNaN(this._lastX) &&
        step > 0 &&
        step < BREAK_GAP;

      if (linked) this._pathLen += step;
      else this._pathLen = 0;

      this._samples.push({ x, z, age: 0, dist: this._pathLen, linked });
      while (this._samples.length > MAX_POINTS) this._samples.shift();

      this._lastX = x;
      this._lastZ = z;
      this._wasSkidding = true;
    } else {
      this._wasSkidding = false;
      this._lastX = Number.NaN;
      this._lastZ = Number.NaN;
    }

    this._rebuild();
  }

  private _rebuild(): void {
    const geo = this._geometry;
    const mesh = this._mesh;
    if (!geo || !mesh) return;

    const n = this._samples.length;
    if (n < 2) {
      geo.indexCount = 0;
      mesh.visible = false;
      return;
    }

    const pos = this._positions;
    const uvs = this._uvs;
    const cols = this._colors;

    for (let i = 0; i < n; i++) {
      const s = this._samples[i]!;
      const prev = this._samples[i - 1];
      const next = this._samples[i + 1];

      // Tangent from neighbours so the strip bends with the path (road-curve UV).
      let tx: number;
      let tz: number;
      if (prev && next) {
        tx = next.x - prev.x;
        tz = next.z - prev.z;
      } else if (next) {
        tx = next.x - s.x;
        tz = next.z - s.z;
      } else if (prev) {
        tx = s.x - prev.x;
        tz = s.z - prev.z;
      } else {
        tx = 0;
        tz = 1;
      }
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      // Perpendicular in XZ (left of travel).
      const px = -tz;
      const pz = tx;

      const vi = i * 2;
      const y = GROUND_Y;
      pos[vi * 3] = s.x + px * HALF_WIDTH;
      pos[vi * 3 + 1] = y;
      pos[vi * 3 + 2] = s.z + pz * HALF_WIDTH;
      pos[(vi + 1) * 3] = s.x - px * HALF_WIDTH;
      pos[(vi + 1) * 3 + 1] = y;
      pos[(vi + 1) * 3 + 2] = s.z - pz * HALF_WIDTH;

      const u = s.dist / UV_TILE;
      uvs[vi * 2] = u;
      uvs[vi * 2 + 1] = 0;
      uvs[(vi + 1) * 2] = u;
      uvs[(vi + 1) * 2 + 1] = 1;

      const t = s.age / LIFE;
      const fade =
        t < FADE_START ? 1 : 1 - ((t - FADE_START) / (1 - FADE_START)) ** 1.25;
      const a = PEAK_ALPHA * fade;
      for (let k = 0; k < 2; k++) {
        const ci = (vi + k) * 4;
        cols[ci] = 1;
        cols[ci + 1] = 1;
        cols[ci + 2] = 1;
        cols[ci + 3] = a;
      }
    }

    // Degenerate unlinked segments: zero-area so we can keep one index stream.
    // Quads only where `linked` — remap by rewriting indices for live pairs.
    const indices = geo.indices;
    let write = 0;
    for (let i = 1; i < n; i++) {
      if (!this._samples[i]!.linked) continue;
      const a = (i - 1) * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices[write++] = a;
      indices[write++] = b;
      indices[write++] = c;
      indices[write++] = b;
      indices[write++] = d;
      indices[write++] = c;
    }

    geo.indexCount = write;
    geo.attributes.aPosition.buffer.update();
    geo.attributes.aUV?.buffer.update();
    geo.attributes.aColor?.buffer.update();
    geo.indexBuffer.update();

    mesh.visible = write > 0;
  }
}
