import { clamp, lerp } from '@pixi/3d';

const NUM_GEARS = 3;
const UPSHIFT_RPM = 0.92;
const DOWNSHIFT_RPM = 0.35;
const SHIFT_COOLDOWN = 0.35;

const PITCH_LOW = [1.05, 1.25, 1.4];
const PITCH_HIGH = [3.5, 2.9, 2.3];

const FILTER_CUTOFF_MIN = 700;
const FILTER_CUTOFF_MAX = 7000;

const AUDIO_BASE = '/assets/racing/audio';

function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return outMin + ((outMax - outMin) * (value - inMin)) / (inMax - inMin);
}

interface LoopVoice {
  source: AudioBufferSourceNode | null;
  gain: GainNode;
  filter: BiquadFilterNode | null;
  buffer: AudioBuffer | null;
  currentVolume: number;
  currentPitch: number;
}

export class GameAudio {
  private readonly _ctx: AudioContext;
  private readonly _master: GainNode;
  private readonly _musicBus: GainNode;
  private readonly _sfxBus: GainNode;

  private readonly _engine: LoopVoice;
  private readonly _engineLayer: LoopVoice;
  private readonly _skid: LoopVoice;
  private readonly _music: LoopVoice;
  private readonly _impactBuffers: AudioBuffer[] = [];
  private _coinBuffer: AudioBuffer | null = null;
  private _fuelBuffer: AudioBuffer | null = null;
  private _impactIndex = 0;

  private _ready = false;
  private _unlocked = false;
  private _started = false;

  private _rpm = 0;
  private _gear = 0;
  private _shiftCooldown = 0;

  private _musicOn = true;
  private _sfxOn = true;
  private _musicVol = 0.4;
  private _sfxVol = 0.85;

  constructor() {
    const Ctx = (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext) as typeof AudioContext;

    this._ctx = new Ctx();
    this._master = this._ctx.createGain();
    this._master.gain.value = 1;
    this._master.connect(this._ctx.destination);

    this._musicBus = this._ctx.createGain();
    this._musicBus.gain.value = this._musicVol;
    this._musicBus.connect(this._master);

    this._sfxBus = this._ctx.createGain();
    this._sfxBus.gain.value = this._sfxVol;
    this._sfxBus.connect(this._master);

    this._engine = this._makeVoice(true, this._sfxBus);
    this._engineLayer = this._makeVoice(false, this._sfxBus);
    this._skid = this._makeVoice(false, this._sfxBus);
    this._music = this._makeVoice(false, this._musicBus);
  }

  private _makeVoice(withFilter: boolean, bus: GainNode): LoopVoice {
    const gain = this._ctx.createGain();
    gain.gain.value = 0;

    let filter: BiquadFilterNode | null = null;
    let head: AudioNode = gain;

    if (withFilter) {
      filter = this._ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.7;
      filter.frequency.value = FILTER_CUTOFF_MIN;
      gain.connect(filter);
      head = filter;
    }

    head.connect(bus);
    return { source: null, gain, filter, buffer: null, currentVolume: 0, currentPitch: 1 };
  }

  public async load(): Promise<void> {
    const [engineBuf, skidBuf, impactBuf, coinBuf, musicBuf, fuelBuf] = await Promise.all([
      this._fetchBuffer(`${AUDIO_BASE}/engine.ogg`),
      this._fetchBuffer(`${AUDIO_BASE}/skid.ogg`),
      this._fetchBuffer(`${AUDIO_BASE}/impact.ogg`),
      this._fetchBuffer(`${AUDIO_BASE}/coin.mp3`),
      this._fetchBuffer(`${AUDIO_BASE}/music.mp3`),
      this._fetchBuffer(`${AUDIO_BASE}/fuel.wav`),
    ]);

    this._engine.buffer = engineBuf;
    this._engineLayer.buffer = engineBuf;
    this._skid.buffer = skidBuf;
    this._coinBuffer = coinBuf;
    this._fuelBuffer = fuelBuf;
    this._music.buffer = musicBuf;
    for (let i = 0; i < 3; i++) this._impactBuffers.push(impactBuf);

    this._ready = true;
    if (this._unlocked) this._start();
  }

  private async _fetchBuffer(url: string): Promise<AudioBuffer> {
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    return this._ctx.decodeAudioData(arr);
  }

  public unlock(): void {
    if (this._unlocked) return;
    this._unlocked = true;

    if (this._ctx.state === 'suspended') void this._ctx.resume();
    if (this._ready) this._start();
  }

  private _start(): void {
    if (this._started) return;
    this._started = true;
    this._startVoice(this._engine);
    this._startVoice(this._engineLayer);
    this._startVoice(this._skid);
    this._startVoice(this._music);
    this._applyMusicGain();
  }

  private _startVoice(voice: LoopVoice): void {
    if (!voice.buffer) return;
    const src = this._ctx.createBufferSource();
    src.buffer = voice.buffer;
    src.loop = true;
    src.playbackRate.value = 1;
    src.connect(voice.gain);
    src.start();
    voice.source = src;
  }

  private _applyMusicGain(): void {
    const v = this._musicOn ? this._musicVol : 0;
    this._musicBus.gain.setTargetAtTime(v, this._ctx.currentTime, 0.05);
    // Music voice itself sits at a steady bed level.
    if (this._started) this._music.gain.gain.value = this._musicOn ? 0.55 : 0;
  }

  private _applySfxGain(): void {
    const v = this._sfxOn ? this._sfxVol : 0;
    this._sfxBus.gain.setTargetAtTime(v, this._ctx.currentTime, 0.05);
  }

  public setMusicEnabled(on: boolean): void {
    this._musicOn = on;
    this._applyMusicGain();
  }

  public setSfxEnabled(on: boolean): void {
    this._sfxOn = on;
    this._applySfxGain();
  }

  public setMusicVolume(v: number): void {
    this._musicVol = clamp(v, 0, 1);
    this._applyMusicGain();
  }

  public setSfxVolume(v: number): void {
    this._sfxVol = clamp(v, 0, 1);
    this._applySfxGain();
  }

  public update(dt: number, speed: number, throttle: number, driftIntensity: number): void {
    if (!this._started) return;

    const absSpeed = clamp(Math.abs(speed), 0, 1);
    const load = clamp(Math.max(0, throttle), 0, 1);
    const gearWindow = 1 / NUM_GEARS;
    const gearStart = this._gear * gearWindow;
    const inGear = clamp((absSpeed - gearStart) / gearWindow, 0, 1);

    let targetRpm = clamp(inGear * 0.85 + load * 0.2, 0, 1.05);
    const rate = targetRpm > this._rpm ? 4 * (0.3 + load) : 4;
    this._rpm = lerp(this._rpm, targetRpm, Math.min(1, dt * rate));
    this._shiftCooldown = Math.max(0, this._shiftCooldown - dt);

    if (this._shiftCooldown === 0) {
      if (this._rpm > UPSHIFT_RPM && this._gear < NUM_GEARS - 1 && load > 0.1) {
        this._gear++;
        this._rpm = 0.45;
        this._shiftCooldown = SHIFT_COOLDOWN;
      } else if (this._rpm < DOWNSHIFT_RPM && this._gear > 0) {
        this._gear--;
        this._rpm = 0.78;
        this._shiftCooldown = SHIFT_COOLDOWN;
      }
    }

    const targetVol = remap(absSpeed + load * 0.5, 0, 1.5, 0.02, 0.25);
    this._engine.currentVolume = lerp(this._engine.currentVolume, targetVol, dt * 5);
    this._engine.gain.gain.value = this._engine.currentVolume;
    this._engineLayer.currentVolume = this._engine.currentVolume * 0.4;
    this._engineLayer.gain.gain.value = this._engineLayer.currentVolume;

    const pitch = lerp(PITCH_LOW[this._gear]!, PITCH_HIGH[this._gear]!, this._rpm);
    if (this._engine.source) this._engine.source.playbackRate.value = pitch;
    if (this._engineLayer.source) this._engineLayer.source.playbackRate.value = pitch * 0.5;

    if (this._engine.filter) {
      const targetCutoff = remap(load, 0, 1, FILTER_CUTOFF_MIN, FILTER_CUTOFF_MAX);
      this._engine.filter.frequency.setTargetAtTime(targetCutoff, this._ctx.currentTime, 0.05);
    }

    let skidVol = 0;
    if (driftIntensity > 0.5) {
      skidVol = remap(clamp(driftIntensity, 0.5, 2.5), 0.5, 2.5, 0.05, 0.3);
    }

    this._skid.currentVolume = lerp(this._skid.currentVolume, skidVol, dt * 10);
    this._skid.gain.gain.value = this._skid.currentVolume;

    const skidPitch = clamp(Math.abs(speed), 1, 3);
    this._skid.currentPitch = lerp(this._skid.currentPitch, skidPitch, 0.1);
    if (this._skid.source) this._skid.source.playbackRate.value = this._skid.currentPitch;
  }

  public playImpact(impactVelocity: number): void {
    if (!this._unlocked || !this._sfxOn || this._impactBuffers.length === 0) return;

    const buffer = this._impactBuffers[this._impactIndex]!;
    this._impactIndex = (this._impactIndex + 1) % this._impactBuffers.length;

    const src = this._ctx.createBufferSource();
    src.buffer = buffer;
    const gain = this._ctx.createGain();
    gain.gain.value = clamp(remap(impactVelocity, 0, 6, 0.01, 1.0), 0.01, 1.0);
    src.connect(gain);
    gain.connect(this._sfxBus);
    src.start();
  }

  public playCoin(): void {
    if (!this._unlocked || !this._sfxOn || !this._coinBuffer) return;
    const src = this._ctx.createBufferSource();
    src.buffer = this._coinBuffer;
    const gain = this._ctx.createGain();
    gain.gain.value = 0.7;
    src.connect(gain);
    gain.connect(this._sfxBus);
    src.start();
  }

  public playFuel(): void {
    if (!this._unlocked || !this._sfxOn || !this._fuelBuffer) return;
    const src = this._ctx.createBufferSource();
    src.buffer = this._fuelBuffer;
    const gain = this._ctx.createGain();
    gain.gain.value = 0.85;
    src.connect(gain);
    gain.connect(this._sfxBus);
    src.start();
  }

  public destroy(): void {
    for (const voice of [this._engine, this._engineLayer, this._skid, this._music]) {
      try {
        voice.source?.stop();
      } catch {
        // already stopped
      }
      voice.source = null;
      voice.gain.gain.value = 0;
    }
    void this._ctx.close();
  }
}
