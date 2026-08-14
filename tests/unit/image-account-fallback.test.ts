import test from "node:test";
import assert from "node:assert/strict";

const { runImageGenerationAccountLoop } =
  await import("../../src/lib/images/imageAccountFallback.ts");
const { checkFallbackError, parseRetryFromErrorText } =
  await import("../../open-sse/services/accountFallback.ts");
const { RateLimitReason } = await import("../../open-sse/config/constants.ts");

test("ChatGPT Plus image limit uses the advertised natural-language reset duration", () => {
  const text =
    "You've hit the Plus plan limit for image generations requests. " +
    "You can create more images when the limit resets in 11 hours and 37 minutes.";
  const expectedMs = (11 * 60 + 37) * 60 * 1000;

  assert.equal(parseRetryFromErrorText(text), expectedMs);
  const result = checkFallbackError(429, text, 0, null, "chatgpt-web");
  assert.equal(result.shouldFallback, true);
  assert.equal(result.reason, RateLimitReason.QUOTA_EXHAUSTED);
  assert.equal(result.cooldownMs, expectedMs);
});

test("image account loop excludes a quota-limited account and succeeds on the next account", async () => {
  const accounts = [{ connectionId: "account-a" }, { connectionId: "account-b" }];
  const calls: string[] = [];
  const marked: string[] = [];

  const outcome = await runImageGenerationAccountLoop({
    selectCredentials: async (excluded) =>
      accounts.find((account) => !excluded.includes(account.connectionId)) ?? null,
    execute: async (credentials) => {
      calls.push(credentials?.connectionId || "none");
      return credentials?.connectionId === "account-a"
        ? { success: false, status: 429, error: "Plus plan limit" }
        : { success: true, status: 200, data: { data: [{ url: "generated" }] } };
    },
    shouldRotate: (result) => result.status === 429,
    markUnavailable: async (credentials) => {
      marked.push(credentials.connectionId);
      return { shouldFallback: true };
    },
    clearRecoveredState: async () => {},
  });

  assert.equal(outcome.kind, "success");
  assert.deepEqual(calls, ["account-a", "account-b"]);
  assert.deepEqual(marked, ["account-a"]);
});

test("image account loop tries a sole quota-limited account only once", async () => {
  let postCount = 0;
  const outcome = await runImageGenerationAccountLoop({
    selectCredentials: async (excluded) =>
      excluded.includes("account-a") ? null : { connectionId: "account-a" },
    execute: async () => {
      postCount += 1;
      return { success: false, status: 429, error: "Plus plan limit" };
    },
    shouldRotate: (result) => result.status === 429,
    markUnavailable: async () => ({ shouldFallback: true }),
    clearRecoveredState: async () => {},
  });

  assert.equal(outcome.kind, "failure");
  assert.equal(outcome.result.status, 429);
  assert.equal(postCount, 1);
});

test("image account loop does not rotate on a non-quota retrieval failure", async () => {
  let postCount = 0;
  const outcome = await runImageGenerationAccountLoop({
    selectCredentials: async () => ({ connectionId: "account-a" }),
    execute: async () => {
      postCount += 1;
      return { success: false, status: 502, error: "image pointer unretrievable" };
    },
    shouldRotate: (result) => result.status === 429,
    markUnavailable: async () => {
      throw new Error("must not mark a non-quota failure");
    },
    clearRecoveredState: async () => {},
  });

  assert.equal(outcome.kind, "failure");
  assert.equal(outcome.result.status, 502);
  assert.equal(postCount, 1);
});
