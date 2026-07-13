// Client-side audio helpers: mic capture -> WAV encoding, PCM playback,
// and a tiny SSE line parser. All browser-only.

export function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const totalLength = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }

  // Downsample to 16kHz mono for smaller uploads (STT works great at 16k).
  const targetRate = 16000;
  const ratio = sampleRate / targetRate;
  const downLen = Math.floor(merged.length / ratio);
  const down = new Float32Array(downLen);
  for (let i = 0; i < downLen; i++) {
    down[i] = merged[Math.floor(i * ratio)];
  }

  const buffer = new ArrayBuffer(44 + down.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + down.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, down.length * 2, true);

  let o = 44;
  for (let i = 0; i < down.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, down[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

// Parse an SSE stream and call onEvent for every `data:` payload.
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (data: string) => void,
): Promise<void> {
  const reader = (body as ReadableStream<Uint8Array>)
    .pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>)
    .getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) onEvent(line.slice(5).trim());
    }
  }
  const tail = buf.trim();
  if (tail.startsWith("data:")) onEvent(tail.slice(5).trim());
}

// Streaming PCM (24kHz mono int16 little-endian) player for TTS deltas.
export class PcmPlayer {
  private ctx: AudioContext;
  private playhead = 0;
  private pending = new Uint8Array(0);

  constructor(sampleRate = 24000) {
    this.ctx = new AudioContext({ sampleRate });
  }

  async resume() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  push(bytes: Uint8Array) {
    const merged = new Uint8Array(this.pending.length + bytes.length);
    merged.set(this.pending);
    merged.set(bytes, this.pending.length);
    const usable = merged.length - (merged.length % 2);
    this.pending = merged.slice(usable);
    if (usable === 0) return;

    const samples = new Int16Array(merged.buffer, 0, usable / 2);
    const floats = Float32Array.from(samples, (s) => s / 32768);
    const buf = this.ctx.createBuffer(1, floats.length, this.ctx.sampleRate);
    buf.copyToChannel(floats, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    if (this.playhead === 0) this.playhead = this.ctx.currentTime + 0.05;
    else this.playhead = Math.max(this.playhead, this.ctx.currentTime);
    src.start(this.playhead);
    this.playhead += buf.duration;
  }

  async close() {
    try {
      await this.ctx.close();
    } catch {
      /* ignore */
    }
  }
}
