import type { Camera3D, PointData3D } from '@pixi/3d';
import { Vector3 } from '@pixi/3d';

const _desired = new Vector3();
const _delta = new Vector3();
const _lookPoint = new Vector3();
const _fpvPos = new Vector3();
const _fpvLook = new Vector3();

export type CameraMode = 'chase' | 'fpv';

export class DriveCamera {
  public readonly camera: Camera3D;
  public mode: CameraMode = 'chase';

  public readonly offset = new Vector3(7.2, 5.8, 7.2);
  public readonly camRightXZ = new Vector3();
  public readonly camForwardXZ = new Vector3();
  public readonly leadFactor = 2.4;
  public readonly cameraSmoothing = 2.4;
  public readonly deadzoneRadius = 4.0;
  public readonly screenShiftUp = 0.8;

  private readonly _smoothedDesired = new Vector3();
  private _initialized = false;

  constructor(camera: Camera3D) {
    this.camera = camera;
    this.camera.near = 0.1;
    this.camera.far = 220;
    this.applyMode('chase');

    this.camera.position.copyFrom(this.offset);
    this.camRightXZ.set(this.offset.z, 0, -this.offset.x).normalize();
    this.camForwardXZ.set(-this.offset.x, 0, -this.offset.z).normalize();
  }

  public applyMode(mode: CameraMode): void {
    this.mode = mode;
    this.camera.fov = mode === 'fpv' ? 72 : 42;
  }

  public toggle(): CameraMode {
    this.applyMode(this.mode === 'chase' ? 'fpv' : 'chase');
    return this.mode;
  }

  public update(
    dt: number,
    target: PointData3D,
    velocity: PointData3D,
    yaw: number,
  ): void {
    if (this.mode === 'fpv') {
      this._updateFpv(target, yaw);
      return;
    }

    this._updateChase(dt, target, velocity);
  }

  private _updateFpv(target: PointData3D, yaw: number): void {
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);

    _fpvPos.set(target.x + forwardX * 0.35, target.y + 1.15, target.z + forwardZ * 0.35);
    _fpvLook.set(target.x + forwardX * 8, target.y + 0.85, target.z + forwardZ * 8);

    this.camera.position.copyFrom(_fpvPos);
    this.camera.lookAt(_fpvLook);
  }

  private _updateChase(dt: number, target: PointData3D, velocity: PointData3D): void {
    const radius = this.deadzoneRadius;
    const radiusSq = radius * radius;

    let leadX =
      (velocity.x * this.camRightXZ.x + velocity.y * this.camRightXZ.y + velocity.z * this.camRightXZ.z) *
      this.leadFactor;
    let leadY =
      (velocity.x * this.camForwardXZ.x + velocity.y * this.camForwardXZ.y + velocity.z * this.camForwardXZ.z) *
      this.leadFactor;

    const leadLenSq = leadX * leadX + leadY * leadY;
    if (leadLenSq > radiusSq) {
      const k = radius / Math.sqrt(leadLenSq);
      leadX *= k;
      leadY *= k;
    }

    _desired.copyFrom(target).addScaledVector(this.camRightXZ, leadX).addScaledVector(this.camForwardXZ, leadY);

    const alpha = this._initialized ? 1 - Math.exp(-dt * this.cameraSmoothing) : 1;
    const inv = 1 - alpha;

    this._smoothedDesired.x = this._smoothedDesired.x * inv + _desired.x * alpha;
    this._smoothedDesired.y = this._smoothedDesired.y * inv + _desired.y * alpha;
    this._smoothedDesired.z = this._smoothedDesired.z * inv + _desired.z * alpha;
    this._initialized = true;

    _delta.set(
      target.x - this._smoothedDesired.x,
      target.y - this._smoothedDesired.y,
      target.z - this._smoothedDesired.z,
    );

    const offsetX = _delta.x * this.camRightXZ.x + _delta.y * this.camRightXZ.y + _delta.z * this.camRightXZ.z;
    const offsetY = _delta.x * this.camForwardXZ.x + _delta.y * this.camForwardXZ.y + _delta.z * this.camForwardXZ.z;
    const offsetLenSq = offsetX * offsetX + offsetY * offsetY;

    if (offsetLenSq > radiusSq) {
      const offsetLen = Math.sqrt(offsetLenSq);
      const k = (offsetLen - radius) / offsetLen;
      this._smoothedDesired.addScaledVector(this.camRightXZ, offsetX * k);
      this._smoothedDesired.addScaledVector(this.camForwardXZ, offsetY * k);
    }

    _lookPoint.copyFrom(this._smoothedDesired).addScaledVector(this.camForwardXZ, -this.screenShiftUp);
    this.camera.position.set(_lookPoint.x + this.offset.x, _lookPoint.y + this.offset.y, _lookPoint.z + this.offset.z);
    this.camera.lookAt(_lookPoint);
  }
}
