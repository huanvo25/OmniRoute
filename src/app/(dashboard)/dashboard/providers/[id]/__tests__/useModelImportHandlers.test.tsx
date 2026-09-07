// @vitest-environment jsdom

import React, { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

describe("useModelImportHandlers", () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("imports a connected Codex catalog through managed sync and refreshes the visible models", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        importedModels: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
        importedCount: 1,
        importedChanges: { total: 1 },
        customModelChanges: { total: 0 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const fetchAliases = vi.fn().mockResolvedValue(undefined);
    const fetchProviderModelMeta = vi.fn().mockResolvedValue(undefined);
    const t = (key: string) => key;
    let result!: ReturnType<
      (typeof import("../hooks/useModelImportHandlers"))["useModelImportHandlers"]
    >;

    const { useModelImportHandlers } = await import("../hooks/useModelImportHandlers");

    function TestWrapper() {
      const hook = useModelImportHandlers({
        providerId: "codex",
        models: [],
        modelMeta: { customModels: [] },
        modelAliases: {},
        connections: [{ id: "codex-connection", isActive: true }],
        isFreeNoAuth: false,
        handleSetAlias: vi.fn().mockResolvedValue(undefined),
        fetchAliases,
        fetchProviderModelMeta,
        fetchConnections: vi.fn().mockResolvedValue(undefined),
        notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
        t,
        providerStorageAlias: "cx",
      });
      useEffect(() => {
        result = hook;
      }, [hook]);
      return null;
    }

    await act(async () => {
      root.render(<TestWrapper />);
    });
    await act(async () => {
      await result.handleImportModels();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/providers/codex-connection/sync-models?mode=import",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchAliases).toHaveBeenCalledOnce();
    expect(fetchProviderModelMeta).toHaveBeenCalledOnce();
    expect(result.importProgress.phase).toBe("done");
    expect(result.importProgress.importedCount).toBe(1);
  });
});
