import { create } from "zustand";

interface EmailPrivacyState {
  /** Account emails are always shown in full throughout the dashboard. */
  readonly emailsVisible: true;
}

/**
 * Account identities must remain visible in every dashboard surface.
 *
 * This intentionally does not persist the former masking preference, so a
 * previously saved `omniroute-email-privacy` value cannot re-enable masking.
 */
const useEmailPrivacyStore = create<EmailPrivacyState>()(() => ({
  emailsVisible: true,
}));

export default useEmailPrivacyStore;
