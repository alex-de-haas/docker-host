import { afterEach, expect, it, vi } from "vitest";
import type { InstallationRequest } from "@hosty-sdk/app/install";
import { showCoreConfirmation } from "../src/app/shell/core-confirmation";
import { toast } from "@/components/reui/operation-toast";

vi.mock("@/components/reui/operation-toast", () => ({ toast: { info: vi.fn(() => "confirmation"), dismiss: vi.fn() } }));
const request: InstallationRequest = { id: "review", status: "pending", plan: null,
  approvalUrl: "https://core.example/install/confirm/review", expiresAt: "2099-01-01T00:00:00Z" };
const popup = () => ({ closed: false, opener: {}, location: { replace: vi.fn() } }) as unknown as Window;
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

it("opens Core without a duplicate toast when the popup is available", () => {
  const window = popup();
  expect(showCoreConfirmation(window, request)).toBeUndefined();
  expect(window.location.replace).toHaveBeenCalledExactlyOnceWith(request.approvalUrl);
  expect(window.opener).toBeNull();
  expect(toast.info).not.toHaveBeenCalled();
});

it("offers a blocked-popup fallback and removes it after opening the confirmation", () => {
  const retry = popup();
  vi.spyOn(window, "open").mockReturnValue(retry);
  showCoreConfirmation(null, request);
  const options = vi.mocked(toast.info).mock.calls[0][1]!;
  const action = options.action;
  if (!action || typeof action !== "object" || !("onClick" in action)) throw new Error("Missing confirmation action");
  action.onClick({} as React.MouseEvent<HTMLButtonElement>);
  expect(retry.location.replace).toHaveBeenCalledExactlyOnceWith(request.approvalUrl);
  expect(toast.dismiss).toHaveBeenCalledWith("confirmation");
});

it("returns cleanup for a blocked popup and does not prompt for an accepted request", () => {
  const dismiss = showCoreConfirmation(null, request);
  expect(toast.dismiss).not.toHaveBeenCalled();
  dismiss?.();
  expect(toast.dismiss).toHaveBeenCalledWith("confirmation");
  vi.mocked(toast.info).mockClear();
  expect(showCoreConfirmation(null, { ...request, status: "executing" })).toBeUndefined();
  expect(toast.info).not.toHaveBeenCalled();
});
