import { Container, Graphics, Text } from 'pixi.js';

import { cellWorld, type Cell, type PitLane } from './maze';
import type { Vehicle } from './Vehicle';

export type MinimapActor = {
  vehicle: Vehicle;
  label: string;
  color: number;
  isPlayer?: boolean;
};

const BOT_COLORS = [0xff6b6b, 0x4da3ff, 0x5ce1a0, 0xff7a3d, 0xc77dff, 0xffd24a];

/** Palette for bot markers (stable by index). */
export function botMapColor(index: number): number {
  return BOT_COLORS[index % BOT_COLORS.length]!;
}

/**
 * Top-down race overview: full loop, pit fork, player + bot markers.
 */
export class Minimap {
  public readonly root = new Container();

  private readonly _bg = new Graphics();
  private readonly _track = new Graphics();
  private readonly _markers = new Graphics();
  private readonly _title: Text;
  private readonly _legend: Text;

  private readonly _size: number;
  private readonly _pad: number;
  private readonly _worldMinX: number;
  private readonly _worldMinZ: number;
  private readonly _worldSpan: number;
  private readonly _cellSize: number;

  private readonly _loopPts: { x: number; z: number }[];

  constructor(
    loop: Cell[],
    cellSize: number,
    cols: number,
    rows: number,
    pit: PitLane | null,
    size = 172,
  ) {
    this._size = size;
    this._pad = 16;
    this._cellSize = cellSize;
    this._worldMinX = -cellSize * 0.5;
    this._worldMinZ = -cellSize * 0.5;
    this._worldSpan = Math.max(cols, rows) * cellSize + cellSize;

    this._loopPts = loop.map((c) => cellWorld(c, cellSize));

    this.root.addChild(this._bg, this._track, this._markers);

    this._title = new Text({
      text: 'MAP',
      style: { fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, fill: 0xb8c4d8 },
    });
    this._title.position.set(10, 6);
    this.root.addChild(this._title);

    this._legend = new Text({
      text: '▲ you   ● bots',
      style: { fontFamily: 'IBM Plex Mono, monospace', fontSize: 10, fill: 0x8a96a8 },
    });
    this._legend.position.set(10, size - 18);
    this.root.addChild(this._legend);

    this._drawChrome();
    this._drawTrack(pit);
  }

  private _drawChrome(): void {
    const s = this._size;
    this._bg.clear();
    this._bg.roundRect(0, 0, s, s, 12);
    this._bg.fill({ color: 0x0a1018, alpha: 0.82 });
    this._bg.stroke({ color: 0x4a6a88, width: 1.5, alpha: 0.55 });
    this._bg.roundRect(4, 4, s - 8, s - 8, 9);
    this._bg.stroke({ color: 0x1e2a38, width: 1, alpha: 0.9 });
  }

  private _toMap(wx: number, wz: number): { x: number; y: number } {
    const inner = this._size - this._pad * 2;
    const x = this._pad + ((wx - this._worldMinX) / this._worldSpan) * inner;
    const y = this._pad + ((wz - this._worldMinZ) / this._worldSpan) * inner;
    return { x, y };
  }

  private _drawTrack(pit: PitLane | null): void {
    this._track.clear();
    if (this._loopPts.length < 2) return;

    const pts = this._loopPts.map((p) => this._toMap(p.x, p.z));

    // Asphalt ribbon
    this._track.poly(
      pts.flatMap((p) => [p.x, p.y]),
      true,
    );
    this._track.stroke({ color: 0x3a4558, width: 7, alpha: 0.95, join: 'round', cap: 'round' });

    // Center line
    this._track.poly(
      pts.flatMap((p) => [p.x, p.y]),
      true,
    );
    this._track.stroke({ color: 0x9aa8bc, width: 2.2, alpha: 0.85, join: 'round', cap: 'round' });

    // Finish / start
    const start = pts[0]!;
    this._track.circle(start.x, start.y, 4.5);
    this._track.fill({ color: 0xffffff, alpha: 0.95 });
    this._track.circle(start.x, start.y, 2.2);
    this._track.fill({ color: 0x111820, alpha: 1 });

    // Pit fork: amber stubs from main cells to pads
    if (pit && pit.pads.length > 0) {
      const rightX = Math.cos(pit.yaw);
      const rightZ = -Math.sin(pit.yaw);
      const pitMap: { x: number; y: number }[] = [];

      for (const pad of pit.pads) {
        const main = {
          x: pad.x - rightX * pit.side * this._cellSize,
          z: pad.z - rightZ * pit.side * this._cellSize,
        };
        const a = this._toMap(main.x, main.z);
        const b = this._toMap(pad.x, pad.z);
        pitMap.push(b);
        this._track.moveTo(a.x, a.y);
        this._track.lineTo(b.x, b.y);
        this._track.stroke({ color: 0xffb020, width: 4.5, alpha: 0.95, cap: 'round' });
      }

      if (pitMap.length > 1) {
        this._track.poly(
          pitMap.flatMap((p) => [p.x, p.y]),
          false,
        );
        this._track.stroke({ color: 0xffc94a, width: 3.5, alpha: 0.95, join: 'round', cap: 'round' });
      }

      for (const p of pitMap) {
        this._track.circle(p.x, p.y, 2.4);
        this._track.fill({ color: 0xffd24a, alpha: 1 });
      }
    }
  }

  public layout(screenW: number, screenH: number): void {
    // Sit above the bottom HUD strip; left of dat.gui on the right edge.
    this.root.position.set(screenW - this._size - 18, screenH - this._size - 52);
  }

  public update(actors: readonly MinimapActor[]): void {
    this._markers.clear();

    // Draw bots under the player so you always stay readable.
    for (const a of actors) {
      if (a.isPlayer) continue;
      const { x, y } = this._toMap(a.vehicle.spherePos.x, a.vehicle.spherePos.z);
      this._drawBot(x, y, a.color);
    }
    for (const a of actors) {
      if (!a.isPlayer) continue;
      const { x, y } = this._toMap(a.vehicle.spherePos.x, a.vehicle.spherePos.z);
      this._drawPlayer(x, y, a.vehicle.yaw, a.color);
    }

    const bots = actors.length - 1;
    this._legend.text = bots > 0 ? `▲ you   ● ${bots} bot${bots === 1 ? '' : 's'}` : '▲ you';
  }

  private _drawPlayer(x: number, y: number, yaw: number, color: number): void {
    const len = 7;
    const tipX = x + Math.sin(yaw) * len;
    const tipY = y + Math.cos(yaw) * len;
    const back = yaw + Math.PI;
    const lx = x + Math.sin(back + 0.55) * 5;
    const ly = y + Math.cos(back + 0.55) * 5;
    const rx = x + Math.sin(back - 0.55) * 5;
    const ry = y + Math.cos(back - 0.55) * 5;

    this._markers.circle(x, y, 6.5);
    this._markers.fill({ color: 0xffffff, alpha: 0.18 });

    this._markers.poly([tipX, tipY, lx, ly, rx, ry]);
    this._markers.fill({ color, alpha: 1 });
    this._markers.stroke({ color: 0xffffff, width: 1.25, alpha: 0.95 });
  }

  private _drawBot(x: number, y: number, color: number): void {
    this._markers.circle(x, y, 4.5);
    this._markers.fill({ color, alpha: 1 });
    this._markers.stroke({ color: 0xffffff, width: 1, alpha: 0.75 });
  }
}
