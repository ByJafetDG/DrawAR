const LONG_SIDE = 720;
const FIRST_INTERVAL_MS = 2000;
const MAX_FRAMES = 900; // half a minute of video
const MIN_FPS = 8;
const MAX_FPS = 30;
const MIN_SECONDS = 4;
const HOLD_LAST_FRAME_MS = 1200;

const FORMATS = [
  { type: 'video/mp4;codecs=avc1.42E01E', extension: 'mp4' },
  { type: 'video/mp4', extension: 'mp4' },
  { type: 'video/webm;codecs=vp9', extension: 'webm' },
  { type: 'video/webm', extension: 'webm' },
];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Keeps camera stills and only turns them into a video at the end, so a long drawing session
// costs little. When the buffer fills, every other frame goes and the pace halves, which
// keeps the whole session evenly represented.
export class TimeLapse {
  private frames: Blob[] = [];
  private interval = FIRST_INTERVAL_MS;
  private timer = 0;
  private video: HTMLVideoElement | null = null;
  private readonly canvas = document.createElement('canvas');

  get recording(): boolean {
    return this.timer !== 0;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  start(video: HTMLVideoElement): void {
    this.video = video;
    this.stop();
    this.capture();
    this.timer = window.setInterval(() => this.capture(), this.interval);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = 0;
  }

  clear(): void {
    this.stop();
    this.frames = [];
    this.interval = FIRST_INTERVAL_MS;
  }

  private capture(): void {
    const video = this.video;
    if (!video || document.hidden || video.readyState < 2) return;
    const scale = Math.min(1, LONG_SIDE / Math.max(video.videoWidth, video.videoHeight));
    this.canvas.width = Math.round(video.videoWidth * scale) & ~1; // encoders want even sizes
    this.canvas.height = Math.round(video.videoHeight * scale) & ~1;
    this.canvas.getContext('2d')!.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
    this.canvas.toBlob((blob) => {
      if (!blob) return;
      this.frames.push(blob);
      if (this.frames.length >= MAX_FRAMES) this.thin();
    }, 'image/jpeg', 0.75);
  }

  private thin(): void {
    this.frames = this.frames.filter((_, i) => i % 2 === 0);
    this.interval *= 2;
    if (!this.video) return;
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.capture(), this.interval);
  }

  async render(onProgress: (share: number) => void): Promise<File> {
    const format = FORMATS.find((f) => window.MediaRecorder?.isTypeSupported(f.type));
    if (!format) throw new Error('Este navegador no puede crear videos.');
    if (!this.frames.length) throw new Error('Todavía no hay imágenes grabadas.');

    const first = await createImageBitmap(this.frames[0]);
    const canvas = document.createElement('canvas');
    canvas.width = first.width;
    canvas.height = first.height;
    first.close();
    const ctx = canvas.getContext('2d')!;
    const fps = Math.max(MIN_FPS, Math.min(MAX_FPS, Math.round(this.frames.length / MIN_SECONDS)));
    const stream = canvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, { mimeType: format.type, videoBitsPerSecond: 5_000_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    const finished = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
    recorder.start();

    for (let i = 0; i < this.frames.length; i++) {
      const bitmap = await createImageBitmap(this.frames[i]);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      onProgress((i + 1) / this.frames.length);
      await wait(1000 / fps);
    }
    await wait(HOLD_LAST_FRAME_MS);
    recorder.stop();
    await finished;
    stream.getTracks().forEach((t) => t.stop());
    const type = format.type.split(';')[0];
    return new File(chunks, `time-lapse.${format.extension}`, { type });
  }
}
