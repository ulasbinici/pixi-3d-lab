import type { ControlsState } from './Controls';
import type { RacePath } from './RacePath';
import type { Vehicle } from './Vehicle';
import { MAX_SPEED } from './Vehicle';

export type BotPersonality = {
  /** Display name. */
  name: string;
  /** 0 = messy, 1 = sharp. Drives speed, lookahead, noise, braking. */
  skill: number;
  /** Prefer inside (−) or outside (+) of the racing line. */
  laneBias: number;
  /** How often they dab handbrake into corners. */
  slideStyle: number;
};

const BOT_NAMES = ['Rookie', 'Dash', 'Drift', 'Ace', 'Turbo', 'Nova', 'Blitz', 'Echo'];

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function makePersonality(index: number): BotPersonality {
  // Spread skills so the pack feels mixed — not all ghosts.
  const skillRoll = [0.35, 0.55, 0.72, 0.88, 0.48, 0.65, 0.8, 0.42][index % 8]!;
  const jitter = (Math.random() - 0.5) * 0.12;
  return {
    name: BOT_NAMES[index % BOT_NAMES.length]!,
    skill: clamp(skillRoll + jitter, 0.25, 0.95),
    laneBias: (Math.random() - 0.5) * 2.4,
    slideStyle: Math.random() * 0.7,
  };
}

/**
 * Arcade NPC driver: pure-pursuit along the race path + personality noise +
 * simple separation from other cars. Not a rigid path follower.
 */
export class BotDriver {
  public readonly personality: BotPersonality;
  private _steer = 0;
  private _throttle = 0;
  private _time = Math.random() * 100;
  private _mistakeT = 3 + Math.random() * 4;
  private _mistakeSteer = 0;

  constructor(personality: BotPersonality) {
    this.personality = personality;
  }

  public update(
    dt: number,
    vehicle: Vehicle,
    path: RacePath,
    others: readonly Vehicle[],
    racing: boolean,
  ): ControlsState {
    if (!racing || path.samples.length === 0) {
      this._steer = 0;
      this._throttle = 0;
      return { x: 0, z: 0, handbrake: false, touchActive: false };
    }

    this._time += dt;
    const p = this.personality;
    const skill = p.skill;

    const idx = path.nearestIndex(vehicle.spherePos.x, vehicle.spherePos.z);
    // Better drivers look farther; rookies chase their nose.
    const lookDist = 4.5 + skill * 7 + Math.abs(vehicle.linearSpeed) * 2.5;
    const target = path.ahead(idx, lookDist);

    // Lane offset + gentle weave so they don't sit on one rail.
    const weave = Math.sin(this._time * (0.7 + skill * 0.4) + p.laneBias) * (1.1 - skill * 0.7);
    const lane = p.laneBias * 0.55 + weave;
    const rightX = Math.cos(target.yaw);
    const rightZ = -Math.sin(target.yaw);
    const tx = target.x + rightX * lane;
    const tz = target.z + rightZ * lane;

    let desiredYaw = Math.atan2(tx - vehicle.spherePos.x, tz - vehicle.spherePos.z);

    // Occasional brain-fart — worse drivers more often.
    this._mistakeT -= dt;
    if (this._mistakeT <= 0) {
      this._mistakeT = 2.5 + Math.random() * (6 - skill * 3);
      if (Math.random() > skill) {
        this._mistakeSteer = (Math.random() - 0.5) * (1.2 - skill);
      } else {
        this._mistakeSteer = 0;
      }
    }
    desiredYaw += this._mistakeSteer * 0.55;

    // Separation from nearby cars (rubber-band bump avoidance).
    let avoidX = 0;
    let avoidZ = 0;
    for (const other of others) {
      if (other === vehicle) continue;
      const dx = vehicle.spherePos.x - other.spherePos.x;
      const dz = vehicle.spherePos.z - other.spherePos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 0.01 || d2 > 25) continue;
      const d = Math.sqrt(d2);
      const push = (5 - d) / 5;
      avoidX += (dx / d) * push;
      avoidZ += (dz / d) * push;
    }
    if (avoidX !== 0 || avoidZ !== 0) {
      desiredYaw = Math.atan2(
        Math.sin(desiredYaw) + avoidX * (0.9 - skill * 0.3),
        Math.cos(desiredYaw) + avoidZ * (0.9 - skill * 0.3),
      );
    }

    const err = wrapAngle(desiredYaw - vehicle.yaw);
    const steerGain = 1.15 + skill * 0.55;
    const rawSteer = clamp(-err * steerGain, -1, 1);
    // Reaction lag — rookies are mushy on the wheel.
    const steerLerp = 3 + skill * 7;
    this._steer += (rawSteer - this._steer) * Math.min(1, dt * steerLerp);

    // Speed from upcoming curvature + skill ceiling.
    const corner = path.curvatureAhead(idx, 6 + skill * 4);
    const top = MAX_SPEED * (0.62 + skill * 0.38);
    let targetNorm = 1 - clamp(corner * (1.35 - skill * 0.5), 0, 0.72);
    targetNorm *= 0.88 + skill * 0.12;
    // Noise on throttle so packs breathe.
    targetNorm += Math.sin(this._time * 1.3 + p.laneBias) * (0.08 - skill * 0.05);
    targetNorm = clamp(targetNorm, 0.2, 1);

    const wantSpeed = top * targetNorm;
    const speed = Math.abs(vehicle.linearSpeed);
    let throttle = speed < wantSpeed - 0.05 ? 1 : speed > wantSpeed + 0.08 ? -0.35 : 0.45;
    // Close-quarters: lift a bit when someone is right in front.
    for (const other of others) {
      if (other === vehicle) continue;
      const dx = other.spherePos.x - vehicle.spherePos.x;
      const dz = other.spherePos.z - vehicle.spherePos.z;
      const ahead = dx * Math.sin(vehicle.yaw) + dz * Math.cos(vehicle.yaw);
      const side = Math.abs(dx * Math.cos(vehicle.yaw) - dz * Math.sin(vehicle.yaw));
      if (ahead > 0.4 && ahead < 4.5 && side < 1.6) {
        throttle = Math.min(throttle, 0.15 + skill * 0.2);
      }
    }

    this._throttle += (throttle - this._throttle) * Math.min(1, dt * (4 + skill * 4));

    const handbrake =
      corner > 0.55 &&
      speed > 0.55 &&
      Math.abs(this._steer) > 0.35 &&
      Math.random() < dt * p.slideStyle * (1.2 - skill * 0.4);

    return {
      x: clamp(this._steer, -1, 1),
      z: clamp(this._throttle, -1, 1),
      handbrake,
      touchActive: false,
    };
  }
}
