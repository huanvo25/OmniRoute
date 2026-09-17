import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-image-account-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const { runImageGenerationAccountLoop, shouldRotateChatGptWebImageAccount } =
  await import("../../src/lib/images/imageAccountFallback.ts");

const provider = "chatgpt-web";
const model = "chatgpt-web/gpt-5.5";

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedConnection(name: string, priority: number) {
  return providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name,
    apiKey: `test-${name}`,
    priority,
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
}

test.beforeEach(resetStorage);

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("image account route loop cools a Sentinel-blocked account and selects the next account", async () => {
  const first = await seedConnection("image-account-a", 1);
  const second = await seedConnection("image-account-b", 2);
  const selected: string[] = [];
  const marked: Array<{ connectionId: string; status: number | undefined }> = [];

  const outcome = await runImageGenerationAccountLoop({
    selectCredentials: (excludeConnectionIds) =>
      auth.getProviderCredentialsWithQuotaPreflight(provider, null, null, model, {
        excludeConnectionIds,
      }),
    execute: async (credentials) => {
      selected.push(credentials?.connectionId || "none");
      return credentials?.connectionId === first.id
        ? {
            success: false,
            status: 403,
            error: "ChatGPT blocked the request (Sentinel/Turnstile required).",
          }
        : { success: true, status: 200, data: { data: [{ url: "generated" }] } };
    },
    shouldRotate: shouldRotateChatGptWebImageAccount,
    markUnavailable: async (credentials, result) => {
      marked.push({ connectionId: credentials.connectionId!, status: result.status });
      return auth.markAccountUnavailable(
        credentials.connectionId!,
        result.status!,
        String(result.error),
        provider,
        model
      );
    },
    clearRecoveredState: auth.clearRecoveredProviderState,
  });

  assert.equal(outcome.kind, "success");
  assert.equal(outcome.credentials?.connectionId, second.id);
  assert.deepEqual(selected, [first.id, second.id]);
  assert.deepEqual(marked, [{ connectionId: first.id, status: 403 }]);

  const firstAfter = await providersDb.getProviderConnectionById(first.id);
  const secondAfter = await providersDb.getProviderConnectionById(second.id);
  assert.equal(firstAfter?.testStatus, "unavailable");
  assert.equal(Number(firstAfter?.errorCode), 403);
  assert.ok(Date.parse(firstAfter?.rateLimitedUntil || "") > Date.now());
  assert.equal(secondAfter?.testStatus, "active");
});

test("image account route loop does not cool or retry a generic 502", async () => {
  const first = await seedConnection("image-account-a", 1);
  await seedConnection("image-account-b", 2);
  const selected: string[] = [];
  let markCount = 0;

  const outcome = await runImageGenerationAccountLoop({
    selectCredentials: (excludeConnectionIds) =>
      auth.getProviderCredentialsWithQuotaPreflight(provider, null, null, model, {
        excludeConnectionIds,
      }),
    execute: async (credentials) => {
      selected.push(credentials?.connectionId || "none");
      return {
        success: false,
        status: 502,
        error: "image pointer unretrievable",
      };
    },
    shouldRotate: shouldRotateChatGptWebImageAccount,
    markUnavailable: async () => {
      markCount += 1;
      return { shouldFallback: true };
    },
    clearRecoveredState: auth.clearRecoveredProviderState,
  });

  assert.equal(outcome.kind, "failure");
  assert.equal(outcome.result.status, 502);
  assert.deepEqual(selected, [first.id]);
  assert.equal(markCount, 0);

  const firstAfter = await providersDb.getProviderConnectionById(first.id);
  assert.equal(firstAfter?.rateLimitedUntil ?? null, null);
  assert.equal(firstAfter?.testStatus, "active");
});
