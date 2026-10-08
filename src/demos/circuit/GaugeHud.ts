import { Container, Graphics, Text } from 'pixi.js';

const SEG_COLORS = [0x8eff00, 0xd1ff00, 0xffe300, 0xffcc00, 0xff6600, 0xff0000];

/**
 * Arcade graphical HUD: half-circle speed + RPM needles, horizontal fuel bar.
 * Pure Graphics (07-needle-gauge look) — no texture dependency.
 */
export class GaugeHud {
  public readonly root = new Container();

  private readonly _spdNeedle: Graphics;
  private readonly _rpmNeedle: Graphics;
  private readonly _fuelFill: Graphics;
  private readonly _spdText: Text;
  private readonly _rpmText: Text;
  private readonly _fuelText: Text;
  private _spd = 0;
  private _rpm = 0;
  private _fuel = 1;

  constructor() {
    this.root.visible = false;

    const speed = this._makeDial('SPD', 78);
    this._spdNeedle = speed.needle;
    this._spdText = speed.readout;
    speed.root.position.set(-150, -8);

    const rpm = this._makeDial('RPM', 64);
    this._rpmNeedle = rpm.needle;
    this._rpmText = rpm.readout;
    rpm.root.position.set(150, 4);

    const fuel = this._makeFuelBar();
    this._fuelFill = fuel.fill;
    this._fuelText = fuel.readout;
    fuel.root.position.set(0, 78);

    this.root.addChild(speed.root, rpm.root, fuel.root);
  }

  public get visible(): boolean {
    return this.root.visible;
  }

  public set visible(v: boolean) {
    this.root.visible = v;
  }

  public layout(screenW: number, screenH: number): void {
    this.root.position.set(screenW * 0.5, screenH - 118);
  }

  /** @param speedNorm 0..1  @param rpmNorm 0..1  @param fuelPct 0..100 */
  public update(dt: number, speedNorm: number, rpmNorm: number, fuelPct: number): void {
    if (!this.root.visible) return;
    const sn = Math.max(0, Math.min(1, speedNorm));
    const rn = Math.max(0, Math.min(1, rpmNorm));
    const fn = Math.max(0, Math.min(1, fuelPct / 100));
    this._spd += (sn - this._spd) * Math.min(1, dt * 10);
    this._rpm += (rn - this._rpm) * Math.min(1, dt * 12);
    this._fuel += (fn - this._fuel) * Math.min(1, dt * 8);

    // Semi-circle: -90° (left/green) → +90° (right/red), 0 = up.
    const minA = -Math.PI / 2;
    const maxA = Math.PI / 2;
    this._spdNeedle.rotation = minA + (maxA - minA) * this._spd;
    this._rpmNeedle.rotation = minA + (maxA - minA) * this._rpm;

    this._spdText.text = String(Math.round(this._spd * 180));
    this._rpmText.text = String(Math.round(800 + this._rpm * 7200));
    this._fuelText.text = `FUEL ${Math.round(this._fuel * 100)}%`;
    this._redrawFuel(this._fuel);
  }

  private _makeDial(
    label: string,
    radius: number,
  ): { root: Container; needle: Graphics; readout: Text } {
    const root = new Container();
    const face = new Graphics();
    this._drawHalfArc(face, radius);
    root.addChild(face);

    const needle = new Graphics();
    this._drawNeedle(needle, radius * 0.78);
    root.addChild(needle);

    const readout = new Text({
      text: '0',
      style: {
        fontFamily: 'IBM Plex Mono, monospace',
        fontSize: label === 'SPD' ? 18 : 14,
        fill: 0xe8f0ff,
        fontWeight: '700',
      },
    });
    readout.anchor.set(0.5, 0);
    readout.position.set(0, 10);
    root.addChild(readout);

    const tag = new Text({
      text: label,
      style: { fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, fill: 0x9ab0cc },
    });
    tag.anchor.set(0.5, 0);
    tag.position.set(0, 32);
    root.addChild(tag);

    return { root, needle, readout };
  }

  private _drawHalfArc(g: Graphics, radius: number): void {
    const segs = SEG_COLORS.length;
    const start = Math.PI; // left
    const span = Math.PI; // to right through top
    const thick = radius * 0.28;
    const gap = 0.03;
    for (let i = 0; i < segs; i++) {
      const a0 = start + (span / segs) * i + gap * 0.5;
      const a1 = start + (span / segs) * (i + 1) - gap * 0.5;
      g.moveTo(Math.cos(a0) * (radius - thick), Math.sin(a0) * (radius - thick));
      g.arc(0, 0, radius - thick, a0, a1, false);
      g.arc(0, 0, radius, a1, a0, true);
      g.closePath();
      g.fill({ color: SEG_COLORS[i]! });
    }
  }

  private _drawNeedle(g: Graphics, length: number): void {
    g.clear();
    g.moveTo(0, 6);
    g.lineTo(-6, 8);
    g.lineTo(0, -length);
    g.lineTo(6, 8);
    g.closePath();
    g.fill({ color: 0x2a2a2a });
    g.circle(0, 0, 10);
    g.fill({ color: 0x2a2a2a });
    g.circle(0, 0, 6);
    g.fill({ color: 0xb0b0b0 });
  }

  private _makeFuelBar(): { root: Container; fill: Graphics; readout: Text } {
    const root = new Container();
    const track = new Graphics();
    const w = 280;
    const h = 18;
    track.roundRect(-w / 2, -h / 2, w, h, 9);
    track.fill({ color: 0x2a3038 });
    // Segment ticks for arcade feel.
    for (let i = 1; i < 7; i++) {
      const x = -w / 2 + (w / 7) * i;
      track.moveTo(x, -h / 2 + 2);
      track.lineTo(x, h / 2 - 2);
      track.stroke({ width: 1, color: 0x1a1e24, alpha: 0.7 });
    }
    root.addChild(track);

    const fill = new Graphics();
    root.addChild(fill);

    const readout = new Text({
      text: 'FUEL 100%',
      style: { fontFamily: 'IBM Plex Mono, monospace', fontSize: 12, fill: 0x9ab0cc },
    });
    readout.anchor.set(0.5, 0);
    readout.position.set(0, 14);
    root.addChild(readout);

    return { root, fill, readout };
  }

  private _redrawFuel(t: number): void {
    const w = 280;
    const h = 12;
    const fw = Math.max(0, (w - 6) * t);
    this._fuelFill.clear();
    if (fw <= 0) return;
    const color = t <= 0.2 ? 0xff3b4a : t <= 0.45 ? 0xffd24a : 0x3ecf8e;
    this._fuelFill.roundRect(-w / 2 + 3, -h / 2, fw, h, 6);
    this._fuelFill.fill({ color });
  }
}
