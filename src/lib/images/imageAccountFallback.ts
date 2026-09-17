type Credentials = {
  connectionId?: string | null;
  allRateLimited?: boolean;
  retryAfter?: string;
  retryAfterHuman?: string;
};

type ImageResult = {
  success: boolean;
  status?: number;
  error?: unknown;
  /**
   * False when an earlier turn in this request may already have created an
   * image. In that case a cross-account replay would create a duplicate.
   */
  retrySafe?: boolean;
};

const CHATGPT_WEB_SESSION_BLOCK_RE =
  /\b(?:sentinel|turnstile|cloudflare|cf[- ]?challenge|challenge required)\b/i;
const CHATGPT_WEB_IMAGE_QUOTA_RE =
  /\b(?:(?:plus|free) plan limit for image generations?|image generations? (?:limit|quota)|image (?:generation|creation) limit (?:has been )?(?:reached|exceeded)|you(?:'|’)ve hit (?:your )?image (?:generation|creation) limit)\b/i;

function imageErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * ChatGPT Web image quota and browser-session challenges are account-scoped.
 * Rotate only for those explicit signals: generic 5xx/image-retrieval errors
 * may happen after an image was already created, so replaying them can produce
 * a duplicate image and consume quota twice.
 */
export function shouldRotateChatGptWebImageAccount(result: ImageResult): boolean {
  // A ChatGPT Web request can contain multiple sequential chat turns when
  // `n > 1`. Once one turn has returned an image, replaying the whole request
  // on another account would bill/create that image again. The provider
  // handler explicitly marks this case as unsafe, so account rotation is
  // deliberately limited to failures before any image was returned.
  if (result.retrySafe === false) return false;
  if (result.status === 429) return true;
  if (result.status !== 403) return false;
  const errorText = imageErrorText(result.error);
  return CHATGPT_WEB_SESSION_BLOCK_RE.test(errorText) || CHATGPT_WEB_IMAGE_QUOTA_RE.test(errorText);
}

/** True for an account-scoped ChatGPT Web image failure, even when the request
 * must not be replayed because an earlier `n` turn already produced an image. */
export function shouldCoolChatGptWebImageAccount(result: ImageResult): boolean {
  if (result.status === 429) return true;
  if (result.status !== 403) return false;
  const errorText = imageErrorText(result.error);
  return CHATGPT_WEB_SESSION_BLOCK_RE.test(errorText) || CHATGPT_WEB_IMAGE_QUOTA_RE.test(errorText);
}

type LoopOutcome<C extends Credentials, R extends ImageResult> =
  | { kind: "success"; credentials: C | null; result: R }
  | { kind: "failure"; credentials: C | null; result: R }
  | { kind: "all_rate_limited"; credentials: C }
  | { kind: "no_credentials" };

export async function runImageGenerationAccountLoop<C extends Credentials, R extends ImageResult>({
  selectCredentials,
  execute,
  shouldRotate,
  shouldMarkUnavailable = shouldRotate,
  markUnavailable,
  clearRecoveredState,
}: {
  selectCredentials: (excludedConnectionIds: string[]) => Promise<C | null>;
  execute: (credentials: C | null) => Promise<R>;
  shouldRotate: (result: R, credentials: C | null) => boolean;
  /** Account-scoped failure classifier. May be broader than shouldRotate when
   * the request cannot safely be replayed but the account still needs cooling. */
  shouldMarkUnavailable?: (result: R, credentials: C | null) => boolean;
  markUnavailable: (credentials: C, result: R) => Promise<{ shouldFallback: boolean }>;
  clearRecoveredState: (credentials: C | null) => Promise<void>;
}): Promise<LoopOutcome<C, R>> {
  const excludedConnectionIds = new Set<string>();
  let lastFailure: { credentials: C | null; result: R } | null = null;

  while (true) {
    const credentials = await selectCredentials(Array.from(excludedConnectionIds));
    if (!credentials) {
      return lastFailure ? { kind: "failure", ...lastFailure } : { kind: "no_credentials" };
    }
    if (credentials.allRateLimited) {
      return { kind: "all_rate_limited", credentials };
    }

    const connectionId = credentials.connectionId?.trim() || null;
    if (connectionId && excludedConnectionIds.has(connectionId)) {
      return lastFailure ? { kind: "failure", ...lastFailure } : { kind: "no_credentials" };
    }

    const result = await execute(credentials);
    if (result.success) {
      await clearRecoveredState(credentials);
      return { kind: "success", credentials, result };
    }

    lastFailure = { credentials, result };
    if (!connectionId || !shouldMarkUnavailable(result, credentials)) {
      return { kind: "failure", credentials, result };
    }

    const fallback = await markUnavailable(credentials, result);
    if (!shouldRotate(result, credentials)) {
      return { kind: "failure", credentials, result };
    }
    excludedConnectionIds.add(connectionId);
    if (!fallback.shouldFallback) {
      return { kind: "failure", credentials, result };
    }
  }
}
