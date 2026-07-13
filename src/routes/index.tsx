import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Square, Upload, Volume2, Loader2, StopCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { encodeWav, readSse, PcmPlayer } from "@/lib/audio";
import { toast } from "sonner";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "VoiceBridge — Live AI Captions & Audio Transcription" },
      {
        name: "description",
        content:
          "Accessible AI transcription for deaf and hard-of-hearing users. Live microphone captions, audio file transcription, and text-to-speech playback.",
      },
      { property: "og:title", content: "VoiceBridge — AI Captions for Everyone" },
      {
        property: "og:description",
        content:
          "Turn any audio into text in real time. Built for accessibility with large controls, high contrast, and keyboard navigation.",
      },
    ],
  }),
  component: Home,
});

type Status = "idle" | "recording" | "transcribing" | "speaking";

function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [transcript, setTranscript] = useState("");
  const [partial, setPartial] = useState("");
  const [elapsed, setElapsed] = useState(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      playerRef.current?.close();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const transcribeBlob = useCallback(async (blob: Blob, filename: string) => {
    setStatus("transcribing");
    setPartial("");
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const fd = new FormData();
      fd.append("audio", blob, filename);

      const res = await fetch("/api/transcribe", {
        method: "POST",
        body: fd,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `Transcription failed (${res.status})`);
      }

      let acc = "";
      await readSse(res.body, (data) => {
        try {
          const evt = JSON.parse(data);
          if (evt.type === "transcript.text.delta" && evt.delta) {
            acc += evt.delta;
            setPartial(acc);
          } else if (evt.type === "transcript.text.done" && evt.text) {
            acc = evt.text;
          }
        } catch {
          /* ignore */
        }
      });

      setTranscript((prev) => (prev ? prev + " " : "") + acc);
      setPartial("");
      toast.success("Transcription complete");
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        toast.error((err as Error).message || "Transcription failed");
      }
    } finally {
      setStatus("idle");
      abortRef.current = null;
    }
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      nodeRef.current = node;
      chunksRef.current = [];

      node.onaudioprocess = (e) => {
        chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      src.connect(node);
      node.connect(ctx.destination);

      setStatus("recording");
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch {
      toast.error("Microphone access denied");
    }
  }, []);

  const stopRecording = useCallback(async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const ctx = audioCtxRef.current;
    const node = nodeRef.current;
    const stream = streamRef.current;
    node?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    if (!ctx) return;
    const sampleRate = ctx.sampleRate;
    await ctx.close();
    audioCtxRef.current = null;
    nodeRef.current = null;
    streamRef.current = null;

    const wav = encodeWav(chunksRef.current, sampleRate);
    chunksRef.current = [];
    if (wav.size < 2048) {
      toast.error("Recording was too short — please try again");
      setStatus("idle");
      return;
    }
    await transcribeBlob(wav, "recording.wav");
  }, [transcribeBlob]);

  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      if (file.size > 24 * 1024 * 1024) {
        toast.error("File too large (max 24MB)");
        return;
      }
      await transcribeBlob(file, file.name);
    },
    [transcribeBlob],
  );

  const speak = useCallback(async () => {
    const text = transcript.trim();
    if (!text) return;
    playerRef.current?.close();
    const player = new PcmPlayer(24000);
    playerRef.current = player;
    await player.resume();

    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("speaking");

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice: "alloy" }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `TTS failed (${res.status})`);
      }
      await readSse(res.body, (data) => {
        try {
          const evt = JSON.parse(data);
          if (evt.type === "speech.audio.delta" && evt.audio) {
            const bin = atob(evt.audio);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            player.push(bytes);
          }
        } catch {
          /* ignore */
        }
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        toast.error((err as Error).message || "Playback failed");
      }
    } finally {
      setStatus("idle");
      abortRef.current = null;
    }
  }, [transcript]);

  const stopEverything = useCallback(() => {
    abortRef.current?.abort();
    playerRef.current?.close();
    playerRef.current = null;
    setStatus("idle");
  }, []);

  const isRecording = status === "recording";
  const isBusy = status === "transcribing" || status === "speaking";

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto max-w-4xl px-6 py-6">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            VoiceBridge
          </h1>
          <p className="mt-2 text-lg text-muted-foreground">
            AI captions and audio-to-text, built for accessibility.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        {/* Controls */}
        <section
          aria-label="Recording controls"
          className="rounded-2xl border border-border bg-card p-6 shadow-sm"
        >
          <div className="flex flex-wrap items-center gap-4">
            {!isRecording ? (
              <Button
                onClick={startRecording}
                disabled={isBusy}
                size="lg"
                className="min-h-14 min-w-44 text-lg"
                aria-label="Start recording from microphone"
              >
                <Mic className="mr-2 size-6" aria-hidden />
                Start recording
              </Button>
            ) : (
              <Button
                onClick={stopRecording}
                size="lg"
                variant="destructive"
                className="min-h-14 min-w-44 text-lg"
                aria-label="Stop recording and transcribe"
              >
                <Square className="mr-2 size-6" aria-hidden />
                Stop &amp; transcribe
              </Button>
            )}

            <label className="inline-flex">
              <input
                type="file"
                accept="audio/*"
                onChange={onFile}
                disabled={isBusy || isRecording}
                className="sr-only"
                aria-label="Upload an audio file to transcribe"
              />
              <span
                className={`inline-flex min-h-14 cursor-pointer items-center rounded-md border border-input bg-background px-6 text-lg font-medium hover:bg-accent ${
                  isBusy || isRecording ? "pointer-events-none opacity-50" : ""
                }`}
              >
                <Upload className="mr-2 size-6" aria-hidden />
                Upload audio file
              </span>
            </label>

            {isBusy && (
              <Button
                onClick={stopEverything}
                variant="outline"
                size="lg"
                className="min-h-14 text-lg"
                aria-label="Cancel current operation"
              >
                <StopCircle className="mr-2 size-6" aria-hidden />
                Cancel
              </Button>
            )}
          </div>

          {/* Status line */}
          <div
            role="status"
            aria-live="polite"
            className="mt-4 flex items-center gap-3 text-base text-muted-foreground"
          >
            {status === "idle" && (
              <span>Ready. Press start, or upload a file.</span>
            )}
            {status === "recording" && (
              <>
                <span className="inline-block size-3 animate-pulse rounded-full bg-destructive" />
                <span>
                  Recording… {Math.floor(elapsed / 60)}:
                  {String(elapsed % 60).padStart(2, "0")}
                </span>
              </>
            )}
            {status === "transcribing" && (
              <>
                <Loader2 className="size-5 animate-spin" aria-hidden />
                <span>Transcribing with AI…</span>
              </>
            )}
            {status === "speaking" && (
              <>
                <Volume2 className="size-5" aria-hidden />
                <span>Playing transcript…</span>
              </>
            )}
          </div>
        </section>

        {/* Transcript */}
        <section
          aria-label="Live transcript"
          className="mt-6 rounded-2xl border border-border bg-card p-6 shadow-sm"
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">Transcript</h2>
            <div className="flex gap-2">
              <Button
                onClick={speak}
                disabled={!transcript || isBusy || isRecording}
                variant="secondary"
                className="min-h-11"
                aria-label="Read transcript aloud"
              >
                <Volume2 className="mr-2 size-5" aria-hidden />
                Read aloud
              </Button>
              <Button
                onClick={() => setTranscript("")}
                disabled={!transcript || isBusy || isRecording}
                variant="outline"
                className="min-h-11"
                aria-label="Clear transcript"
              >
                Clear
              </Button>
            </div>
          </div>

          <div
            aria-live="polite"
            aria-atomic="false"
            className="min-h-52 whitespace-pre-wrap rounded-lg border border-border bg-background p-5 text-xl leading-relaxed"
          >
            {transcript}
            {partial && (
              <span className="text-muted-foreground">
                {transcript ? " " : ""}
                {partial}
              </span>
            )}
            {!transcript && !partial && (
              <span className="text-muted-foreground">
                Your captions will appear here as words are recognized.
              </span>
            )}
          </div>
        </section>

        <footer className="mt-10 text-center text-sm text-muted-foreground">
          <p>
            Powered by Lovable AI (OpenAI gpt-4o-transcribe &amp; gpt-4o-mini-tts).
            Audio is processed securely and not stored.
          </p>
        </footer>
      </main>
    </div>
  );
}
