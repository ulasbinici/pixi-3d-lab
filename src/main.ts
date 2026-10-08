import { Application } from 'pixi.js';

import { demos } from './demos/registry';
import type { DemoHandle } from './demos/types';

const app = new Application();
await app.init({
  preference: 'webgpu',
  resizeTo: window,
  backgroundColor: 0x05070d,
  resolution: Math.min(window.devicePixelRatio, 2),
  autoDensity: true,
  useBackBuffer: true,
});
document.body.appendChild(app.canvas);

const menuEl = document.querySelector<HTMLElement>('#menu');
const listEl = document.querySelector<HTMLElement>('#demo-list');
const loadingEl = document.querySelector<HTMLElement>('#loading');

if (!menuEl || !listEl || !loadingEl) {
  throw new Error('Menu markup missing — hard-refresh the page');
}

const menu = menuEl;
const list = listEl;
const loading = loadingEl;

let active: DemoHandle | null = null;
let launching = false;

function showMenu(): void {
  menu.hidden = false;
  loading.hidden = true;
  document.body.classList.remove('in-demo');
}

function hideMenu(): void {
  menu.hidden = true;
  document.body.classList.add('in-demo');
}

async function goHome(): Promise<void> {
  if (active) {
    active.destroy();
    active = null;
  }
  showMenu();
}

async function launch(id: string): Promise<void> {
  if (launching) return;
  launching = true;

  const demo = demos.find((d) => d.id === id);
  if (!demo) {
    launching = false;
    return;
  }

  if (active) {
    active.destroy();
    active = null;
  }

  hideMenu();
  loading.hidden = false;
  loading.textContent = `Loading ${demo.title}…`;

  try {
    active = await demo.run({ app, goHome });
  } catch (err) {
    console.error(err);
    loading.textContent = `Failed to load ${demo.title}. Check console.`;
    showMenu();
    loading.hidden = false;
    launching = false;
    return;
  }

  loading.hidden = true;
  launching = false;
}

for (const demo of demos) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'demo-card';
  button.innerHTML = `
    <span class="demo-card__title">${demo.title}</span>
    <span class="demo-card__blurb">${demo.blurb}</span>
    <span class="demo-card__tags">${demo.tags.map((t) => `<em>${t}</em>`).join('')}</span>
  `;
  button.addEventListener('click', () => void launch(demo.id));
  list.appendChild(button);
}

showMenu();
