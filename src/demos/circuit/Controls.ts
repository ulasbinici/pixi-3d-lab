export interface ControlsState {
  x: number;
  z: number;
  /** Space / gamepad B — rear lock for drifts. */
  handbrake: boolean;
  touchActive: boolean;
}

export class Controls {
  private readonly _keys: Record<string, boolean> = Object.create(null);

  constructor() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  public destroy(): void {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }

  public update(): ControlsState {
    let x = 0;
    let z = 0;
    let handbrake = !!this._keys.Space;

    if (this._keys.KeyA || this._keys.ArrowLeft) x -= 1;
    if (this._keys.KeyD || this._keys.ArrowRight) x += 1;
    if (this._keys.KeyW || this._keys.ArrowUp) z += 1;
    if (this._keys.KeyS || this._keys.ArrowDown) z -= 1;

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];

    for (const gp of pads) {
      if (!gp) continue;

      const stickX = gp.axes[0];
      if (Math.abs(stickX) > 0.15) x = stickX;

      const rt = gp.buttons[7]?.value ?? 0;
      const lt = gp.buttons[6]?.value ?? 0;
      if (rt > 0.1 || lt > 0.1) z = rt - lt;

      // B / Circle — common handbrake binding
      if (gp.buttons[1]?.pressed) handbrake = true;

      break;
    }

    return { x, z, handbrake, touchActive: false };
  }

  private readonly _onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Space') e.preventDefault();
    this._keys[e.code] = true;
  };

  private readonly _onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') e.preventDefault();
    this._keys[e.code] = false;
  };
}
