"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DropdownMenu } from "radix-ui";
import {
  Ellipsis,
  LogIn,
  Pencil,
  Star,
  Trash2,
  CircleCheck,
  X,
} from "lucide-react";
import {
  ProviderLoginDialog,
  type ProviderLogin,
} from "./provider-login-dialog";
import { Button } from "@/components/ui/button";
import { call } from "@/lib/api";

export type AgentConnection = {
  id: string;
  name: string;
  kind: "claude" | "codex";
  auth: "api-key" | "claude-token" | "chatgpt" | "host-login";
  revision: number;
  hostDirectory?: string;
  available: boolean;
  reason?: string;
};
type Directory = { connections: AgentConnection[]; defaultId: string | null };
type Login = ProviderLogin;
const menuItem =
  "flex cursor-default select-none items-center gap-2 rounded px-2 py-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&_svg]:size-4";
const control = "w-full rounded-md border bg-background px-3 py-2 text-sm";
const authLabels = {
  "api-key": "API key",
  "claude-token": "Claude Code token",
  chatgpt: "ChatGPT sign-in",
  "host-login": "Existing Codex login on this host",
};

export function AgentProviders() {
  const addButton = useRef<HTMLButtonElement>(null);
  const providerButtons = useRef(new Map<string, HTMLButtonElement>());
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [editing, setEditing] = useState<AgentConnection | "new" | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AgentConnection["kind"]>("codex");
  const [auth, setAuth] = useState<AgentConnection["auth"]>("chatgpt");
  const [secret, setSecret] = useState("");
  const [hostDirectory, setHostDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [login, setLogin] = useState<Login | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setDirectory((await (await call("/connections")).json()) as Directory);
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(String(e.message)));
  }, [refresh]);
  const loginId = login?.id;
  const loginStatus = login?.status;
  useEffect(() => {
    if (!loginId || loginStatus !== "pending") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = (await (
          await call(`/provider-logins/${loginId}`)
        ).json()) as Login;
        if (disposed) return;
        setLogin(next);
        if (next.status !== "pending") {
          await refresh();
          return;
        }
      } catch (e) {
        if (!disposed)
          setError(e instanceof Error ? e.message : "Could not check sign-in.");
      }
      if (!disposed) timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [loginId, loginStatus, refresh]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update provider.");
    } finally {
      setBusy(false);
    }
  };
  const closeEditor = () => {
    if (busy) return;
    setSecret("");
    setError(null);
    setEditing(null);
  };
  const open = (connection: AgentConnection | "new") => {
    setEditing(connection);
    setSecret("");
    setError(null);
    setNotice(null);
    setName(connection === "new" ? "" : connection.name);
    setKind(connection === "new" ? "codex" : connection.kind);
    setAuth(connection === "new" ? "chatgpt" : connection.auth);
    setHostDirectory(
      connection === "new" ? "" : (connection.hostDirectory ?? ""),
    );
  };
  const beginLogin = async (id: string) => {
    setLogin(
      (await (
        await call(`/connections/${id}/login`, { method: "POST" })
      ).json()) as Login,
    );
  };

  return (
    <section className="grid gap-3" aria-labelledby="agent-providers-heading">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2
            id="agent-providers-heading"
            className="text-[15px] font-semibold"
          >
            Agent providers
          </h2>
          <p className="text-[13px] text-muted-foreground">
            Connect accounts, choose a default, or select a different provider
            for a new chat.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          ref={addButton}
          onClick={() => open("new")}
        >
          + Add provider
        </Button>
      </div>
      {error && !editing && !login && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {!directory && !error && (
        <p className="text-sm text-muted-foreground">Loading providers…</p>
      )}
      {directory?.connections.length === 0 && !editing && (
        <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
          No providers connected. Add Codex or Claude to start chatting.
        </p>
      )}
      {directory?.connections.map((connection) => (
        <div
          key={connection.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="truncate">{connection.name}</span>
              {directory.defaultId === connection.id && (
                <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  Default
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {connection.kind === "codex" ? "Codex" : "Claude"} ·{" "}
              {authLabels[connection.auth]} ·{" "}
              {connection.available
                ? "Configured"
                : (connection.reason ?? "Reconnect required")}
            </p>
          </div>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy}
                title="Provider actions"
                aria-label={`Actions for ${connection.name}`}
                ref={(button) => {
                  if (button)
                    providerButtons.current.set(connection.id, button);
                  else providerButtons.current.delete(connection.id);
                }}
              >
                <Ellipsis aria-hidden />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                className="z-40 min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
              >
                {directory.defaultId !== connection.id && (
                  <DropdownMenu.Item
                    className={menuItem}
                    disabled={!connection.available}
                    onSelect={() =>
                      void act(async () => {
                        await call("/connections/default", {
                          method: "PUT",
                          body: JSON.stringify({ connectionId: connection.id }),
                        });
                        await refresh();
                        setNotice(
                          "Default saved. Existing chats keep their provider.",
                        );
                      })
                    }
                  >
                    <Star aria-hidden />
                    Set default
                  </DropdownMenu.Item>
                )}
                {connection.auth === "chatgpt" && (
                  <DropdownMenu.Item
                    className={menuItem}
                    disabled={login?.status === "pending"}
                    onSelect={() => void act(() => beginLogin(connection.id))}
                  >
                    <LogIn aria-hidden />
                    {connection.available
                      ? "Sign in again"
                      : "Sign in with ChatGPT"}
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Item
                  className={menuItem}
                  onSelect={() =>
                    void act(async () => {
                      const result = (await (
                        await call(`/connections/${connection.id}/test`, {
                          method: "POST",
                        })
                      ).json()) as { available: boolean; reason?: string };
                      if (!result.available)
                        throw new Error(
                          result.reason ?? "Provider unavailable.",
                        );
                      setNotice(
                        `${connection.name}: local setup is ready. The provider validates access when a chat runs.`,
                      );
                    })
                  }
                >
                  <CircleCheck aria-hidden />
                  Test connection
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={menuItem}
                  onSelect={() => open(connection)}
                >
                  <Pencil aria-hidden />
                  Edit
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item
                  className={`${menuItem} text-destructive focus:text-destructive`}
                  onSelect={() => setRemoving(connection.id)}
                >
                  <Trash2 aria-hidden />
                  Remove
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          {removing === connection.id && (
            <div className="flex w-full flex-wrap items-center gap-2 border-t pt-3 text-sm">
              <p className="flex-1">
                Remove {connection.name}? Its chat history stays, but those
                chats cannot continue.
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setRemoving(null)}
              >
                Keep provider
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await call(`/connections/${connection.id}`, {
                      method: "DELETE",
                    });
                    setRemoving(null);
                    await refresh();
                  })
                }
              >
                Remove provider
              </Button>
            </div>
          )}
        </div>
      ))}
      {login && (
        <ProviderLoginDialog
          key={login.id}
          login={login}
          busy={busy}
          error={error}
          onClose={() => {
            if (login.status !== "pending") {
              setLogin(null);
              return;
            }
            void act(async () => {
              await call(`/provider-logins/${login.id}`, { method: "DELETE" });
              setLogin(null);
            });
          }}
        />
      )}
      {editing && (
        <Dialog.Root
          open
          onOpenChange={(isOpen) => {
            if (!isOpen) closeEditor();
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
            <Dialog.Content
              className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-6 text-sm shadow-xl"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                const trigger =
                  editing === "new"
                    ? addButton.current
                    : providerButtons.current.get(editing.id);
                trigger?.focus();
              }}
            >
              <form
                className="grid gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(async () => {
                    const saved = (await (
                      await call(
                        editing === "new"
                          ? "/connections"
                          : `/connections/${editing.id}`,
                        {
                          method: editing === "new" ? "POST" : "PUT",
                          body: JSON.stringify({
                            name,
                            kind,
                            auth,
                            ...(secret ? { secret } : {}),
                            ...(auth === "host-login" ? { hostDirectory } : {}),
                          }),
                        },
                      )
                    ).json()) as AgentConnection;
                    setSecret("");
                    setEditing(null);
                    await refresh();
                    if (auth === "chatgpt" && editing === "new")
                      await beginLogin(saved.id);
                    else
                      setNotice(
                        "Provider saved. Choose Set default in its menu to use it for new chats.",
                      );
                  });
                }}
              >
                <div className="grid gap-2 pr-5">
                  <Dialog.Title className="text-base font-semibold">
                    {editing === "new"
                      ? "Add provider"
                      : `Edit ${editing.name}`}
                  </Dialog.Title>
                  <Dialog.Description className="text-muted-foreground">
                    {editing === "new"
                      ? "Choose a provider and connect your account."
                      : "Update this connection’s name or credentials."}
                  </Dialog.Description>
                </div>
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1.5 text-xs">
                    Provider
                    <select
                      className={control}
                      value={kind}
                      disabled={busy || editing !== "new"}
                      onChange={(event) => {
                        const value = event.target
                          .value as AgentConnection["kind"];
                        setKind(value);
                        setAuth(value === "codex" ? "chatgpt" : "api-key");
                        setSecret("");
                      }}
                    >
                      <option value="codex">Codex</option>
                      <option value="claude">Claude</option>
                    </select>
                  </label>
                  <label className="grid gap-1.5 text-xs">
                    Connection name
                    <input
                      className={control}
                      value={name}
                      placeholder={kind === "codex" ? "My Codex" : "My Claude"}
                      required
                      maxLength={100}
                      disabled={busy}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                </div>
                <label className="grid gap-1.5 text-xs">
                  Authentication
                  <select
                    className={control}
                    value={auth}
                    disabled={busy || editing !== "new"}
                    onChange={(e) => {
                      setAuth(e.target.value as AgentConnection["auth"]);
                      setSecret("");
                    }}
                  >
                    {(kind === "codex"
                      ? (["chatgpt", "api-key", "host-login"] as const)
                      : (["api-key", "claude-token"] as const)
                    ).map((value) => (
                      <option key={value} value={value}>
                        {authLabels[value]}
                      </option>
                    ))}
                  </select>
                </label>
                {auth === "chatgpt" && (
                  <p className="text-sm text-muted-foreground">
                    Sign in using your ChatGPT account in the browser. Hosty
                    displays a code and waits for your confirmation.
                  </p>
                )}
                {auth === "host-login" && (
                  <>
                    <label className="grid gap-1.5 text-xs">
                      Codex home on the Hosty server
                      <input
                        className={control}
                        value={hostDirectory}
                        placeholder="/home/hosty/.codex"
                        required
                        disabled={busy}
                        onChange={(e) => setHostDirectory(e.target.value)}
                      />
                    </label>
                    <p className="text-xs text-muted-foreground">
                      Use the directory where you ran{" "}
                      <code>CODEX_HOME=&lt;directory&gt; codex login</code>,
                      accessible to the user running Core. Hosty uses this
                      existing account and leaves the directory in place when
                      you remove the connection.
                    </p>
                  </>
                )}
                {(auth === "api-key" || auth === "claude-token") && (
                  <>
                    <label className="grid gap-1.5 text-xs">
                      {authLabels[auth]}
                      {editing !== "new" && " (leave blank to keep current)"}
                      <input
                        className={control}
                        type="password"
                        autoComplete="new-password"
                        value={secret}
                        required={editing === "new"}
                        disabled={busy}
                        onChange={(e) => setSecret(e.target.value)}
                      />
                    </label>
                    <p className="text-xs text-muted-foreground">
                      {auth === "claude-token" ? (
                        <>
                          Paste the token from <code>claude setup-token</code>.
                          When it expires, replace it here. See{" "}
                          <a
                            href="https://code.claude.com/docs/en/authentication"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline"
                          >
                            Claude authentication
                          </a>
                          .
                        </>
                      ) : (
                        <>
                          Create a key in{" "}
                          <a
                            className="underline"
                            target="_blank"
                            rel="noopener noreferrer"
                            href={
                              kind === "codex"
                                ? "https://platform.openai.com/api-keys"
                                : "https://console.anthropic.com/settings/keys"
                            }
                          >
                            {kind === "codex"
                              ? "OpenAI Platform"
                              : "Anthropic Console"}
                          </a>
                          . API usage uses that account&apos;s API billing.
                        </>
                      )}
                    </p>
                  </>
                )}
                {editing !== "new" && (
                  <p className="text-xs text-muted-foreground">
                    Stop open chats before replacing credentials. Chats started
                    with the previous credentials keep their history and require
                    a new chat to use the updated account.
                  </p>
                )}
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy}>
                    {busy
                      ? "Saving…"
                      : auth === "chatgpt" && editing === "new"
                        ? "Add and sign in"
                        : "Save provider"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={closeEditor}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
              <Dialog.Close asChild>
                <Button
                  type="button"
                  className="absolute right-2 top-2"
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy}
                  title="Close"
                  aria-label="Close provider editor"
                >
                  <X aria-hidden />
                </Button>
              </Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </section>
  );
}
