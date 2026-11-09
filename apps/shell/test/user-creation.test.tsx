import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UserManagementPanel } from "../src/app/shell/pages/user-management-page";
import { toast } from "../src/components/reui/operation-toast";

vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
vi.mock("../src/components/reui/operation-toast", () => ({ toast: { success: vi.fn() } }));

let root: Root, container: HTMLDivElement;
const send = vi.fn();
const apps = [
  { id: "example.notes", name: "Notes", version: "1.0.0", operationStatus: "started" },
  { id: "example.calendar", name: "Calendar", version: "1.0.0", operationStatus: "started" },
];
const activeUser = { id: "alice", role: "host.admin", email: "alice@example.test", displayName: "Alice", disabled: false };
const createdUser = {
  id: "guest", email: "guest@example.test", displayName: "Guest", role: "host.user", disabled: false,
  assignedAppIds: ["example.notes"], activeSessionCount: 0, lastSeenAt: null,
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ users: [], invitations: [], apps })));
  send.mockResolvedValue(Response.json(createdUser, { status: 201 }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const button = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")]
  .find(node => node.textContent === label || node.getAttribute("aria-label") === label)!;
const appCheckbox = (id: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
  .find(node => node.closest("label")?.textContent?.includes(id))!;

async function click(label: string, scope: ParentNode = document) {
  expect(button(label, scope), label).toBeDefined();
  await act(async () => button(label, scope).click());
}
async function fill(id: string, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(id), value);
    input(id).dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function chooseRole(label: string) {
  const trigger = document.getElementById("createRole")!;
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent === label)!;
  expect(option, label).toBeDefined();
  await act(async () => option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}
async function openCreate() {
  await act(async () => root.render(<UserManagementPanel coreOrigin="https://core.test" activeUser={activeUser} sendCsrfJson={send} />));
  await click("Create User", container);
}
async function fillAccount() {
  await fill("createEmail", "guest@example.test");
  await fill("createDisplayName", "Guest");
  await fill("createPassword", "test-password-123");
  await fill("createConfirmation", "test-password-123");
}
function dispatchSubmit() {
  dialog()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
const submit = () => act(async () => dispatchSubmit());
const escape = () => act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

it("creates a user with the selected app grants and password, then reloads the list and clears the popup", async () => {
  await openCreate();
  expect(button("Invite User", container)).toBeDefined();
  await fillAccount();
  await act(async () => appCheckbox("example.notes").click());
  expect(send).not.toHaveBeenCalled();
  vi.mocked(fetch).mockImplementation(async () => Response.json({ users: [createdUser], invitations: [], apps }));

  await submit();

  expect(send).toHaveBeenCalledExactlyOnceWith("https://core.test/api/auth/users", {
    email: "guest@example.test", displayName: "Guest", password: "test-password-123", role: "host.user", assignedAppIds: ["example.notes"],
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(container.querySelector("tbody")?.textContent).toContain("guest@example.test");
  expect(toast.success).toHaveBeenCalledExactlyOnceWith("User created");
  expect(dialog()).toBeNull();

  await click("Create User", container);
  for (const id of ["createEmail", "createDisplayName", "createPassword", "createConfirmation"]) expect(input(id).value).toBe("");
  expect(document.getElementById("createRole")?.textContent).toBe("User");
  expect(appCheckbox("example.notes").getAttribute("aria-checked")).toBe("false");
});

it("keeps a password mismatch local and allows correcting it before submission", async () => {
  await openCreate();
  await fillAccount();
  await fill("createConfirmation", "different-password");
  await submit();

  expect(send).not.toHaveBeenCalled();
  expect(dialog()!.textContent).toContain("Passwords do not match.");
  expect(input("createPassword").value).toBe("test-password-123");
  expect(input("createConfirmation").value).toBe("different-password");
  expect(button("Create User", dialog()!).disabled).toBe(false);

  await fill("createConfirmation", "test-password-123");
  await submit();
  expect(send).toHaveBeenCalledTimes(1);
  expect(dialog()).toBeNull();
});

it.each(["response", "exception"])("shows a creation %s failure inside the popup and preserves the draft for retry", async failure => {
  await openCreate();
  await fillAccount();
  await act(async () => appCheckbox("example.notes").click());
  if (failure === "response") send.mockResolvedValueOnce(Response.json({ message: "Email is already registered." }, { status: 409 }));
  else send.mockRejectedValueOnce(new Error("Email is already registered."));

  await submit();

  expect(dialog()!.textContent).toContain("Email is already registered.");
  expect(container.textContent).not.toContain("Email is already registered.");
  expect(input("createEmail").value).toBe("guest@example.test");
  expect(input("createDisplayName").value).toBe("Guest");
  expect(input("createPassword").value).toBe("test-password-123");
  expect(input("createConfirmation").value).toBe("test-password-123");
  expect(appCheckbox("example.notes").getAttribute("aria-checked")).toBe("true");
  expect(button("Create User", dialog()!).disabled).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(toast.success).not.toHaveBeenCalled();

  await submit();
  expect(send).toHaveBeenCalledTimes(2);
  expect(dialog()).toBeNull();
});

it.each(["Cancel", "Close", "Escape"])("discards credentials and errors when dismissed with %s", async dismissal => {
  await openCreate();
  await fillAccount();
  await fill("createConfirmation", "different-password");
  await submit();
  expect(dialog()!.textContent).toContain("Passwords do not match.");

  if (dismissal === "Escape") await escape();
  else await click(dismissal, dialog()!);
  expect(dialog()).toBeNull();
  expect(send).not.toHaveBeenCalled();

  await click("Create User", container);
  for (const id of ["createEmail", "createDisplayName", "createPassword", "createConfirmation"]) expect(input(id).value).toBe("");
  expect(dialog()!.textContent).not.toContain("Passwords do not match.");
});

it("blocks duplicate submissions and dismissal while creation is pending", async () => {
  let finish!: (response: Response) => void;
  send.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  await openCreate();
  await fillAccount();

  await act(async () => { dispatchSubmit(); dispatchSubmit(); });

  expect(send).toHaveBeenCalledTimes(1);
  expect(dialog()!.querySelector("fieldset")?.disabled).toBe(true);
  expect(button("Create User", dialog()!).disabled).toBe(true);
  expect(button("Cancel", dialog()!).disabled).toBe(true);
  expect(button("Close", dialog()!)).toBeUndefined();
  await click("Cancel", dialog()!);
  await escape();
  await submit();
  expect(dialog()).not.toBeNull();
  expect(input("createPassword").value).toBe("test-password-123");
  expect(send).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);

  await act(async () => finish(Response.json(createdUser, { status: 201 })));
  expect(dialog()).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("clears individual app grants when choosing admin and sends no assignments for an administrator", async () => {
  await openCreate();
  await fillAccount();
  await fill("createDisplayName", "");
  await act(async () => appCheckbox("example.notes").click());
  await chooseRole("Admin");
  expect(dialog()!.querySelector('[role="checkbox"]')).toBeNull();
  expect(dialog()!.textContent).toContain("Administrators have access to all apps.");
  await chooseRole("User");
  expect(appCheckbox("example.notes").getAttribute("aria-checked")).toBe("false");
  await chooseRole("Admin");
  expect(send).not.toHaveBeenCalled();

  await submit();

  expect(send).toHaveBeenCalledExactlyOnceWith("https://core.test/api/auth/users", {
    email: "guest@example.test", displayName: null, password: "test-password-123", role: "host.admin", assignedAppIds: [],
  });
});
