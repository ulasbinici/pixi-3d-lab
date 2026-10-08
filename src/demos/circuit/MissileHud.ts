import type { View3D } from '@pixi/3d';
import { Container, Graphics, Text } from 'pixi.js';

import type { CameraMode } from './Camera';
import type { LockSnapshot } from './Missiles';
import type { Vehicle } from './Vehicle';

const _scr = { x: 0, y: 0 };

/**
 * Lock UI: screen-space boxes on the car you're locking (FPV + chase/top).
 * FPV also keeps a soft center reticle while acquiring.
 */
export class MissileHud {
  public readonly root = new Container();

  private readonly _world = new Graphics();
  private readonly _fpv = new Graphics();
  private readonly _label = new Text({
    text: '',
    style: {
      fontFamily: 'IBM Plex Mono, monospace',
      fontSize: 14,
      fill: 0xff6a3d,
      fontWeight: '600',
    },
  });
  private _t = 0;

  constructor() {
    this.root.addChild(this._world, this._fpv, this._label);
    this._label.anchor.set(0.5, 0.5);
    this._label.visible = false;
  }

  public update(
    dt: number,
    view3d: View3D,
    mode: CameraMode,
    lock: LockSnapshot,
    screenW: number,
    screenH: number,
  ): void {
    this._t += dt;
    this._world.clear();
    this._fpv.clear();

    const blink = 0.5 + 0.5 * Math.sin(this._t * (lock.locked ? 10 : 14));
    const acquiring = lock.progress > 0.02 && !lock.locked;
    const showBlink = lock.locked ? true : blink > 0.35;

    // Always mark the car in view — FPV and 3rd share the same target boxes.
    this._drawWorldBoxes(view3d, lock, acquiring, showBlink, mode === 'fpv');
    if (mode === 'fpv') {
      this._drawFpvReticle(screenW, screenH, lock, acquiring, showBlink);
    }

    if (lock.progress > 0.05 && lock.target) {
      this._label.visible = true;
      // Anchor label near the locked car on screen when possible.
      const p = view3d.worldToScreen(
        {
          x: lock.target.spherePos.x,
          y: lock.target.spherePos.y + 1.35,
          z: lock.target.spherePos.z,
        },
        _scr,
      );
      if (p) {
        this._label.position.set(p.x, p.y - 18);
      } else {
        this._label.position.set(screenW * 0.5, mode === 'fpv' ? screenH * 0.42 : 36);
      }
      if (lock.locked) {
        this._label.text = 'TARGET LOCK';
        this._label.style.fill = 0xff3b4a;
        this._label.alpha = 0.75 + 0.25 * blink;
      } else {
        this._label.text = `LOCK ${Math.round(lock.progress * 100)}%`;
        this._label.style.fill = 0xffb000;
        this._label.alpha = 0.55 + 0.45 * blink;
      }
    } else {
      this._label.visible = false;
    }
  }

  private _drawFpvReticle(
    screenW: number,
    screenH: number,
    lock: LockSnapshot,
    acquiring: boolean,
    showBlink: boolean,
  ): void {
    if (lock.progress < 0.02) return;
    if (acquiring && !showBlink) return;

    const cx = screenW * 0.5;
    const cy = screenH * 0.48;
    const ready = lock.locked;
    const color = ready ? 0xff3b4a : 0xffb000;
    const alpha = ready ? 0.55 : 0.28 + 0.22 * (0.5 + 0.5 * Math.sin(this._t * 14));
    const span = 28 - lock.progress * 8;
    const arm = 10;

    this._fpv.setStrokeStyle({ width: 1.5, color, alpha });
    this._corner(this._fpv, cx - span, cy - span, arm, 1, 1);
    this._corner(this._fpv, cx + span, cy - span, arm, -1, 1);
    this._corner(this._fpv, cx - span, cy + span, arm, 1, -1);
    this._corner(this._fpv, cx + span, cy + span, arm, -1, -1);
  }

  private _drawWorldBoxes(
    view3d: View3D,
    lock: LockSnapshot,
    acquiring: boolean,
    showBlink: boolean,
    fpv: boolean,
  ): void {
    const drawn = new Set<Vehicle>();
    for (const t of lock.candidates) {
      drawn.add(t);
      const isFocus = t === lock.target;
      if (isFocus && acquiring && !showBlink) continue;
      this._boxAround(view3d, t, isFocus, lock.locked && isFocus, lock.progress, fpv);
    }
    if (lock.target && !drawn.has(lock.target)) {
      if (!(acquiring && !showBlink)) {
        this._boxAround(view3d, lock.target, true, lock.locked, lock.progress, fpv);
      }
    }
  }

  private _boxAround(
    view3d: View3D,
    target: Vehicle,
    focus: boolean,
    locked: boolean,
    progress: number,
    fpv: boolean,
  ): void {
    const p = view3d.worldToScreen(
      { x: target.spherePos.x, y: target.spherePos.y + 0.55, z: target.spherePos.z },
      _scr,
    );
    if (!p) return;

    // FPV: slightly larger brackets so the marked car reads through the windshield.
    const scale = fpv ? 1.15 : 1;
    const half = (locked ? 28 : focus ? 22 + progress * 8 : 18) * scale;
    const color = locked ? 0xff3b4a : focus ? 0xffb000 : 0x7dffb3;
    const alpha = locked ? 0.95 : focus ? 0.8 : 0.4;
    const arm = (locked ? 12 : focus ? 10 : 8) * scale;

    this._world.setStrokeStyle({ width: locked ? 2.6 : focus ? 2 : 1.5, color, alpha });
    this._corner(this._world, p.x - half, p.y - half, arm, 1, 1);
    this._corner(this._world, p.x + half, p.y - half, arm, -1, 1);
    this._corner(this._world, p.x - half, p.y + half, arm, 1, -1);
    this._corner(this._world, p.x + half, p.y + half, arm, -1, -1);

    if (locked || focus) {
      this._world.setStrokeStyle({ width: 1.2, color, alpha: locked ? 0.85 : 0.55 });
      this._world.moveTo(p.x - 6, p.y);
      this._world.lineTo(p.x + 6, p.y);
      this._world.moveTo(p.x, p.y - 6);
      this._world.lineTo(p.x, p.y + 6);
      this._world.stroke();
    }
  }

  private _corner(g: Graphics, x: number, y: number, arm: number, sx: number, sy: number): void {
    g.moveTo(x, y + sy * arm);
    g.lineTo(x, y);
    g.lineTo(x + sx * arm, y);
    g.stroke();
  }
}
