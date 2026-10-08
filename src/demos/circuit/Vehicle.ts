import type { Scene3DSource } from '@pixi/3d';
import { clamp, Container3D, lerp, Material3D, Mesh3D, Model3D, Quaternion, Vector3 } from '@pixi/3d';
import type { RigidBody } from 'crashcat';
import { rigidBody } from 'crashcat';
import { Texture } from 'pixi.js';

import type { ControlsState } from './Controls';
import type { PhysicsWorld } from './Physics';

/** Fun body paints — avoids near-black / pure white so chrome/tires still read. */
const PAINT_PALETTE = [
  0xffd24a, // yellow
  0xff4d4d, // red
  0x4da3ff, // blue
  0x5ce1a0, // mint
  0xff7a3d, // orange
  0xc77dff, // purple
  0xf0f0f0, // white
  0x3d4450, // slate
  0xff69b4, // pink
  0x2dd4a8, // teal
];

/**
 * Kenney colormap body swatches are yellow/amber. Detect those so we recolor only kaporta
 * texels and leave chrome / glass / tire greys untouched (same mesh, shared atlas).
 */
function isKenneyBodyPaint(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 35) return false;
  return r > 180 && g > 90 && b < 170 && r >= g && g > b && r - b > 50;
}

/** Typical Kenney yellow swatch luminance — used to preserve face shade strips when recoloring. */
const PAINT_REF_LUM = 0.299 * 255 + 0.587 * 200 + 0.114 * 80;

type BodyPaintAtlas = {
  texture: Texture;
  ctx: CanvasRenderingContext2D;
  original: ImageData;
  working: ImageData;
};

function createBodyPaintAtlas(source: Texture | null | undefined): BodyPaintAtlas | null {
  if (!source?.source) return null;

  const w = source.source.width;
  const h = source.source.height;
  if (!w || !h) return null;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const resource = source.source.resource as CanvasImageSource | undefined;
  if (!resource) return null;

  try {
    ctx.drawImage(resource, 0, 0, w, h);
  } catch {
    return null;
  }

  const original = ctx.getImageData(0, 0, w, h);
  const working = ctx.createImageData(w, h);
  working.data.set(original.data);
  return { texture: Texture.from(canvas), ctx, original, working };
}

function bakePaintColor(atlas: BodyPaintAtlas, color: number): void {
  const pr = (color >> 16) & 0xff;
  const pg = (color >> 8) & 0xff;
  const pb = color & 0xff;
  const src = atlas.original.data;
  const dst = atlas.working.data;

  for (let i = 0; i < src.length; i += 4) {
    const r = src[i]!;
    const g = src[i + 1]!;
    const b = src[i + 2]!;
    const a = src[i + 3]!;
    if (!isKenneyBodyPaint(r, g, b)) {
      dst[i] = r;
      dst[i + 1] = g;
      dst[i + 2] = b;
      dst[i + 3] = a;
      continue;
    }
    const shade = (0.299 * r + 0.587 * g + 0.114 * b) / PAINT_REF_LUM;
    dst[i] = Math.min(255, Math.round(pr * shade));
    dst[i + 1] = Math.min(255, Math.round(pg * shade));
    dst[i + 2] = Math.min(255, Math.round(pb * shade));
    dst[i + 3] = a;
  }

  atlas.ctx.putImageData(atlas.working, 0, 0);
  atlas.texture.source.update();
}

const LINEAR_DAMP = 0.1;
export const MAX_SPEED = 1.5;

const DEFAULT_SPAWN: [number, number, number] = [0, 0.5, 4];
/** How far below the physics sphere center the model sits. Smaller = higher truck (tires clear asphalt). */
const MODEL_Y_BELOW_SPHERE = 0.34;

const _forward = new Vector3();
const _up = new Vector3(0, 1, 0);
const _xAxis = new Vector3(1, 0, 0);
const _zAxis = new Vector3(0, 0, 1);
const _q = new Quaternion();
const _qSteer = new Quaternion();
const _qSpin = new Quaternion();
const _qPitch = new Quaternion();
const _qRoll = new Quaternion();
const _qBodyTmp = new Quaternion();

function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;

  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;

  return a + diff * t;
}

function findNamedNode(root: Container3D, name: string): Container3D | null {
  if (root.label?.toLowerCase() === name) return root;

  for (const child of root.children) {
    const found = findNamedNode(child, name);

    if (found) return found;
  }

  return null;
}

function findNodeContaining(root: Container3D, ...needles: string[]): Container3D | null {
  const lower = root.label?.toLowerCase() ?? '';

  if (needles.every((n) => lower.includes(n))) return root;

  for (const child of root.children) {
    const found = findNodeContaining(child, ...needles);

    if (found) return found;
  }

  return null;
}

export class Vehicle {
  public readonly container: Container3D;

  public bodyNode: Container3D | null = null;
  public wheels: Container3D[] = [];
  public wheelFL: Container3D | null = null;
  public wheelFR: Container3D | null = null;
  public wheelBL: Container3D | null = null;
  public wheelBR: Container3D | null = null;

  private readonly _wheelSpinAngle: number[] = [0, 0, 0, 0];
  private readonly _wheelSteerAngle = { fl: 0, fr: 0 };
  private _bodyPitch = 0;
  private _bodyRoll = 0;
  private readonly _bodyInitQuat = new Quaternion();

  public linearSpeed = 0;
  public angularSpeed = 0;
  public acceleration = 0;
  public yaw = 0;

  public readonly spherePos = new Vector3();
  public readonly sphereVel = new Vector3();
  public readonly modelVelocity = new Vector3();
  private readonly _prevModelPos = new Vector3();
  private _spawn: [number, number, number];

  public inputX = 0;
  public inputZ = 0;
  public handbrake = false;
  public driftIntensity = 0;
  public paintColor = PAINT_PALETTE[0]!;

  public readonly physics: PhysicsWorld;
  public readonly body: RigidBody;
  private _paintAtlas: BodyPaintAtlas | null = null;

  constructor(
    source: Scene3DSource,
    physics: PhysicsWorld,
    body: RigidBody,
    spawn: [number, number, number] = DEFAULT_SPAWN,
    yaw = 0,
  ) {
    this.physics = physics;
    this.body = body;
    this._spawn = [spawn[0], spawn[1], spawn[2]];
    this.yaw = yaw;

    this.container = new Container3D();

    const root = new Model3D(source);

    root.scale.set(0.5, 0.5, 0.5);
    this.container.addChild(root);

    this.bodyNode = findNamedNode(root, 'body');

    if (this.bodyNode) this.bodyNode.quaternion.copyTo(this._bodyInitQuat);
    // Body shares the atlas material with wheels — clone + whiten paint swatches so R only
    // recolors kaporta (windows / bumpers / tires stay on the original colormap).
    this._setupBodyPaint(this.bodyNode ?? root);

    const wheelFL = findNodeContaining(root, 'wheel', 'front', 'left');
    const wheelFR = findNodeContaining(root, 'wheel', 'front', 'right');
    const wheelBL = findNodeContaining(root, 'wheel', 'back', 'left');
    const wheelBR = findNodeContaining(root, 'wheel', 'back', 'right');

    this.wheelFL = wheelFL;
    this.wheelFR = wheelFR;
    this.wheelBL = wheelBL;
    this.wheelBR = wheelBR;

    if (wheelFL) this.wheels.push(wheelFL);
    if (wheelFR) this.wheels.push(wheelFR);
    if (wheelBL) this.wheels.push(wheelBL);
    if (wheelBR) this.wheels.push(wheelBR);

    this.spherePos.set(spawn[0], spawn[1], spawn[2]);
    this.container.position.set(spawn[0], spawn[1] - MODEL_Y_BELOW_SPHERE, spawn[2]);
    this._prevModelPos.set(spawn[0], spawn[1] - MODEL_Y_BELOW_SPHERE, spawn[2]);
  }

  /** Teleport to a grid / pit slot and clear motion. */
  public resetTo(spawn: [number, number, number], yaw: number): void {
    this._spawn = [spawn[0], spawn[1], spawn[2]];
    this.yaw = yaw;
    this.linearSpeed = 0;
    this.angularSpeed = 0;
    this.acceleration = 0;
    this.inputX = 0;
    this.inputZ = 0;
    this.handbrake = false;
    this.driftIntensity = 0;
    this._bodyPitch = 0;
    this._bodyRoll = 0;

    rigidBody.setPosition(this.physics.world, this.body, spawn, false);
    rigidBody.setLinearVelocity(this.physics.world, this.body, [0, 0, 0]);
    rigidBody.setAngularVelocity(this.physics.world, this.body, [0, 0, 0]);

    this.spherePos.set(spawn[0], spawn[1], spawn[2]);
    this.sphereVel.set(0, 0, 0);
    this.container.position.set(spawn[0], spawn[1] - MODEL_Y_BELOW_SPHERE, spawn[2]);
    this._prevModelPos.set(spawn[0], spawn[1] - MODEL_Y_BELOW_SPHERE, spawn[2]);
    _q.setFromAxisAngle(_up, this.yaw);
    this.container.quaternion.copyFrom(_q);
  }

  /** Random body paint from the palette. Returns the chosen hex color. */
  public randomizePaint(): number {
    let next = PAINT_PALETTE[Math.floor(Math.random() * PAINT_PALETTE.length)]!;
    if (PAINT_PALETTE.length > 1) {
      while (next === this.paintColor) {
        next = PAINT_PALETTE[Math.floor(Math.random() * PAINT_PALETTE.length)]!;
      }
    }
    this.setPaint(next);
    return next;
  }

  public setPaint(color: number): void {
    this.paintColor = color;
    if (this._paintAtlas) bakePaintColor(this._paintAtlas, color);
  }

  private _setupBodyPaint(root: Container3D): void {
    const visit = (node: Container3D): void => {
      const label = node.label?.toLowerCase() ?? '';
      if (label.includes('wheel') || label.includes('tire') || label.includes('underside')) return;

      if (node instanceof Mesh3D && node.material instanceof Material3D && !this._paintAtlas) {
        const src = node.material;
        const atlas = createBodyPaintAtlas(src.textures.baseColor);
        if (atlas) {
          this._paintAtlas = atlas;
          bakePaintColor(atlas, this.paintColor);
          node.material = new Material3D({
            baseColorTexture: atlas.texture,
            baseColor: 0xffffff,
            metallic: src.metallic,
            roughness: src.roughness,
          });
        }
      }

      for (const child of node.children) visit(child);
    };
    visit(root);
  }

  public update(dt: number, input: ControlsState): void {
    this.inputX = input.x;
    this.inputZ = input.z;
    this.handbrake = input.handbrake;

    if (input.touchActive && (this.inputX !== 0 || this.inputZ !== 0)) {
      const targetAngle = Math.atan2(this.inputX, this.inputZ);
      const slerpT = 1 - Math.exp(-3 * dt);

      this.yaw = lerpAngle(this.yaw, targetAngle, slerpT);

      _forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const cross = _forward.x * this.inputZ - _forward.z * this.inputX;

      this.inputX = clamp(-cross * 2, -1, 1);
      this.linearSpeed = lerp(this.linearSpeed, MAX_SPEED, dt * 1.5);
    } else {
      let direction = Math.sign(this.linearSpeed);

      if (direction === 0) direction = Math.abs(this.inputZ) > 0.1 ? Math.sign(this.inputZ) : 1;

      const steeringGrip = clamp(Math.abs(this.linearSpeed), 0.2, 1.0);
      // Handbrake unlocks the rear → snappier yaw / oversteer.
      const steerMul = this.handbrake ? 2.1 : 1;
      const steerLerp = this.handbrake ? 7 : 4;
      const targetAngular = -this.inputX * steeringGrip * 4 * direction * steerMul;

      this.angularSpeed = lerp(this.angularSpeed, targetAngular, dt * steerLerp);
      this.yaw += this.angularSpeed * dt;

      const targetSpeed = this.inputZ;

      if (this.handbrake) {
        // Lock rears: scrub speed hard, keep a bit of throttle so you can hold a slide.
        this.linearSpeed = lerp(this.linearSpeed, 0, dt * 3.2);
        if (targetSpeed > 0) {
          this.linearSpeed = lerp(this.linearSpeed, targetSpeed * MAX_SPEED * 0.5, dt * 0.9);
        } else if (targetSpeed < 0) {
          this.linearSpeed = lerp(this.linearSpeed, targetSpeed * 0.35, dt * 2.5);
        }
      } else if (targetSpeed < 0 && this.linearSpeed > 0.01) {
        this.linearSpeed = lerp(this.linearSpeed, 0, dt * 8);
      } else if (targetSpeed < 0) {
        this.linearSpeed = lerp(this.linearSpeed, targetSpeed / 2, dt * 2);
      } else {
        this.linearSpeed = lerp(this.linearSpeed, targetSpeed * MAX_SPEED, dt * 1.5);
      }
    }

    this.linearSpeed *= Math.max(0, 1 - LINEAR_DAMP * dt);

    // Drive: apply angular velocity to the rolling sphere along the right vector,
    // mirroring the original three.js port. _right is world-X rotated by yaw.
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);
    const drive = this.linearSpeed * 100 * dt;
    const body = this.body;
    const angvel = body.motionProperties.angularVelocity;

    rigidBody.setAngularVelocity(this.physics.world, body, [
      angvel[0] + rightX * drive,
      angvel[1],
      angvel[2] + rightZ * drive,
    ]);

    this.spherePos.set(body.position[0], body.position[1], body.position[2]);

    const linvel = body.motionProperties.linearVelocity;

    this.sphereVel.set(linvel[0], linvel[1], linvel[2]);

    this.acceleration = lerp(
      this.acceleration,
      this.linearSpeed + 0.25 * this.linearSpeed * Math.abs(this.linearSpeed),
      dt,
    );

    if (this.spherePos.y < -10) {
      this.resetTo(this._spawn, this.yaw);
    }

    this.container.position.set(this.spherePos.x, this.spherePos.y - MODEL_Y_BELOW_SPHERE, this.spherePos.z);

    _q.setFromAxisAngle(_up, this.yaw);
    this.container.quaternion.copyFrom(_q);

    if (dt > 0) {
      this.modelVelocity.set(
        (this.container.position.x - this._prevModelPos.x) / dt,
        (this.container.position.y - this._prevModelPos.y) / dt,
        (this.container.position.z - this._prevModelPos.z) / dt,
      );
      this._prevModelPos.set(this.container.position.x, this.container.position.y, this.container.position.z);
    }

    this._updateBody(dt);
    this._updateWheels(dt);

    let drift = Math.abs(this.linearSpeed - this.acceleration) + Math.abs(this._bodyRoll) * 2;
    if (this.handbrake && Math.abs(this.linearSpeed) > 0.12) {
      drift += 1.15 + Math.abs(this.inputX) * 1.4 + Math.abs(this.angularSpeed) * 0.12;
    }
    this.driftIntensity = drift;
  }

  private _updateBody(dt: number): void {
    if (!this.bodyNode) return;

    this._bodyPitch = lerpAngle(this._bodyPitch, -(this.linearSpeed - this.acceleration) / 6, dt * 10);
    const rollMul = this.handbrake ? 1.7 : 1;
    this._bodyRoll = lerpAngle(
      this._bodyRoll,
      -(this.inputX / 5) * this.linearSpeed * rollMul,
      dt * (this.handbrake ? 8 : 5),
    );

    _qPitch.setFromAxisAngle(_xAxis, this._bodyPitch);
    _qRoll.setFromAxisAngle(_zAxis, this._bodyRoll);
    _qBodyTmp.copyFrom(this._bodyInitQuat).multiply(_qPitch).multiply(_qRoll);
    this.bodyNode.quaternion.copyFrom(_qBodyTmp);

    this.bodyNode.position.y = lerp(this.bodyNode.position.y, 0.3, dt * 5);
  }

  private _updateWheels(dt: number): void {
    // Fronts keep rolling; rears scrub when handbrake locks them.
    const frontSpin = this.acceleration;
    const rearSpin = this.handbrake ? this.acceleration * 0.15 : this.acceleration;
    this._wheelSpinAngle[0]! += frontSpin;
    this._wheelSpinAngle[1]! += frontSpin;
    this._wheelSpinAngle[2]! += rearSpin;
    this._wheelSpinAngle[3]! += rearSpin;

    const targetSteer = -this.inputX / (this.handbrake ? 1.15 : 1.5);

    if (this.wheelFL) {
      this._wheelSteerAngle.fl = lerpAngle(this._wheelSteerAngle.fl, targetSteer, dt * 10);
      this._applyWheelTransform(this.wheelFL, this._wheelSpinAngle[0], this._wheelSteerAngle.fl);
    }
    if (this.wheelFR) {
      this._wheelSteerAngle.fr = lerpAngle(this._wheelSteerAngle.fr, targetSteer, dt * 10);
      this._applyWheelTransform(this.wheelFR, this._wheelSpinAngle[1], this._wheelSteerAngle.fr);
    }
    if (this.wheelBL) {
      this._applyWheelTransform(this.wheelBL, this._wheelSpinAngle[2], 0);
    }
    if (this.wheelBR) {
      this._applyWheelTransform(this.wheelBR, this._wheelSpinAngle[3], 0);
    }
  }

  private _applyWheelTransform(wheel: Container3D, spin: number, steer: number): void {
    _qSteer.setFromAxisAngle(_up, steer);
    _qSpin.setFromAxisAngle(_xAxis, spin);
    _qSteer.multiply(_qSpin);
    wheel.quaternion.copyFrom(_qSteer);
  }
}
