import type { Mat3 } from './homography';

export type Facing = 'environment' | 'user';

// Takes pixels of a frame sent to a tracker to stage pixels.
export function frameToStage(video: HTMLVideoElement, stage: HTMLElement, frameWidth: number): Mat3 {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  // The video uses object-fit: cover, so frames are scaled and cropped to fill the stage.
  const cover = Math.max(w / vw, h / vh);
  const s = cover * (vw / frameWidth);
  // Trackers count pixels by index, while a pixel's center on screen is half a pixel in.
  return [s, 0, (w - vw * cover + s) / 2, 0, s, (h - vh * cover + s) / 2, 0, 0, 1];
}

export class Camera {
  stream: MediaStream | null = null;
  torchOn = false;

  constructor(readonly video: HTMLVideoElement) {}

  async start(facing: Facing): Promise<void> {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Este navegador no da acceso a la cámara. Abre la web por https.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  get track(): MediaStreamTrack | undefined {
    return this.stream?.getVideoTracks()[0];
  }

  get hasTorch(): boolean {
    const caps = this.track?.getCapabilities?.() as { torch?: boolean } | undefined;
    return !!caps?.torch;
  }

  async toggleTorch(): Promise<void> {
    if (!this.track) return;
    this.torchOn = !this.torchOn;
    await this.track.applyConstraints({ advanced: [{ torch: this.torchOn } as MediaTrackConstraintSet] });
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.torchOn = false;
  }
}

// Keeps the screen on while tracing. The lock is dropped when the tab hides, so it is re-requested.
export function keepAwake(): () => void {
  let lock: WakeLockSentinel | null = null;
  const request = async () => {
    try {
      lock = (await navigator.wakeLock?.request('screen')) ?? null;
    } catch {
      lock = null;
    }
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') void request();
  };
  document.addEventListener('visibilitychange', onVisible);
  void request();
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    void lock?.release();
  };
}

export function friendlyCameraError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError') return 'Permiso de cámara denegado. Actívalo en los ajustes del navegador.';
  if (name === 'NotFoundError') return 'No se encontró ninguna cámara en este dispositivo.';
  if (name === 'NotReadableError') return 'Otra app está usando la cámara.';
  return err instanceof Error ? err.message : 'No se pudo abrir la cámara.';
}
