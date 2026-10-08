import type { Scene3DSource, View3D } from '@pixi/3d';
import { Container3D, Model3D, PointLight, Quaternion, Vector3 } from '@pixi/3d';
import { ConeShape, ParticleSystem3D } from '@pixi/3d/extras';
import type { Texture, Ticker } from 'pixi.js';

import type { Vehicle } from './Vehicle';

const PICKUP_SCALE = 0.7;
const PICKUP_BASE_Y = 0.95;
const PICKUP_RADIUS = 1.7;
const ROCKET_SPEED = 34;
const ROCKET_LIFE = 3.4;
const ROCKET_SCALE = 0.45;
const FIRE_COOLDOWN = 0.5;
const HIT_RADIUS = 1.85;
const MAX_ROCKETS = 8;

/** Default max lock distance (world units). Beyond this → no acquire / break. */
const DEFAULT_LOCK_RANGE = 18;
const LOCK_MIN_RANGE = 3;
/** ~22° half-angle — off-axis targets won't lock / guided shot misses. */
const LOCK_DOT = 0.925;
const LOCK_TIME = 1.15;
/** Mid-flight: if target drifts past this vs rocket heading, seek drops (miss). */
const SEEK_DOT = 0.55;
/** After a shot, brief dead time before a new lock can start. */
const REACQUIRE_DELAY = 0.4;
/** Screen-edge margin: outside this pad = off-frame → break lock. */
const FRAME_PAD = 48;

const _scr = { x: 0, y: 0 };

/** Particle size is half-angle (tan); match SmokeFX scale language. */
const PUFF = Math.tan((42 * Math.PI) / 180 / 2);

const _pos = new Vector3();
const _up = new Vector3(0, 1, 0);
const _right = new Vector3(1, 0, 0);
const _qYaw = new Quaternion();
const _qTip = new Quaternion();
const _q = new Quaternion();

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function aimRocket(root: Container3D, yaw: number): void {
  _qTip.setFromAxisAngle(_right, Math.PI / 2);
  _qYaw.setFromAxisAngle(_up, yaw);
  _q.copyFrom(_qYaw).multiply(_qTip);
  root.quaternion.copyFrom(_q);
}

type Pickup = {
  root: Container3D;
  light: PointLight;
  x: number;
  z: number;
  phase: number;
  taken: boolean;
};

type Rocket = {
  root: Container3D;
  vx: number;
  vz: number;
  vy: number;
  life: number;
  alive: boolean;
  target: Vehicle | null;
  turnRate: number;
};

export type LockSnapshot = {
  progress: number;
  locked: boolean;
  target: Vehicle | null;
  /** Bots currently in the acquisition cone (for 3rd-person boxes). */
  candidates: Vehicle[];
};

/**
 * Auto-lock + guided rockets, road pickups, pale exhaust trail.
 */
export class MissileSystem {
  public ammo = 0;
  public lockProgress = 0;
  public lockTarget: Vehicle | null = null;
  public candidates: Vehicle[] = [];
  /** Max distance to start / keep a lock (tune via dat.gui). */
  public lockRange = DEFAULT_LOCK_RANGE;

  private readonly _parent: Container3D;
  private readonly _source: Scene3DSource;
  private readonly _pickups: Pickup[] = [];
  private readonly _rockets: Rocket[] = [];
  private readonly _trail: ParticleSystem3D;
  private _cooldown = 0;
  private _reacquireT = 0;
  private _t = 0;

  constructor(
    parent: Container3D,
    source: Scene3DSource,
    smokeTexture: Texture,
    spots: { x: number; z: number }[],
  ) {
    this._parent = parent;
    this._source = source;

    this._trail = new ParticleSystem3D({
      texture: smokeTexture,
      capacity: 700,
      autoUpdate: false,
      emitRate: 0,
      shape: new ConeShape({ angle: 28, radius: 0.05 }),
      life: [0.4, 0.95],
      speed: [0.25, 0.7],
      size: [PUFF * 0.09, PUFF * 0.16],
      sizeEnd: [PUFF * 0.65, PUFF * 1.25],
      alpha: 0.55,
      alphaEnd: 0,
      // Hot white → soft yellow exhaust (not diesel black).
      color: 0xfff6e0,
      colorEnd: 0xffd27a,
      drag: 0.7,
      spin: [-0.4, 0.4],
    });
    parent.addChild(this._trail);

    for (let i = 0; i < spots.length; i++) {
      const spot = spots[i]!;
      this._pickups.push(this._makePickup(spot.x, spot.z, i * 1.7));
    }

    for (let i = 0; i < MAX_ROCKETS; i++) {
      this._rockets.push(this._makeRocket());
    }
  }

  public getLockSnapshot(): LockSnapshot {
    return {
      progress: this.lockProgress,
      locked: this.lockProgress >= 1 && !!this.lockTarget,
      target: this.lockTarget,
      candidates: this.candidates,
    };
  }

  /**
   * Fire. Full lock → strong seek. Early press → often dumb / weak seek (can miss).
   * Lock is always spent on fire (must re-acquire).
   */
  public tryFire(vehicle: Vehicle): 'guided' | 'early' | 'dumb' | 'empty' | 'cooldown' {
    if (this.ammo <= 0) return 'empty';
    if (this._cooldown > 0) return 'cooldown';
    const rocket = this._rockets.find((r) => !r.alive);
    if (!rocket) return 'cooldown';

    const yaw = vehicle.yaw;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const x = vehicle.spherePos.x + fx * 1.35;
    const z = vehicle.spherePos.z + fz * 1.35;

    const progress = this.lockProgress;
    const target = this.lockTarget;
    let seekTarget: Vehicle | null = null;
    let turnRate = 0;
    let result: 'guided' | 'early' | 'dumb' = 'dumb';

    // Hard rule: must be fully locked AND still on-axis at fire, or the shot is dumb / missy.
    const onAxis =
      !!target &&
      (() => {
        const dx = target.spherePos.x - vehicle.spherePos.x;
        const dz = target.spherePos.z - vehicle.spherePos.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.01) return false;
        return (dx * fx + dz * fz) / dist >= LOCK_DOT;
      })();

    if (target && progress >= 1 && onAxis) {
      seekTarget = target;
      turnRate = 4.6;
      result = 'guided';
    } else if (target && progress > 0.55 && onAxis) {
      // Early fire only works if still centered; low chance + weak seek.
      if (Math.random() < 0.15 + progress * 0.25) {
        seekTarget = target;
        turnRate = 0.7 + progress * 1.2;
        result = 'early';
      }
    }

    rocket.root.position.set(x, 0.55, z);
    aimRocket(rocket.root, yaw);
    rocket.root.visible = true;
    rocket.vx = fx * ROCKET_SPEED;
    rocket.vz = fz * ROCKET_SPEED;
    rocket.vy = 0.8;
    rocket.life = ROCKET_LIFE;
    rocket.alive = true;
    rocket.target = seekTarget;
    rocket.turnRate = turnRate;

    this.ammo -= 1;
    this._cooldown = FIRE_COOLDOWN;
    // Arcade: shot spends the lock — must re-acquire for the next one.
    this._clearLock();
    this._reacquireT = REACQUIRE_DELAY;
    return result;
  }

  public update(
    dt: number,
    ticker: Ticker,
    vehicle: Vehicle,
    targets: Vehicle[],
    view3d: View3D,
    screenW: number,
    screenH: number,
  ): void {
    this._t += dt;
    this._cooldown = Math.max(0, this._cooldown - dt);
    this._reacquireT = Math.max(0, this._reacquireT - dt);
    this._updateLock(dt, vehicle, targets, view3d, screenW, screenH);

    for (const p of this._pickups) {
      if (p.taken) continue;
      const bob = Math.sin(this._t * 2.4 + p.phase) * 0.14;
      p.root.position.y = PICKUP_BASE_Y + bob;
      p.root.rotation.y += dt * 1.6;
      const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this._t * 4.2 + p.phase));
      p.light.intensity = 18 * pulse;

      const dx = vehicle.spherePos.x - p.x;
      const dz = vehicle.spherePos.z - p.z;
      if (dx * dx + dz * dz < PICKUP_RADIUS * PICKUP_RADIUS) {
        p.taken = true;
        p.root.visible = false;
        this.ammo += 1;
      }
    }

    for (const r of this._rockets) {
      if (!r.alive) continue;
      r.life -= dt;

      if (r.target && r.turnRate > 0) {
        const tx = r.target.spherePos.x;
        const tz = r.target.spherePos.z;
        const ty = r.target.spherePos.y + 0.4;
        const px = r.root.position.x;
        const pz = r.root.position.z;
        const py = r.root.position.y;
        const toTx = tx - px;
        const toTz = tz - pz;
        const toDist = Math.hypot(toTx, toTz) || 1;
        const spd = Math.hypot(r.vx, r.vz) || ROCKET_SPEED;
        // Target slid too far off the rocket nose → lose seek (arcade miss).
        const align = (toTx * r.vx + toTz * r.vz) / (toDist * spd);
        if (align < SEEK_DOT) {
          r.target = null;
          r.turnRate = 0;
        } else {
          const desiredYaw = Math.atan2(toTx, toTz);
          const curYaw = Math.atan2(r.vx, r.vz);
          let dYaw = wrapAngle(desiredYaw - curYaw);
          const maxTurn = r.turnRate * dt;
          if (dYaw > maxTurn) dYaw = maxTurn;
          if (dYaw < -maxTurn) dYaw = -maxTurn;
          const yaw = curYaw + dYaw;
          r.vx = Math.sin(yaw) * spd;
          r.vz = Math.cos(yaw) * spd;
          const dy = ty - py;
          r.vy = r.vy * 0.9 + dy * 1.8 * dt;
        }
      }

      r.root.position.x += r.vx * dt;
      r.root.position.z += r.vz * dt;
      r.root.position.y += r.vy * dt;
      if (r.root.position.y < 0.4) r.root.position.y = 0.4;
      aimRocket(r.root, Math.atan2(r.vx, r.vz));

      const px = r.root.position.x;
      const pz = r.root.position.z;
      const spd = Math.hypot(r.vx, r.vz) || 1;
      _pos.set(px - (r.vx / spd) * 0.45, r.root.position.y, pz - (r.vz / spd) * 0.45);
      this._trail.spawn(4, { position: _pos });

      let hit = false;
      // Guided: only the locked target counts. Dumb fire can splash any bot but needs a near-nose pass.
      const hitList = r.target ? [r.target] : targets.filter((t) => t !== vehicle);
      for (const t of hitList) {
        const hx = t.spherePos.x - px;
        const hy = t.spherePos.y - r.root.position.y;
        const hz = t.spherePos.z - pz;
        const rad = r.target ? HIT_RADIUS : HIT_RADIUS * 0.72;
        if (hx * hx + hz * hz + hy * hy * 0.45 < rad * rad) {
          t.hitLaunch(1 + Math.random() * 0.25);
          hit = true;
          break;
        }
      }

      if (hit || r.life <= 0) {
        r.alive = false;
        r.root.visible = false;
        r.target = null;
      }
    }

    this._trail.update(ticker);
  }

  private _clearLock(): void {
    this.lockTarget = null;
    this.lockProgress = 0;
    this.candidates = [];
  }

  /** True when the bot is ahead in cone, in range, and still on screen. */
  private _inLockZone(
    player: Vehicle,
    target: Vehicle,
    view3d: View3D,
    screenW: number,
    screenH: number,
  ): boolean {
    const dx = target.spherePos.x - player.spherePos.x;
    const dz = target.spherePos.z - player.spherePos.z;
    const dist = Math.hypot(dx, dz);
    const maxRange = Math.max(LOCK_MIN_RANGE + 1, this.lockRange);
    if (dist < LOCK_MIN_RANGE || dist > maxRange) return false;

    const fx = Math.sin(player.yaw);
    const fz = Math.cos(player.yaw);
    const forward = (dx * fx + dz * fz) / dist;
    if (forward < LOCK_DOT) return false;

    const scr = view3d.worldToScreen(
      { x: target.spherePos.x, y: target.spherePos.y + 0.55, z: target.spherePos.z },
      _scr,
    );
    // Behind camera or outside the frame pad → out of "kadraj".
    if (!scr) return false;
    if (
      scr.x < FRAME_PAD ||
      scr.x > screenW - FRAME_PAD ||
      scr.y < FRAME_PAD ||
      scr.y > screenH - FRAME_PAD
    ) {
      return false;
    }
    return true;
  }

  private _updateLock(
    dt: number,
    player: Vehicle,
    targets: Vehicle[],
    view3d: View3D,
    screenW: number,
    screenH: number,
  ): void {
    if (this._reacquireT > 0) {
      this._clearLock();
      return;
    }

    const candidates: Vehicle[] = [];
    let best: Vehicle | null = null;
    let bestScore = Infinity;

    for (const t of targets) {
      if (t === player) continue;
      if (!this._inLockZone(player, t, view3d, screenW, screenH)) continue;
      candidates.push(t);
      const dx = t.spherePos.x - player.spherePos.x;
      const dz = t.spherePos.z - player.spherePos.z;
      const dist = Math.hypot(dx, dz);
      const fx = Math.sin(player.yaw);
      const fz = Math.cos(player.yaw);
      const forward = dist > 0.01 ? (dx * fx + dz * fz) / dist : 0;
      const score = dist * (1.4 - forward);
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    this.candidates = candidates;

    // Current lock leaves cone / frame / range → dump immediately (arcade).
    if (this.lockTarget && !this._inLockZone(player, this.lockTarget, view3d, screenW, screenH)) {
      this._clearLock();
      return;
    }

    if (best && best === this.lockTarget) {
      this.lockProgress = Math.min(1, this.lockProgress + dt / LOCK_TIME);
    } else if (best) {
      // Switched focus — restart acquire on the new target.
      this.lockTarget = best;
      this.lockProgress = 0.05;
    } else {
      this._clearLock();
    }
  }

  private _makePickup(x: number, z: number, phase: number): Pickup {
    const root = new Container3D();
    const model = new Model3D(this._source);
    model.scale.set(PICKUP_SCALE);
    root.addChild(model);

    const light = new PointLight({
      color: 0x8dff4a,
      intensity: 18,
      range: 7,
    });
    light.position.set(0, 0.35, 0);
    root.addChild(light);

    root.position.set(x, PICKUP_BASE_Y, z);
    this._parent.addChild(root);
    return { root, light, x, z, phase, taken: false };
  }

  private _makeRocket(): Rocket {
    const root = new Container3D();
    const model = new Model3D(this._source);
    model.scale.set(ROCKET_SCALE);
    root.addChild(model);
    root.visible = false;
    this._parent.addChild(root);
    return {
      root,
      vx: 0,
      vz: 0,
      vy: 0,
      life: 0,
      alive: false,
      target: null,
      turnRate: 0,
    };
  }
}
