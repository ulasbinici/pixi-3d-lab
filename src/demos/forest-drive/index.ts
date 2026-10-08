import type { Scene3DSource } from '@pixi/3d';
import {
  AmbientLight,
  DirectionalLight,
  Material3D,
  Mesh3D,
  Model3D,
  PlaneGeometry,
  PointLight,
  SpotLight,
  Vector3,
  View3D,
} from '@pixi/3d';
import { Assets, Container, Text } from 'pixi.js';

import type { DemoContext, DemoHandle } from '../types';
import { GameAudio } from './Audio';
import { DriveCamera } from './Camera';
import { Controls } from './Controls';
import type { WallSpec } from './Physics';
import { PhysicsWorld } from './Physics';
import { MAX_SPEED, Vehicle } from './Vehicle';

const ASSET = {
  truck: '/assets/racing/vehicle-truck-yellow.glb',
  forest: '/assets/racing/decoration-forest.glb',
  empty: '/assets/racing/decoration-empty.glb',
};

const HEADLIGHT_INTENSITY = 160;
const HEADLIGHT_FILL = 28;

function scatterForest(
  root: View3D['root'],
  forest: Scene3DSource,
  empty: Scene3DSource,
): WallSpec[] {
  const patches: Array<[number, number, number, 'forest' | 'empty']> = [];
  const colliders: WallSpec[] = [];

  for (let gx = -7; gx <= 7; gx++) {
    for (let gz = -7; gz <= 7; gz++) {
      const dist = Math.hypot(gx, gz);
      if (dist < 2.2) continue;
      if (dist > 7.2) continue;
      // Leave a soft road corridor on +Z and -X so driving feels open.
      if (Math.abs(gx) < 1.1 && gz > -1) continue;
      if (gz > 0 && Math.abs(gx) < 1.6) continue;

      patches.push([
        gx * 7.5,
        gz * 7.5,
        (gx * 17 + gz * 13) % 360,
        dist > 5.4 ? 'forest' : Math.random() > 0.35 ? 'forest' : 'empty',
      ]);
    }
  }

  for (const [x, z, yawDeg, kind] of patches) {
    const model = new Model3D(kind === 'forest' ? forest : empty);
    model.position.set(x, 0, z);
    model.rotation.y = (yawDeg * Math.PI) / 180;
    model.scale.set(0.75);
    root.addChild(model);

    // Forest patches are clusters — a squat box blocks the trunks well enough for arcade driving.
    const half = kind === 'forest' ? ([3.1, 2.4, 3.1] as [number, number, number]) : ([1.6, 1.1, 1.6] as [number, number, number]);
    colliders.push({
      halfExtents: half,
      position: [x, half[1], z],
      quaternion: [0, 0, 0, 1],
    });
  }

  return colliders;
}

function makeHeadlamp(side: -1 | 1): {
  flood: SpotLight;
  pencil: SpotLight;
  fill: PointLight;
} {
  const flood = new SpotLight({
    color: 0xfff1c8,
    intensity: HEADLIGHT_INTENSITY,
    range: 48,
    coneAngle: 28,
    penumbra: 0.45,
    castShadow: false,
  });
  const pencil = new SpotLight({
    color: 0xffffff,
    intensity: HEADLIGHT_INTENSITY * 0.75,
    range: 55,
    coneAngle: 12,
    penumbra: 0.25,
    castShadow: false,
  });
  const fill = new PointLight({
    color: 0xffe6b0,
    intensity: HEADLIGHT_FILL,
    range: 7,
    castShadow: false,
  });

  // Invisible lights only — SpotLight beams along local -Z; truck forward is +Z → yaw π.
  const x = side * 0.48;
  flood.position.set(x, 0.82, 1.05);
  flood.rotation.set(-0.08, Math.PI, 0);
  pencil.position.set(x, 0.82, 1.05);
  pencil.rotation.set(-0.04, Math.PI, 0);
  fill.position.set(x, 0.78, 1.15);

  return { flood, pencil, fill };
}

export async function runForestDrive(ctx: DemoContext): Promise<DemoHandle> {
  const { app, goHome } = ctx;

  const view3d = new View3D({
    autoResize: true,
    shadowQuality: 'high',
    toneMapping: 'aces',
    exposure: 1.05,
    environment: { skyColor: 0x1a2438, groundColor: 0x1d2a18, intensity: 0.85 },
    fog: { type: 'linear', color: 0x141c28, near: 35, far: 90 },
  });
  app.stage.addChild(view3d);

  const [truckSrc, forestSrc, emptySrc] = await Promise.all([
    Assets.load<Scene3DSource>(ASSET.truck),
    Assets.load<Scene3DSource>(ASSET.forest),
    Assets.load<Scene3DSource>(ASSET.empty),
  ]);

  const moon = new DirectionalLight({
    color: 0x9bb4ff,
    intensity: 0.55,
    castShadow: true,
    shadow: { bias: 0.0008, normalBias: 0.05, maxDistance: 90, cascades: 3, lambda: 0.6 },
  });
  moon.position.set(14, 22, -8);
  moon.lookAt({ x: 0, y: 0, z: 0 });
  const ambient = new AmbientLight({ color: 0x243048, intensity: 0.28 });
  view3d.root.addChild(moon, ambient);

  const ground = new Mesh3D({
    geometry: new PlaneGeometry({ width: 220, height: 220 }),
    material: new Material3D({ baseColor: 0x355038, metallic: 0, roughness: 0.94 }),
    castShadow: false,
    receiveShadow: true,
  });
  ground.rotation.set(-Math.PI / 2, 0, 0);
  ground.position.set(0, -0.13, 0);
  view3d.root.addChild(ground);

  const treeColliders = scatterForest(view3d.root, forestSrc, emptySrc);

  const physics = new PhysicsWorld(new Vector3(0, 0.5, 4));
  physics.addStaticGround([0, -0.125, 0], [120, 0.01, 120]);

  for (const collider of treeColliders) {
    physics.addStaticBox(collider);
  }

  // Soft invisible borders so you don't fall forever.
  const border = 55;
  const wallH = 2;
  const wallT = 1;
  for (const wall of [
    { halfExtents: [border, wallH, wallT] as [number, number, number], position: [0, wallH, -border] as [number, number, number] },
    { halfExtents: [border, wallH, wallT] as [number, number, number], position: [0, wallH, border] as [number, number, number] },
    { halfExtents: [wallT, wallH, border] as [number, number, number], position: [-border, wallH, 0] as [number, number, number] },
    { halfExtents: [wallT, wallH, border] as [number, number, number], position: [border, wallH, 0] as [number, number, number] },
  ]) {
    physics.addStaticBox({ ...wall, quaternion: [0, 0, 0, 1] });
  }

  const audio = new GameAudio();
  void audio.load();

  const unlockAudio = (): void => {
    audio.unlock();
    window.removeEventListener('keydown', unlockAudio);
    window.removeEventListener('pointerdown', unlockAudio);
  };
  window.addEventListener('keydown', unlockAudio);
  window.addEventListener('pointerdown', unlockAudio);

  const vehicle = new Vehicle(truckSrc, physics);
  view3d.root.addChild(vehicle.container);

  const lampL = makeHeadlamp(-1);
  const lampR = makeHeadlamp(1);
  const headlamps = [lampL, lampR];
  for (const lamp of headlamps) {
    vehicle.container.addChild(lamp.flood, lamp.pencil, lamp.fill);
  }

  physics.listener = {
    onContactAdded(bodyA, bodyB) {
      if (bodyA !== physics.sphereBody && bodyB !== physics.sphereBody) return;
      const fx = Math.sin(vehicle.yaw);
      const fz = Math.cos(vehicle.yaw);
      const mv = vehicle.modelVelocity;
      audio.playImpact(Math.abs(mv.x * fx + mv.z * fz));
    },
  };

  const driveCamera = new DriveCamera(view3d.camera);
  const controls = new Controls();

  const hud = new Container();
  app.stage.addChild(hud);

  const hint = new Text({
    text: 'WASD drive  ·  C camera (chase / FPV)  ·  L headlights  ·  Esc menu',
    style: {
      fontFamily: 'IBM Plex Mono, monospace',
      fontSize: 14,
      fill: 0xe8f0ff,
    },
  });
  hint.alpha = 0.9;
  hud.addChild(hint);

  const camLabel = new Text({
    text: 'Camera: chase',
    style: {
      fontFamily: 'IBM Plex Mono, monospace',
      fontSize: 13,
      fill: 0x5ce1ff,
    },
  });
  hud.addChild(camLabel);

  const layoutHud = (): void => {
    hint.position.set(24, app.screen.height - 36);
    camLabel.position.set(24, 24);
  };
  layoutHud();

  let headlightsOn = true;
  const setHeadlights = (on: boolean): void => {
    headlightsOn = on;
    for (const lamp of headlamps) {
      lamp.flood.visible = lamp.pencil.visible = lamp.fill.visible = on;
      lamp.flood.intensity = on ? HEADLIGHT_INTENSITY : 0;
      lamp.pencil.intensity = on ? HEADLIGHT_INTENSITY * 0.75 : 0;
      lamp.fill.intensity = on ? HEADLIGHT_FILL : 0;
    }
    // Dimmer night fill so beams actually read in FPV.
    moon.intensity = on ? 0.45 : 0.9;
    ambient.intensity = on ? 0.22 : 0.45;
  };
  setHeadlights(true);

  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'KeyC') {
      const mode = driveCamera.toggle();
      camLabel.text = `Camera: ${mode}`;
    }
    if (e.code === 'KeyL') {
      setHeadlights(!headlightsOn);
      camLabel.text = `Camera: ${driveCamera.mode} · lights ${headlightsOn ? 'on' : 'off'}`;
    }
    if (e.code === 'Escape') {
      goHome();
    }
  };
  window.addEventListener('keydown', onKey);

  const onTick = (): void => {
    const dt = Math.min(app.ticker.deltaMS / 1000, 1 / 30);
    const input = controls.update();

    physics.step(dt);
    vehicle.update(dt, input);

    moon.position.set(vehicle.spherePos.x + 14, 22, vehicle.spherePos.z - 8);
    moon.lookAt({ x: vehicle.spherePos.x, y: 0, z: vehicle.spherePos.z });

    driveCamera.update(dt, vehicle.container.position, vehicle.modelVelocity, vehicle.yaw);
    audio.update(dt, vehicle.linearSpeed / MAX_SPEED, input.z, vehicle.driftIntensity);
    layoutHud();
  };
  app.ticker.add(onTick);

  return {
    destroy: () => {
      app.ticker.remove(onTick);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', unlockAudio);
      window.removeEventListener('pointerdown', unlockAudio);
      controls.destroy();
      audio.destroy();
      app.stage.removeChild(view3d);
      app.stage.removeChild(hud);
      view3d.destroy({ children: true });
      hud.destroy({ children: true });
    },
  };
}
