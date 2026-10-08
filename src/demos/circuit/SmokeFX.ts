import type { Container3D } from '@pixi/3d';
import { Vector3 } from '@pixi/3d';
import { ConeShape, ParticleSystem3D } from '@pixi/3d/extras';
import type { Texture, Ticker } from 'pixi.js';

import type { Vehicle } from './Vehicle';
import { MAX_SPEED } from './Vehicle';

const BASE_SIZE = Math.tan((42 * Math.PI) / 180 / 2);

const DRIFT_THRESHOLD = 0.55;
const PER_WHEEL = 3;
const Y_OFFSET = 0.05;

const _pos = new Vector3();

/**
 * Tire drift smoke (world-space puffs) + exhaust plume from the rear bumper.
 */
export class SmokeFX {
  private readonly _tires: ParticleSystem3D;
  private readonly _exhaust: ParticleSystem3D;

  constructor(parent: Container3D, vehicle: Vehicle, smokeTexture: Texture) {
    this._tires = new ParticleSystem3D({
      texture: smokeTexture,
      capacity: 900,
      autoUpdate: false,
      emitRate: 0,
      shape: new ConeShape({ angle: 28, radius: 0.1 }),
      life: 2.2,
      speed: [0.4, 0.9],
      size: [BASE_SIZE * 0.22, BASE_SIZE * 0.45],
      sizeEnd: [BASE_SIZE * 1.4, BASE_SIZE * 2.6],
      alpha: 0.28,
      alphaEnd: 0,
      color: 0xc4c8d0,
      colorEnd: 0x6a6e78,
      drag: 1.1,
      spin: [-0.4, 0.4],
    });
    parent.addChild(this._tires);

    this._exhaust = new ParticleSystem3D({
      texture: smokeTexture,
      capacity: 280,
      autoUpdate: false,
      emitRate: 0,
      shape: new ConeShape({ angle: 18, radius: 0.04 }),
      life: [0.35, 0.85],
      speed: [1.1, 1.8],
      size: [BASE_SIZE * 0.12, BASE_SIZE * 0.22],
      sizeEnd: [BASE_SIZE * 0.55, BASE_SIZE * 1.1],
      alpha: 0.35,
      alphaEnd: 0,
      color: 0x5a5a5a,
      colorEnd: 0x2a2a2a,
      drag: 0.7,
    });
    // Sit on the truck; cone points +Y by default → tip it to shoot out the back (-Z).
    this._exhaust.position.set(0, 0.35, -1.05);
    this._exhaust.rotation.x = Math.PI / 2;
    vehicle.container.addChild(this._exhaust);
  }

  public update(ticker: Ticker, vehicle: Vehicle, throttle: number): void {
    if (vehicle.driftIntensity > DRIFT_THRESHOLD) {
      const groundY = vehicle.container.position.y + Y_OFFSET;
      for (const wheel of [vehicle.wheelBL, vehicle.wheelBR]) {
        if (!wheel) continue;
        wheel.worldTransform.extractPosition(_pos);
        _pos.y = groundY;
        this._tires.spawn(PER_WHEEL, { position: _pos });
      }
    }

    const speedNorm = Math.abs(vehicle.linearSpeed) / MAX_SPEED;
    const load = Math.max(0, throttle);
    // Idle puff + more when on the gas / under load.
    this._exhaust.emitRate = 4 + speedNorm * 18 + load * 28;

    this._tires.update(ticker);
    this._exhaust.update(ticker);
  }
}
