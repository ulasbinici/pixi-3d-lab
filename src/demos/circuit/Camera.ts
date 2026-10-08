import type { Camera3D, PointData3D } from '@pixi/3d';
import { Vector3 } from '@pixi/3d';

const _lookPoint = new Vector3();
const _fpvPos = new Vector3();
const _fpvLook = new Vector3();
const _camPos = new Vector3();

export type CameraMode = 'chase' | 'fpv' | 'top';

const MODE_ORDER: CameraMode[] = ['chase', 'fpv', 'top'];

/**
 * Chase / top orbit mapping (Mac trackpad friendly):
 * - 1-finger / LMB drag → yaw (L/R) + pitch (U/D)
 * - 2-finger scroll / pinch → zoom
 * - 2-finger horizontal scroll → yaw
 * - RMB / secondary-click drag → pitch only
 *
 * FPV ignores these — driving look stays with the car.
 */
export class DriveCamera {
  public readonly camera: Camera3D;
  public mode: CameraMode = 'chase';

  public mapCenter = new Vector3(0, 0, 0);
  public mapHeight = 55;

  /** Orbit yaw around the car (radians). */
  public orbitYaw = Math.PI / 4;
  /** Elevation: 0 = horizon, ~PI/2 = straight down. */
  public orbitPitch = 0.55;
  public distance = 12;

  private readonly _canvas: HTMLElement;
  private _dragging = false;
  private _dragButton = 0;
  private _lastX = 0;
  private _lastY = 0;
  private _baseMapHeight = 55;

  constructor(camera: Camera3D, canvas: HTMLElement) {
    this.camera = camera;
    this._canvas = canvas;
    this.camera.near = 0.1;
    this.camera.far = 280;
    this.applyMode('chase');

    canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this._onContextMenu);
  }

  public destroy(): void {
    this._canvas.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    this._canvas.removeEventListener('wheel', this._onWheel);
    this._canvas.removeEventListener('contextmenu', this._onContextMenu);
  }

  public setMapBounds(centerX: number, centerZ: number, span: number): void {
    this.mapCenter.set(centerX, 0, centerZ);
    this._baseMapHeight = Math.max(42, span * 0.95);
    this.mapHeight = this._baseMapHeight;
  }

  public applyMode(mode: CameraMode): void {
    this.mode = mode;
    if (mode === 'fpv') {
      this.camera.fov = 72;
    } else if (mode === 'top') {
      this.camera.fov = 48;
      this.orbitPitch = 1.35; // nearly overhead
      this.distance = this.mapHeight;
    } else {
      this.camera.fov = 42;
      this.orbitPitch = 0.55;
      this.distance = 12;
      this.orbitYaw = Math.PI / 4;
    }
  }

  public toggle(): CameraMode {
    const i = MODE_ORDER.indexOf(this.mode);
    const next = MODE_ORDER[(i + 1) % MODE_ORDER.length]!;
    this.applyMode(next);
    return this.mode;
  }

  public update(_dt: number, target: PointData3D, _velocity: PointData3D, yaw: number): void {
    if (this.mode === 'fpv') {
      this._updateFpv(target, yaw);
      return;
    }
    if (this.mode === 'top') {
      this._updateTop(target);
      return;
    }
    this._updateChase(target);
  }

  private get _orbitEnabled(): boolean {
    return this.mode === 'chase' || this.mode === 'top';
  }

  private readonly _onPointerDown = (e: PointerEvent): void => {
    if (!this._orbitEnabled) return;
    // Primary = 1-finger / LMB; secondary = right-click / 2-finger click on some Mac setups
    if (e.button !== 0 && e.button !== 2) return;
    this._dragging = true;
    this._dragButton = e.button;
    this._lastX = e.clientX;
    this._lastY = e.clientY;
    this._canvas.setPointerCapture?.(e.pointerId);
  };

  private readonly _onPointerMove = (e: PointerEvent): void => {
    if (!this._dragging || !this._orbitEnabled) return;
    const dx = e.clientX - this._lastX;
    const dy = e.clientY - this._lastY;
    this._lastX = e.clientX;
    this._lastY = e.clientY;

    if (this._dragButton === 2) {
      // Right-drag: pitch only
      this._addPitch(-dy * 0.005);
    } else {
      // 1-finger / LMB: yaw + pitch
      this.orbitYaw -= dx * 0.005;
      this._addPitch(-dy * 0.004);
    }
  };

  private readonly _onPointerUp = (e: PointerEvent): void => {
    if (!this._dragging) return;
    this._dragging = false;
    try {
      this._canvas.releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
  };

  private readonly _onWheel = (e: WheelEvent): void => {
    if (!this._orbitEnabled) return;
    e.preventDefault();

    // Pinch-zoom on Chrome/Safari often arrives as ctrlKey + wheel.
    const zooming = e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX);
    if (zooming) {
      const factor = Math.exp(e.deltaY * 0.0018);
      this._addZoom(factor);
    }
    // Two-finger horizontal swipe → orbit
    if (Math.abs(e.deltaX) > 0.5) {
      this.orbitYaw -= e.deltaX * 0.003;
    }
  };

  private readonly _onContextMenu = (e: Event): void => {
    if (this._orbitEnabled) e.preventDefault();
  };

  private _addPitch(delta: number): void {
    if (this.mode === 'top') {
      this.orbitPitch = clamp(this.orbitPitch + delta, 0.95, 1.45);
    } else {
      this.orbitPitch = clamp(this.orbitPitch + delta, 0.18, 1.25);
    }
  }

  private _addZoom(factor: number): void {
    if (this.mode === 'top') {
      this.distance = clamp(this.distance * factor, 28, this._baseMapHeight * 1.8);
      this.mapHeight = this.distance;
    } else {
      this.distance = clamp(this.distance * factor, 5, 28);
    }
  }

  private _updateChase(target: PointData3D): void {
    const cp = Math.cos(this.orbitPitch);
    const sp = Math.sin(this.orbitPitch);
    const cy = Math.cos(this.orbitYaw);
    const sy = Math.sin(this.orbitYaw);

    _camPos.set(
      target.x + this.distance * cp * sy,
      target.y + this.distance * sp,
      target.z + this.distance * cp * cy,
    );
    this.camera.position.copyFrom(_camPos);
    this.camera.lookAt({ x: target.x, y: target.y + 0.6, z: target.z });
  }

  private _updateTop(target: PointData3D): void {
    const focusX = this.mapCenter.x * 0.55 + target.x * 0.45;
    const focusZ = this.mapCenter.z * 0.55 + target.z * 0.45;
    const cp = Math.cos(this.orbitPitch);
    const sp = Math.sin(this.orbitPitch);
    const cy = Math.cos(this.orbitYaw);
    const sy = Math.sin(this.orbitYaw);

    _camPos.set(
      focusX + this.distance * cp * sy,
      this.distance * sp,
      focusZ + this.distance * cp * cy,
    );
    // Keep a tiny XY offset so lookAt never goes singular when nearly overhead.
    if (Math.abs(cp) < 0.02) {
      _camPos.z += 0.02;
    }
    this.camera.position.copyFrom(_camPos);
    this.camera.lookAt({ x: focusX, y: 0, z: focusZ });
  }

  private _updateFpv(target: PointData3D, yaw: number): void {
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);

    _fpvPos.set(target.x + forwardX * 0.35, target.y + 1.15, target.z + forwardZ * 0.35);
    _fpvLook.set(target.x + forwardX * 8, target.y + 0.85, target.z + forwardZ * 8);

    this.camera.position.copyFrom(_fpvPos);
    this.camera.lookAt(_fpvLook);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
