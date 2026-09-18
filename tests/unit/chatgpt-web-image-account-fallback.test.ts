import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-chatgpt-image-fallback-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { executeImageWithCredentialFallback } = await import(
  "../../src/sse/services/imageCredentialRetry.ts"
);

test.after(() => {
  core.resetDbInstance();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function readState(id: string) {
  const db = core.getDbInstance() as unknown as {
    prepare: (sql: string) => {
      get: (id: string) => {
        test_status: string | null;
        rate_limited_until: string | null;
        error_code: number | null;
      };
    };
  };
  return db
    .prepare(
      "SELECT test_status, rate_limited_until, error_code FROM provider_connections WHERE id = ?"
    )
    .get(id);
}

async function createConnection(name: string) {
  const connection = await providersDb.createProviderConnection({
    provider: "chatgpt-web",
    authType: "apikey",
    name,
    apiKey: `${name}-cookie`,
  });
  return { connectionId: (connection as { id: string }).id, apiKey: `${name}-cookie` };
}

test("Sentinel-blocked image account is cooled down and the next account succeeds", async () => {
  const accountA = await createConnection("sentinel-a");
  const accountB = await createConnection("sentinel-b");
  const attempts: string[] = [];

  const execution = await executeImageWithCredentialFallback({
    provider: "chatgpt-web",
    requestedModel: "gpt-5.5",
    credentials: accountA,
    execute: async (credentials) => {
      attempts.push(credentials.connectionId);
      if (credentials.connectionId === accountA.connectionId) {
        return {
          success: false,
          status: 403,
          error: "ChatGPT blocked the request (Sentinel/Turnstile required)",
          retryable: true,
        };
      }
      return { success: true, data: { data: [{ b64_json: "ok" }] } };
    },
    selectNextCredentials: async () => accountB,
  });

  assert.deepEqual(attempts, [accountA.connectionId, accountB.connectionId]);
  assert.equal(execution.result.success, true);
  const state = readState(accountA.connectionId);
  assert.equal(state.test_status, "unavailable");
  assert.equal(Number(state.error_code), 429);
  assert.ok(new Date(state.rate_limited_until || 0).getTime() > Date.now());
});

test("reference-upload failure cools the account down and rotates, generic 502 does not", async () => {
  const accountA = await createConnection("upload-a");
  const accountB = await createConnection("upload-b");

  const execution = await executeImageWithCredentialFallback({
    provider: "chatgpt-web",
    requestedModel: "gpt-5.5",
    credentials: accountA,
    execute: async (credentials) =>
      credentials.connectionId === accountA.connectionId
        ? {
            success: false,
            status: 502,
            error: "ChatGPT Web could not prepare a reference image upload",
            retryable: true,
          }
        : { success: true, data: { data: [{ b64_json: "ok" }] } },
    selectNextCredentials: async () => accountB,
  });

  assert.equal(execution.result.success, true);
  const state = readState(accountA.connectionId);
  assert.equal(state.test_status, "unavailable");
  assert.equal(Number(state.error_code), 502);
  assert.ok(new Date(state.rate_limited_until || 0).getTime() > Date.now());

  let selectedNext = false;
  const generic = await executeImageWithCredentialFallback({
    provider: "chatgpt-web",
    requestedModel: "gpt-5.5",
    credentials: accountB,
    execute: async () => ({ success: false, status: 502, error: "generic network failure" }),
    selectNextCredentials: async () => {
      selectedNext = true;
      return null;
    },
  });
  assert.equal(generic.result.success, false);
  assert.equal(selectedNext, false);
});
