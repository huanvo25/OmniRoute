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
};

type LoopOutcome<C extends Credentials, R extends ImageResult> =
  | { kind: "success"; credentials: C | null; result: R }
  | { kind: "failure"; credentials: C | null; result: R }
  | { kind: "all_rate_limited"; credentials: C }
  | { kind: "no_credentials" };

export async function runImageGenerationAccountLoop<C extends Credentials, R extends ImageResult>({
  selectCredentials,
  execute,
  shouldRotate,
  markUnavailable,
  clearRecoveredState,
}: {
  selectCredentials: (excludedConnectionIds: string[]) => Promise<C | null>;
  execute: (credentials: C | null) => Promise<R>;
  shouldRotate: (result: R, credentials: C | null) => boolean;
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
    if (!connectionId || !shouldRotate(result, credentials)) {
      return { kind: "failure", credentials, result };
    }

    const fallback = await markUnavailable(credentials, result);
    excludedConnectionIds.add(connectionId);
    if (!fallback.shouldFallback) {
      return { kind: "failure", credentials, result };
    }
  }
}
