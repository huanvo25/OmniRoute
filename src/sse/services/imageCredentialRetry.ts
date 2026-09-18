import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

import { getProviderCredentialsWithQuotaPreflight, markAccountUnavailable } from "./auth";
import { checkAndRefreshToken } from "./tokenRefresh";
import * as log from "../utils/logger";

interface ImageGenerationResult {
  success: boolean;
  status?: number;
  error?: unknown;
  data?: unknown;
  // #10494: opt-in signal a provider handler can set (via
  // saveImageErrorResult's `retryable` option) when a non-401 failure is
  // still account/session-specific — e.g. an expired or blocked Gemini Web
  // session, which the underlying browser-automation executor surfaces as
  // 400/500 rather than 401. Only honored together with a connectionId, same
  // as the existing 401 path, so providers that never set it keep the
  // original 401-only fallback behavior unchanged.
  retryable?: boolean;
}

interface ImageCredentialRetryOptions {
  provider: string;
  requestedModel: string | null;
  credentials: any;
  execute: (credentials: any) => Promise<ImageGenerationResult>;
  // Injectable so unit tests can drive multi-account fallback deterministically
  // without a live DB-backed credential store; production always uses the real
  // getProviderCredentialsWithQuotaPreflight-backed selectNextCredentials below.
  selectNextCredentials?: (
    provider: string,
    requestedModel: string | null,
    excludedConnectionIds: Set<string>
  ) => Promise<any>;
}

interface ImageCredentialRetryResult {
  credentials: any;
  result: ImageGenerationResult;
}

function connectionIdOf(credentials: any): string | null {
  const connectionId = credentials?.connectionId;
  return typeof connectionId === "string" && connectionId.trim().length > 0
    ? connectionId.trim()
    : null;
}

function isCredentialSentinel(credentials: any): boolean {
  return Boolean(credentials?.allRateLimited || credentials?.allExpired);
}

const CHATGPT_WEB_SENTINEL_RE = /sentinel|turnstile/i;

function isChatGptWebImageQuotaFailure(provider: string, result: ImageGenerationResult): boolean {
  if (provider !== "chatgpt-web" || Number(result.status) !== 429) return false;
  // Registration/upload endpoints can return a plain 429 without the image
  // quota sentence used by the conversation endpoint. It is still an account
  // cooldown and must be persisted instead of immediately selecting the same
  // connection for the next batch item.
  return true;
}

function isChatGptWebSentinelFailure(
  provider: string,
  result: ImageGenerationResult
): boolean {
  return (
    provider === "chatgpt-web" &&
    Number(result.status) === 403 &&
    CHATGPT_WEB_SENTINEL_RE.test(String(result.error || ""))
  );
}

async function defaultSelectNextCredentials(
  provider: string,
  requestedModel: string | null,
  excludedConnectionIds: Set<string>
) {
  return getProviderCredentialsWithQuotaPreflight(provider, null, null, requestedModel, {
    excludeConnectionIds: Array.from(excludedConnectionIds),
  });
}

/**
 * Keep image requests on the same credential lifecycle as chat requests.
 *
 * Each connection is attempted at most once. A refresh failure or upstream 401
 * excludes only that connection for the current request; it does not mutate the
 * account into a terminal state because another request may refresh it normally.
 */
export async function executeImageWithCredentialFallback({
  provider,
  requestedModel,
  credentials,
  execute,
  selectNextCredentials = defaultSelectNextCredentials,
}: ImageCredentialRetryOptions): Promise<ImageCredentialRetryResult> {
  // Local/no-auth image providers intentionally have no credential row. They
  // still need one direct attempt, but there is no account identity to refresh
  // or rotate after a 401.
  if (!credentials) {
    return { credentials, result: await execute(credentials) };
  }

  const excludedConnectionIds = new Set<string>();
  let currentCredentials = credentials;
  let lastCredentials = credentials;
  let lastResult: ImageGenerationResult | null = null;

  while (currentCredentials && !isCredentialSentinel(currentCredentials)) {
    const connectionId = connectionIdOf(currentCredentials);
    if (connectionId && excludedConnectionIds.has(connectionId)) break;
    if (connectionId) excludedConnectionIds.add(connectionId);

    try {
      currentCredentials = await checkAndRefreshToken(provider, currentCredentials);
    } catch (error) {
      log.warn("IMAGE", "Credential refresh failed; trying another image-provider account", {
        provider,
        connectionId,
        error: sanitizeErrorMessage(error instanceof Error ? error : new Error(String(error))),
      });
      if (!connectionId) throw error;
      currentCredentials = await selectNextCredentials(
        provider,
        requestedModel,
        excludedConnectionIds
      );
      continue;
    }

    lastCredentials = currentCredentials;
    lastResult = await execute(currentCredentials);
    const isAuthFailure = Number(lastResult.status) === 401 || lastResult.retryable === true;
    const isQuotaFailure = isChatGptWebImageQuotaFailure(provider, lastResult);
    const isSentinelFailure = isChatGptWebSentinelFailure(provider, lastResult);
    const isChatGptWebAccountFailure =
      provider === "chatgpt-web" &&
      lastResult.retryable === true &&
      Number(lastResult.status) !== 401;
    if (
      lastResult.success ||
      (!isAuthFailure && !isQuotaFailure && !isSentinelFailure) ||
      !connectionId
    ) {
      return { credentials: lastCredentials, result: lastResult };
    }

    if (isQuotaFailure || isSentinelFailure || isChatGptWebAccountFailure) {
      await markAccountUnavailable(
        connectionId,
        // Sentinel is an account-scoped, temporary WAF block. Classify it as
        // a rate-limit cooldown so the connection stays excluded until the
        // persisted timer expires instead of being selected again immediately.
        isSentinelFailure || Number(lastResult.status) === 403
          ? 429
          : Number(lastResult.status) || 502,
        String(
          lastResult.error ||
            (isSentinelFailure
              ? "ChatGPT Web Sentinel/Turnstile blocked this account"
              : "ChatGPT Web image quota exhausted")
        ),
        provider,
        requestedModel
      );
    }

    log.warn("IMAGE", "Image provider rejected credentials; trying another account", {
      provider,
      connectionId,
    });
    currentCredentials = await selectNextCredentials(
      provider,
      requestedModel,
      excludedConnectionIds
    );
  }

  return {
    credentials: lastCredentials,
    result: lastResult || {
      success: false,
      status: 401,
      error: "Authentication failed for all eligible image-provider accounts",
    },
  };
}
