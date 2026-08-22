// "Describe this video": grab ONE frame from a live MediaStream, send it to
// Claude as an image, and return a short spoken-style description in the UI
// language. The API key is the user's own (kept in this browser's localStorage,
// never sent to the SonicRoom server); the request goes straight from the
// browser to the Claude API. The SDK is dynamically imported so it's only ever
// loaded in a video room, and only when someone actually asks for a description.
import type Anthropic from "@anthropic-ai/sdk";
import { LOCALE_NAMES, type Locale } from "../i18n";

export type DescribeSubject = "self" | "camera" | "screen";

export type DescribeErrorCode = "no_key" | "no_frame" | "auth" | "rate_limited" | "network" | "other";

export class DescribeError extends Error {
  constructor(
    readonly code: DescribeErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "DescribeError";
  }
}

// Longest side of the snapshot we send. Plenty for a face / a shared screen's
// text, small enough to keep the request quick and cheap.
export const SNAPSHOT_MAX_SIDE = 1024;

export const DESCRIBE_MODEL = "claude-opus-5";

// The prompt is deliberately about ONE still frame of a video call, for someone
// who can't see it: brief, concrete, text transcribed verbatim, no guessing at
// identities. `language` is the UI language's native name (e.g. "Español") so
// the answer matches the language the app is open in.
export function buildDescribePrompt(language: string, subject: DescribeSubject): string {
  const what =
    subject === "screen"
      ? "a participant's shared screen"
      : subject === "self"
        ? "the user's own webcam"
        : "another participant's webcam";
  return [
    `You are describing a single still frame taken from ${what} during a live video call, for a blind or low-vision participant.`,
    `Answer in ${language}.`,
    "Be brief: 2 to 4 short sentences. Lead with what matters most — the people (count, rough appearance, expression, what they are doing), then the setting, then anything notable.",
    subject === "screen"
      ? "For a shared screen, say what kind of content it is (slides, code, a document, a website, a video…) and summarise it, then transcribe any readable text verbatim."
      : "If any text is readable (signs, a whiteboard, a shirt, a screen in view), transcribe it verbatim after the description.",
    "Do not guess who people are by name. If the frame is black, empty or too dark/blurry to describe, say so plainly.",
    "No preamble, no headings, no markdown — plain sentences only.",
  ].join(" ");
}

// Paint the stream's current frame onto a canvas and return it as base64 JPEG.
// Uses its own off-screen <video> so it never touches the visible tiles.
export async function captureFrame(
  stream: MediaStream,
  maxSide: number = SNAPSHOT_MAX_SIDE,
): Promise<{ data: string; mediaType: "image/jpeg" }> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play().catch(() => {});
    // Wait for real dimensions (the first frame) — bounded so a dead stream
    // can't hang the request.
    const deadline = Date.now() + 3000;
    while (video.videoWidth === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) throw new DescribeError("no_frame");
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new DescribeError("no_frame");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return { data: dataUrl.slice(dataUrl.indexOf(",") + 1), mediaType: "image/jpeg" };
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

export function languageName(locale: Locale): string {
  return LOCALE_NAMES[locale] ?? locale;
}

// Ask Claude for the description. Errors are normalised to DescribeError codes
// so the caller can pick a localized message.
export async function describeFrame(opts: {
  apiKey: string;
  frame: { data: string; mediaType: "image/jpeg" };
  locale: Locale;
  subject: DescribeSubject;
}): Promise<string> {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) throw new DescribeError("no_key");
  const { default: AnthropicSdk } = await import("@anthropic-ai/sdk");
  // Browser-side on purpose: the key is the user's own and lives in THEIR
  // browser; routing it through our server would only widen its exposure.
  const client: Anthropic = new AnthropicSdk({ apiKey, dangerouslyAllowBrowser: true });
  try {
    const response = await client.messages.create({
      model: DESCRIBE_MODEL,
      max_tokens: 1024,
      system: buildDescribePrompt(languageName(opts.locale), opts.subject),
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: opts.frame.mediaType, data: opts.frame.data },
            },
            { type: "text", text: "Describe this frame." },
          ],
        },
      ],
    });
    if (response.stop_reason === "refusal") {
      throw new DescribeError("other", response.stop_details?.explanation ?? undefined);
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join(" ");
    if (!text) throw new DescribeError("other");
    return text;
  } catch (err) {
    if (err instanceof DescribeError) throw err;
    if (err instanceof AnthropicSdk.AuthenticationError) throw new DescribeError("auth");
    if (err instanceof AnthropicSdk.RateLimitError) throw new DescribeError("rate_limited");
    if (err instanceof AnthropicSdk.APIConnectionError) throw new DescribeError("network");
    if (err instanceof AnthropicSdk.APIError) throw new DescribeError("other", err.message);
    throw new DescribeError("other", err instanceof Error ? err.message : undefined);
  }
}
