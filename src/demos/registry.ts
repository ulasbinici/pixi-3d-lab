import type { DemoDefinition } from './types';
import { runCircuit } from './circuit';
import { runForestDrive } from './forest-drive';

export const demos: DemoDefinition[] = [
  {
    id: 'circuit',
    title: 'Circuit',
    blurb: 'Procedural race loop, coins, day→night. C cycles chase / FPV / top-down map.',
    tags: ['track', 'coins', 'day-night', 'drive'],
    run: runCircuit,
  },
  {
    id: 'forest-drive',
    title: 'Forest Drive',
    blurb: 'Night forest clearing, arcade truck, headlights, engine audio. C toggles chase / FPV.',
    tags: ['drive', 'audio', 'lights', 'gltf'],
    run: runForestDrive,
  },
];
