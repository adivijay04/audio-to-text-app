import { createFileRoute } from "@tanstack/react-router";

// POST /api/transcribe
// Accepts multipart/form-data with an `audio` file (WAV/MP3/M4A/WEBM).
// Forwards to Lovable AI Gateway's OpenAI-compatible transcription endpoint
// with stream=true, and pipes the SSE body straight back to the browser.
export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env.LOVABLE_API_KEY;
        if (!apiKey) {
          return new Response("Server misconfigured: LOVABLE_API_KEY missing", {
            status: 500,
          });
        }

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return new Response("Expected multipart/form-data", { status: 400 });
        }

        const audio = form.get("audio");
        if (!(audio instanceof Blob) || audio.size === 0) {
          return new Response("Missing or empty 'audio' file", { status: 400 });
        }
        if (audio.size > 24 * 1024 * 1024) {
          return new Response("Audio too large (max 24MB)", { status: 413 });
        }

        // Choose model: default to accuracy for accessibility use.
        const model =
          (form.get("model") as string | null) ?? "openai/gpt-4o-transcribe";

        // Preserve extension so provider infers format correctly.
        const mime = audio.type || "audio/wav";
        const extMap: Record<string, string> = {
          "audio/wav": "wav",
          "audio/wave": "wav",
          "audio/x-wav": "wav",
          "audio/mpeg": "mp3",
          "audio/mp3": "mp3",
          "audio/mp4": "mp4",
          "audio/m4a": "m4a",
          "audio/x-m4a": "m4a",
          "audio/webm": "webm",
          "audio/ogg": "ogg",
        };
        const ext = extMap[mime.split(";")[0]] ?? "wav";

        const upstream = new FormData();
        upstream.append("file", audio, `recording.${ext}`);
        upstream.append("model", model);
        upstream.append("stream", "true");

        const res = await fetch(
          "https://ai.gateway.lovable.dev/v1/audio/transcriptions",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: upstream,
          },
        );

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          return new Response(
            `Transcription failed (${res.status}): ${detail || res.statusText}`,
            { status: res.status },
          );
        }

        return new Response(res.body, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
          },
        });
      },
    },
  },
});
