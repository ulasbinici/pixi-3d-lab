import type { Scene3DSource } from '@pixi/3d';
import { clamp, Container3D, lerp, Model3D, Quaternion, Vector3 } from '@pixi/3d';
import { rigidBody } from 'crashcat';

import type { ControlsState } from './Controls';
import type { PhysicsWorld } from './Physics';

const LINEAR_DAMP = 0.1;
export const MAX_SPEED = 1.5;

const SPAWN: [number, number, number] = [0, 0.5, 4];
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

  public readonly spherePos = new Vector3(SPAWN[0], SPAWN[1], SPAWN[2]);
  public readonly sphereVel = new Vector3();
  public readonly modelVelocity = new Vector3();
  private readonly _prevModelPos = new Vector3();

  public inputX = 0;
  public inputZ = 0;
  public driftIntensity = 0;

  public readonly physics: PhysicsWorld;

  constructor(source: Scene3DSource, physics: PhysicsWorld) {
    this.physics = physics;

    this.container = new Container3D();

    const root = new Model3D(source);

    root.scale.set(0.5, 0.5, 0.5);
    this.container.addChild(root);

    this.bodyNode = findNamedNode(root, 'body');

    if (this.bodyNode) this.bodyNode.quaternion.copyTo(this._bodyInitQuat);

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

    this.container.position.set(SPAWN[0], SPAWN[1] - MODEL_Y_BELOW_SPHERE, SPAWN[2]);
    this._prevModelPos.set(SPAWN[0], SPAWN[1] - MODEL_Y_BELOW_SPHERE, SPAWN[2]);
  }

  public update(dt: number, input: ControlsState): void {
    this.inputX = input.x;
    this.inputZ = input.z;

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
      const targetAngular = -this.inputX * steeringGrip * 4 * direction;

      this.angularSpeed = lerp(this.angularSpeed, targetAngular, dt * 4);
      this.yaw += this.angularSpeed * dt;

      const targetSpeed = this.inputZ;

      if (targetSpeed < 0 && this.linearSpeed > 0.01) {
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
    const body = this.physics.sphereBody;
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
      rigidBody.setPosition(this.physics.world, body, SPAWN, false);
      rigidBody.setLinearVelocity(this.physics.world, body, [0, 0, 0]);
      rigidBody.setAngularVelocity(this.physics.world, body, [0, 0, 0]);
      this.spherePos.set(SPAWN[0], SPAWN[1], SPAWN[2]);
      this.sphereVel.set(0, 0, 0);
      this.linearSpeed = 0;
      this.angularSpeed = 0;
      this.acceleration = 0;
      this.yaw = 0;
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

    this.driftIntensity = Math.abs(this.linearSpeed - this.acceleration) + Math.abs(this._bodyRoll) * 2;
  }

  private _updateBody(dt: number): void {
    if (!this.bodyNode) return;

    this._bodyPitch = lerpAngle(this._bodyPitch, -(this.linearSpeed - this.acceleration) / 6, dt * 10);
    this._bodyRoll = lerpAngle(this._bodyRoll, -(this.inputX / 5) * this.linearSpeed, dt * 5);

    _qPitch.setFromAxisAngle(_xAxis, this._bodyPitch);
    _qRoll.setFromAxisAngle(_zAxis, this._bodyRoll);
    _qBodyTmp.copyFrom(this._bodyInitQuat).multiply(_qPitch).multiply(_qRoll);
    this.bodyNode.quaternion.copyFrom(_qBodyTmp);

    this.bodyNode.position.y = lerp(this.bodyNode.position.y, 0.3, dt * 5);
  }

  private _updateWheels(dt: number): void {
    for (let i = 0; i < this.wheels.length; i++) {
      this._wheelSpinAngle[i] += this.acceleration;
    }

    const targetSteer = -this.inputX / 1.5;

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
