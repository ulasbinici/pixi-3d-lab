import type { Listener, RigidBody, World } from 'crashcat';
import {
  addBroadphaseLayer,
  addObjectLayer,
  box,
  createWorld,
  createWorldSettings,
  enableCollision,
  MotionQuality,
  MotionType,
  registerAll,
  rigidBody,
  sphere,
  updateWorld,
} from 'crashcat';

let _registered = false;

export interface WallSpec {
  halfExtents: [number, number, number];
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

export class PhysicsWorld {
  public readonly world: World;
  public readonly OL_STATIC: number;
  public readonly OL_MOVING: number;
  public listener: Listener | undefined = undefined;

  constructor() {
    if (!_registered) {
      registerAll();
      _registered = true;
    }

    const settings = createWorldSettings();

    settings.gravity = [0, -9.81, 0];

    const BPL_MOVING = addBroadphaseLayer(settings);
    const BPL_STATIC = addBroadphaseLayer(settings);
    const OL_MOVING = addObjectLayer(settings, BPL_MOVING);
    const OL_STATIC = addObjectLayer(settings, BPL_STATIC);

    enableCollision(settings, OL_MOVING, OL_STATIC);
    enableCollision(settings, OL_MOVING, OL_MOVING);

    this.world = createWorld(settings);
    this.OL_STATIC = OL_STATIC;
    this.OL_MOVING = OL_MOVING;
  }

  /** Rolling drive sphere — player and each bot get their own. Collide with walls + each other. */
  public createSphere(position: [number, number, number]): RigidBody {
    return rigidBody.create(this.world, {
      shape: sphere.create({ radius: 0.5 }),
      motionType: MotionType.DYNAMIC,
      objectLayer: this.OL_MOVING,
      position,
      mass: 1000.0,
      friction: 5.0,
      restitution: 0.25,
      linearDamping: 0.1,
      angularDamping: 4.0,
      gravityFactor: 1.5,
      motionQuality: MotionQuality.LINEAR_CAST,
    });
  }

  public addStaticGround(position: [number, number, number], halfExtents: [number, number, number]): void {
    rigidBody.create(this.world, {
      shape: box.create({ halfExtents }),
      motionType: MotionType.STATIC,
      objectLayer: this.OL_STATIC,
      position,
      friction: 5.0,
      restitution: 0.0,
    });
  }

  public addStaticBox(spec: WallSpec): void {
    rigidBody.create(this.world, {
      shape: box.create({ halfExtents: spec.halfExtents }),
      motionType: MotionType.STATIC,
      objectLayer: this.OL_STATIC,
      position: spec.position,
      quaternion: spec.quaternion,
      friction: 0.0,
      restitution: 0.1,
    });
  }

  public step(dt: number): void {
    updateWorld(this.world, this.listener, dt);
  }
}
