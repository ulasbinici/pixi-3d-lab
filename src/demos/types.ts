import type { Application } from 'pixi.js';

export type DemoContext = {
  app: Application;
  goHome: () => void;
};

export type DemoHandle = {
  destroy: () => void;
};

export type DemoDefinition = {
  id: string;
  title: string;
  blurb: string;
  tags: string[];
  run: (ctx: DemoContext) => Promise<DemoHandle>;
};
