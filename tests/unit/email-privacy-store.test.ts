import assert from "node:assert/strict";
import test from "node:test";

import useEmailPrivacyStore from "../../src/store/emailPrivacyStore.ts";

test("account email visibility is always enabled", () => {
  assert.equal(useEmailPrivacyStore.getState().emailsVisible, true);
  assert.equal("setEmailsVisible" in useEmailPrivacyStore.getState(), false);
});
