import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(fileURLToPath(new URL("../..", import.meta.url)));

function resolveAutomaticBranch(branches) {
  const result = spawnSync(
    "bash",
    [
      "-euo",
      "pipefail",
      "-c",
      "TARGET=$(printf '%s\\n' \"$BRANCHES\" | " +
        "grep -E '^release/v[0-9]+\\.[0-9]+\\.[0-9]+$' | " +
        "sort -t/ -k2 -V | tail -1 || true); " +
        "printf '%s' \"$TARGET\"",
    ],
    { env: { ...process.env, BRANCHES: branches.join("\n") }, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("automatic resolution ignores noncanonical release branches before sorting", () => {
  assert.equal(
    resolveAutomaticBranch([
      "release/v3.8.49",
      "release/v3849-chatgpt-web",
      "release/v3.8.50",
      "release/v3.8.51-hotfix",
    ]),
    "release/v3.8.50"
  );
});

test("automatic resolution returns the highest canonical release branch", () => {
  assert.equal(
    resolveAutomaticBranch(["release/v3.8.2", "release/v3.10.0", "release/v3.9.99"]),
    "release/v3.10.0"
  );
});

test("automatic resolution leaves an empty result when no canonical branch exists", () => {
  assert.equal(
    resolveAutomaticBranch(["release/v3849-chatgpt-web", "release/v3.8.50-rc1"]),
    ""
  );
});

test("every automatic release resolver filters canonicals before sorting", () => {
  const workflowFiles = [
    ".github/workflows/nightly-compat.yml",
    ".github/workflows/nightly-release-green.yml",
  ];
  let resolverCount = 0;
  for (const relativePath of workflowFiles) {
    const workflow = readFileSync(join(repoRoot, relativePath), "utf8");
    const matches =
      workflow.match(
        /git for-each-ref --format='\%\(refname:short\)'[\s\S]*?sort -t\/ -k2 -V[\s\S]*?tail -1/g
      ) ?? [];
    resolverCount += matches.length;
    for (const resolver of matches) {
      assert.match(
        resolver,
        /grep -E '\^release\/v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$'/,
        `${relativePath} must filter canonical branches`
      );
      assert.ok(
        resolver.indexOf("grep -E") < resolver.indexOf("sort -t/ -k2 -V"),
        `${relativePath} must filter before sorting`
      );
    }
  }
  assert.equal(resolverCount, 3, "expected the three active release branch resolvers");
});
