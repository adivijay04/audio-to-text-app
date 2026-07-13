import { createFileRoute } from "@tanstack/react-router";

// POST /api/tts  { text: string, voice?: string }
// Streams SSE audio deltas from Lovable AI Gateway TTS back to the browser.
// The client decodes base64 PCM chunks and plays them via Web Audio.
export const Route = createFileRoute("/api/tts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env.LOVABLE_API_KEY;
        if (!apiKey) {
          return new Response("Server misconfigured: LOVABLE_API_KEY missing", {
            status: 500,
          });
        }

        let body: { text?: string; voice?: string };
        try {
          body = await request.json();
        } catch {
          return new Response("Invalid JSON body", { status: 400 });
        }

        const text = (body.text ?? "").trim();
        if (!text) return new Response("Missing 'text'", { status: 400 });
        if (text.length > 4000) {
          return new Response("Text too long (max 4000 chars)", { status: 400 });
        }
        const voice = body.voice ?? "alloy";

        const res = await fetch(
          "https://ai.gateway.lovable.dev/v1/audio/speech",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "openai/gpt-4o-mini-tts",
              input: text,
              voice,
              stream_format: "sse",
              response_format: "pcm",
            }),
          },
        );

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          return new Response(
            `TTS failed (${res.status}): ${detail || res.statusText}`,
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
