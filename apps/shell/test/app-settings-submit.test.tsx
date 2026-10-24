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

function activateTab(dialog: Element, label: string) {
  const tab = [...dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === label)!;
  tab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

it.each(["autostart", "app setting", "round trip through Network", "autostart with parameter draft"])(
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
      const render = (current = app) => act(async () => root.render(<AppDetailsDialog
        app={current} view="settings" coreOrigin="https://core.test" globalMounts={[]}
        canManageApps isShell={false} busyAction={null}
        detail={{ loading: false, error: null, backups: null, backupCleanupPlan: null, updatePlan: null }}
        onClose={vi.fn()} onRefreshBackups={vi.fn()} onCreateBackup={vi.fn()} onRestoreBackup={vi.fn()}
        onDeleteBackup={vi.fn()} onPreviewBackupCleanup={vi.fn()} onApplyBackupCleanup={vi.fn()}
        onConfigure={configure} onConfigureMounts={vi.fn()} onConfigureSource={vi.fn()}
        onClearSource={vi.fn()} onSetFeed={vi.fn()}
      />));
      await render();
      const dialog = document.querySelector('[role="dialog"]')!;
      if (change === "autostart") {
        await act(async () => dialog.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
      } else {
        await act(async () => activateTab(dialog, "Parameters"));
        const input = dialog.querySelector<HTMLInputElement>("#setting-HOSTY_APP_MODE")!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "quiet");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        if (change === "round trip through Network") {
          await act(async () => activateTab(dialog, "Network"));
          expect([...dialog.querySelectorAll("button")].some(button => button.textContent === "Save settings")).toBe(false);
          await act(async () => activateTab(dialog, "Parameters"));
          expect(dialog.querySelector<HTMLInputElement>("#setting-HOSTY_APP_MODE")!.value).toBe("quiet");
        }
      }
      if (change === "autostart with parameter draft") {
        await act(async () => activateTab(dialog, "Launch"));
        await act(async () => dialog.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
      }
      const save = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
        .find(button => button.textContent === "Save settings")!;
      await act(async () => save.click());
      expect(configure).toHaveBeenCalledExactlyOnceWith(app,
        change.startsWith("autostart") ? {} : { HOSTY_APP_MODE: "quiet" }, change.startsWith("autostart") ? false : undefined);
      if (change === "autostart with parameter draft") {
        await render({ ...app, autostart: false });
        await act(async () => activateTab(dialog, "Parameters"));
        expect(dialog.querySelector<HTMLInputElement>("#setting-HOSTY_APP_MODE")!.value).toBe("quiet");
      }
    } finally {
      await act(async () => root.unmount());
      node.remove();
    }
  },
);
