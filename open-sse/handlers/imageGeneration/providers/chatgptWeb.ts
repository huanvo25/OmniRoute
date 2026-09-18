// Auto-extracted from open-sse/handlers/imageGeneration.ts in PR-#4582-batch
// Family: chatgpt-web | Module: chatgptWeb | Lines: 1102-1282 (181 LOC)
// Ref: see open-sse/handlers/imageGeneration.ts top-of-file comment for split rationale

import { ChatGptWebExecutor } from "../../../executors/chatgpt-web.ts";
import { getChatGptImage } from "../../../services/chatgptImageCache.ts";
import { saveImageErrorResult, saveImageSuccessResult } from "../../imageGeneration.ts";

export const CHATGPT_WEB_IMAGE_MARKDOWN_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;
export const CHATGPT_WEB_IMAGE_ID_RE =
  /\/v1\/chatgpt-web\/image\/([a-f0-9]{16,64})(?=[?\s"'<>)]|$)/i;
const CHATGPT_WEB_IMAGE_QUOTA_RE = /(?:plus|free) plan limit for image generations?\s+requests?/i;
const MAX_REFERENCE_IMAGES = 4;
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
const IMAGE_DATA_URL_RE = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i;
const CHATGPT_WEB_SENTINEL_RE = /sentinel|turnstile/i;
const CHATGPT_WEB_REFERENCE_UPLOAD_RE =
  /could not (?:prepare|upload|finalize) a reference image upload|rejected a reference image upload/i;

export function isRetryableChatGptWebImageAccountFailure(
  status: number,
  error: unknown
): boolean {
  const text = String(error || "");
  if (status === 401 || status === 429) return true;
  if (status === 403 && CHATGPT_WEB_SENTINEL_RE.test(text)) return true;
  return (
    (status === 401 || status === 403 || status === 429 || status >= 500) &&
    CHATGPT_WEB_REFERENCE_UPLOAD_RE.test(text)
  );
}

export function extractChatGptWebReferenceImages(body: Record<string, unknown>): {
  images: string[];
  error?: string;
} {
  const candidates: unknown[] = [body.image_url];
  if (Array.isArray(body.image_urls)) candidates.push(...body.image_urls);

  const images: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (typeof candidate !== "string") {
      return { images: [], error: "ChatGPT Web reference images must be base64 data URLs" };
    }

    const value = candidate.trim();
    if (!value || seen.has(value)) continue;
    const match = IMAGE_DATA_URL_RE.exec(value);
    if (!match) {
      return {
        images: [],
        error: "ChatGPT Web reference images must be PNG, JPEG, WEBP, or GIF base64 data URLs",
      };
    }

    const byteLength = Buffer.byteLength(match[2], "base64");
    if (byteLength === 0 || byteLength > MAX_REFERENCE_IMAGE_BYTES) {
      return {
        images: [],
        error: `Each ChatGPT Web reference image must be at most ${MAX_REFERENCE_IMAGE_BYTES / 1024 / 1024} MB`,
      };
    }
    totalBytes += byteLength;
    if (totalBytes > MAX_REFERENCE_IMAGE_TOTAL_BYTES) {
      return {
        images: [],
        error: `ChatGPT Web reference images must total at most ${MAX_REFERENCE_IMAGE_TOTAL_BYTES / 1024 / 1024} MB`,
      };
    }
    images.push(value);
    seen.add(value);
    if (images.length > MAX_REFERENCE_IMAGES) {
      return {
        images: [],
        error: `ChatGPT Web supports at most ${MAX_REFERENCE_IMAGES} reference images per generation`,
      };
    }
  }

  return { images };
}

export function extractMarkdownImageUrls(text: string): string[] {
  const urls: string[] = [];
  // String.prototype.matchAll consumes a fresh iterator and ignores the
  // regex's lastIndex, so no manual reset is required.
  for (const match of text.matchAll(CHATGPT_WEB_IMAGE_MARKDOWN_RE)) {
    if (match[1]) urls.push(match[1]);
  }
  return urls;
}

export function buildChatGptWebImagePrompt(body): string {
  const prompt = String(body.prompt || "").trim();
  const details: string[] = [`Create an image for this prompt: ${prompt}`];
  if (Array.isArray(body.reference_images) && body.reference_images.length > 0) {
    details.push(
      "Use the attached reference image(s) as visual context while following the prompt."
    );
  }
  if (typeof body.size === "string" && body.size.trim()) {
    details.push(`Requested size: ${body.size.trim()}.`);
  }
  if (typeof body.quality === "string" && body.quality.trim()) {
    details.push(`Requested quality: ${body.quality.trim()}.`);
  }
  if (typeof body.style === "string" && body.style.trim()) {
    details.push(`Requested style: ${body.style.trim()}.`);
  }
  return details.join("\n");
}

export function buildChatGptWebImageRequestArtifact(
  model: string,
  prompt: string,
  body: Record<string, unknown>
) {
  return {
    model,
    prompt,
    size: body.size || undefined,
    quality: body.quality || undefined,
  };
}

export async function handleChatGptWebImageGeneration({
  model,
  provider,
  body,
  credentials,
  log,
  signal,
  clientHeaders,
  // Injectable so unit tests can drive the handler without a live ChatGPT
  // session; production uses the real executor.
  executorFactory = () => new ChatGptWebExecutor(),
}) {
  const startTime = Date.now();
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return saveImageErrorResult({
      provider,
      model,
      status: 400,
      startTime,
      error: "Prompt is required for ChatGPT Web image generation",
    });
  }

  if (!credentials?.apiKey) {
    return saveImageErrorResult({
      provider,
      model,
      status: 401,
      startTime,
      error: "ChatGPT Web credentials missing session cookie",
    });
  }

  // Each image is one chatgpt.com chat turn (~30s). Cap at 4 (matches OpenAI's
  // own limit for GPT Image models) so a stray n=1000 doesn't pin the
  // executor for hours before the upstream HTTP timeout fires.
  const CHATGPT_WEB_IMAGE_N_MAX = 4;
  const rawCount = Number.isInteger(body.n) && (body.n as number) > 0 ? (body.n as number) : 1;
  if (rawCount > CHATGPT_WEB_IMAGE_N_MAX) {
    return saveImageErrorResult({
      provider,
      model,
      status: 400,
      startTime,
      error: `ChatGPT Web image generation supports n=1..${CHATGPT_WEB_IMAGE_N_MAX} (got ${rawCount}); each n is a separate ~30s chat turn.`,
    });
  }
  const requestedCount = rawCount;
  if (log && requestedCount > 1) {
    log.warn(
      "IMAGE",
      `ChatGPT Web returns one image per chat turn; requested n=${requestedCount} will run sequentially`
    );
  }

  const wantsBase64 = body.response_format === "b64_json";
  const referenceImages = extractChatGptWebReferenceImages(body);
  if (referenceImages.error) {
    return saveImageErrorResult({
      provider,
      model,
      status: 400,
      startTime,
      error: referenceImages.error,
    });
  }
  const images: Array<{ url?: string; b64_json?: string }> = [];
  const requestBody = buildChatGptWebImageRequestArtifact(model, prompt, body);

  for (let i = 0; i < requestedCount; i++) {
    const executor = executorFactory();
    const result = await executor.execute({
      model,
      body: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: buildChatGptWebImagePrompt({
                  ...body,
                  reference_images: referenceImages.images,
                }),
              },
              ...referenceImages.images.map((url) => ({
                type: "image_url",
                image_url: { url },
              })),
            ],
          },
        ],
      },
      stream: false,
      credentials,
      signal,
      log,
      clientHeaders,
    });

    const responseText = await result.response.text();
    if (result.response.status >= 400) {
      return saveImageErrorResult({
        provider,
        model,
        status: result.response.status,
        startTime,
        error: responseText,
        requestBody,
        retryable: isRetryableChatGptWebImageAccountFailure(
          result.response.status,
          responseText
        ),
      });
    }

    let content = "";
    let imageResolutionFailed = false;
    try {
      const json = JSON.parse(responseText);
      content = String(json?.choices?.[0]?.message?.content || "");
      imageResolutionFailed = json?.x_image_resolution_failed === true;
    } catch {
      content = responseText;
    }

    const urls = extractMarkdownImageUrls(content);
    if (urls.length === 0) {
      if (CHATGPT_WEB_IMAGE_QUOTA_RE.test(content)) {
        return saveImageErrorResult({
          provider,
          model,
          status: 429,
          startTime,
          error: content,
          requestBody,
          retryable: true,
        });
      }
      // Distinguish "image was generated upstream but OmniRoute could not
      // retrieve it" (executor flagged the unresolved asset pointer) from
      // "no image was produced at all" — the former is our bug/limitation,
      // not a failed prompt, so the message must not read as "no image made".
      const error = imageResolutionFailed
        ? `ChatGPT Web generated an image but OmniRoute could not retrieve it (the image asset could not be downloaded — the URL may have expired or ChatGPT changed its image delivery format). Please retry; if it persists, report it. Assistant text: ${content.slice(0, 200)}`
        : `ChatGPT Web completed without returning image markdown: ${content.slice(0, 300)}`;
      return saveImageErrorResult({
        provider,
        model,
        status: 502,
        startTime,
        error,
        requestBody,
      });
    }

    for (const url of urls) {
      if (!wantsBase64) {
        images.push({ url });
        continue;
      }
      const id = url.match(CHATGPT_WEB_IMAGE_ID_RE)?.[1];
      const cached = id ? getChatGptImage(id) : null;
      if (!cached) {
        return saveImageErrorResult({
          provider,
          model,
          status: 502,
          startTime,
          error: "ChatGPT Web image bytes expired before b64_json conversion",
          requestBody,
        });
      }
      images.push({ b64_json: cached.bytes.toString("base64") });
    }
  }

  return saveImageSuccessResult({
    provider,
    model,
    startTime,
    requestBody,
    responseBody: { images_count: images.length },
    images,
  });
}
