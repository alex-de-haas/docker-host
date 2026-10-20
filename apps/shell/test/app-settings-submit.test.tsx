import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AppDetailsDialog } from "../src/app/shell/dialogs/app-details-dialog";
import type { CoreApp } from "../src/app/shell/types";

vi.mock("../src/app/shell/shell-context", () => ({
  useShellState: () => ({ state: { status: { ingressProvider: "none" } } }),
  useShellActions: () => ({ coreOrigin: "https://core.test", refresh: vi.fn(), sendCsrfJson: vi.fn() }),
}));

afterEach(() => vi.unstubAllGlobals());

it.each(["autostart", "app setting", "public origins tab"])(
  "saves %s without resubmitting browser addresses or untouched secrets",
  async change => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const app: CoreApp = {
      id: "example.media", displayName: "Media", version: "1.0.0", kind: "runtime",
      system: false, source: "manifest", operationStatus: "started", runtimeState: "running",
      autostart: true, capabilities: [],
      settings: [
        { key: "HOSTY_APP_MODE", type: "string", value: "normal", secret: false },
        { key: "API_KEY", type: "string", value: null, secret: true, hasValue: true },
        { key: "HOSTY_LOCAL_NAME_UI", type: "string", value: "media-ui", secret: false },
        { key: "HOSTY_LOCAL_NAME_API", type: "string", value: "media-api", secret: false },
        { key: "HOSTY_PUBLIC_ORIGIN_UI", type: "string", value: "https://media.example", secret: false },
      ],
      endpoints: [{ key: "ui", protocol: "http", public: true, browserOrigin: "https://media.example" }],
    };
    const configure = vi.fn();
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    try {
      await act(async () => root.render(<AppDetailsDialog
        app={app} view="settings" coreOrigin="https://core.test" globalMounts={[]}
        canManageApps isShell={false} busyAction={null}
        detail={{ loading: false, error: null, backups: null, backupCleanupPlan: null, updatePlan: null }}
        onClose={vi.fn()} onRefreshBackups={vi.fn()} onCreateBackup={vi.fn()} onRestoreBackup={vi.fn()}
        onDeleteBackup={vi.fn()} onPreviewBackupCleanup={vi.fn()} onApplyBackupCleanup={vi.fn()}
        onConfigure={configure} onConfigureMounts={vi.fn()} onConfigureSource={vi.fn()}
        onClearSource={vi.fn()} onSetFeed={vi.fn()} onRemove={vi.fn()}
      />));
      const dialog = document.querySelector('[role="dialog"]')!;
      if (change === "autostart") {
        await act(async () => dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
      } else {
        const input = dialog.querySelector<HTMLInputElement>("#setting-HOSTY_APP_MODE")!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "quiet");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        if (change === "public origins tab") {
          const tab = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
            .find(button => button.textContent === "Network")!;
          await act(async () => tab.click());
        }
      }
      const save = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
        .find(button => button.textContent === "Save settings")!;
      await act(async () => save.click());
      expect(configure).toHaveBeenCalledExactlyOnceWith(app,
        { HOSTY_APP_MODE: change === "autostart" ? "normal" : "quiet" }, change !== "autostart");
    } finally {
      await act(async () => root.unmount());
      node.remove();
    }
  },
);
