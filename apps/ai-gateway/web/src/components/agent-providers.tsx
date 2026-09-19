"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import {
  Ellipsis,
  LogIn,
  Pencil,
  Star,
  Trash2,
  CircleCheck,
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
    void refresh().catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <h2 id="agent-providers-heading" className="text-base font-semibold">
            Agent providers
          </h2>
          <p className="text-sm text-muted-foreground">
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
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
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
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No providers connected</EmptyTitle>
            <EmptyDescription>
              Add Codex or Claude to start chatting.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {directory?.connections.map((connection) => (
        <div
          key={connection.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="truncate">{connection.name}</span>
              {directory.defaultId === connection.id && (
                <Badge variant="outline">Default</Badge>
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
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
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={4}
              className="min-w-48"
            >
              <DropdownMenuGroup>
                {directory.defaultId !== connection.id && (
                  <DropdownMenuItem
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
                  </DropdownMenuItem>
                )}
                {connection.auth === "chatgpt" && (
                  <DropdownMenuItem
                    disabled={login?.status === "pending"}
                    onSelect={() => void act(() => beginLogin(connection.id))}
                  >
                    <LogIn aria-hidden />
                    {connection.available
                      ? "Sign in again"
                      : "Sign in with ChatGPT"}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
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
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => open(connection)}>
                  <Pencil aria-hidden />
                  Edit
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setRemoving(connection.id)}
                >
                  <Trash2 aria-hidden />
                  Remove
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {removing === connection.id && (
            <div className="flex w-full flex-wrap items-center gap-2 text-sm">
              <Separator className="mb-1" />
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
        <Dialog
          open
          onOpenChange={(isOpen) => {
            if (!isOpen) closeEditor();
          }}
        >
          <DialogContent
            className="max-h-[90dvh] overflow-y-auto"
            showCloseButton={!busy}
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
              className="flex flex-col gap-6"
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
              <DialogHeader>
                <DialogTitle>
                  {editing === "new" ? "Add provider" : `Edit ${editing.name}`}
                </DialogTitle>
                <DialogDescription>
                  {editing === "new"
                    ? "Choose a provider and connect your account."
                    : "Update this connection’s name or credentials."}
                </DialogDescription>
              </DialogHeader>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <FieldGroup>
                <FieldGroup className="sm:flex-row">
                  <Field data-disabled={busy || editing !== "new"}>
                    <FieldLabel htmlFor="connection-kind">Provider</FieldLabel>
                    <Select
                      value={kind}
                      disabled={busy || editing !== "new"}
                      onValueChange={(value: AgentConnection["kind"]) => {
                        setKind(value);
                        setAuth(value === "codex" ? "chatgpt" : "api-key");
                        setSecret("");
                      }}
                    >
                      <SelectTrigger id="connection-kind">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="codex">Codex</SelectItem>
                          <SelectItem value="claude">Claude</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field data-disabled={busy}>
                    <FieldLabel htmlFor="connection-name">
                      Connection name
                    </FieldLabel>
                    <Input
                      id="connection-name"
                      value={name}
                      placeholder={kind === "codex" ? "My Codex" : "My Claude"}
                      required
                      maxLength={100}
                      disabled={busy}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </Field>
                </FieldGroup>
                <Field data-disabled={busy || editing !== "new"}>
                  <FieldLabel htmlFor="connection-auth">
                    Authentication
                  </FieldLabel>
                  <Select
                    value={auth}
                    disabled={busy || editing !== "new"}
                    onValueChange={(value: AgentConnection["auth"]) => {
                      setAuth(value);
                      setSecret("");
                    }}
                  >
                    <SelectTrigger id="connection-auth">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {(kind === "codex"
                          ? (["chatgpt", "api-key", "host-login"] as const)
                          : (["api-key", "claude-token"] as const)
                        ).map((value) => (
                          <SelectItem key={value} value={value}>
                            {authLabels[value]}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                {auth === "chatgpt" && (
                  <p className="text-sm text-muted-foreground">
                    Sign in using your ChatGPT account in the browser. Hosty
                    displays a code and waits for your confirmation.
                  </p>
                )}
                {auth === "host-login" && (
                  <Field data-disabled={busy}>
                    <FieldLabel htmlFor="connection-home">
                      Codex home on the Hosty server
                    </FieldLabel>
                    <Input
                      id="connection-home"
                      aria-describedby="connection-home-description"
                      value={hostDirectory}
                      placeholder="/home/hosty/.codex"
                      required
                      disabled={busy}
                      onChange={(e) => setHostDirectory(e.target.value)}
                    />
                    <FieldDescription id="connection-home-description">
                      Use the directory where you ran{" "}
                      <code>CODEX_HOME=&lt;directory&gt; codex login</code>,
                      accessible to the user running Core. Hosty uses this
                      existing account and leaves the directory in place when
                      you remove the connection.
                    </FieldDescription>
                  </Field>
                )}
                {(auth === "api-key" || auth === "claude-token") && (
                  <Field data-disabled={busy}>
                    <FieldLabel htmlFor="connection-secret">
                      {authLabels[auth]}
                      {editing !== "new" && " (leave blank to keep current)"}
                    </FieldLabel>
                    <Input
                      id="connection-secret"
                      aria-describedby="connection-secret-description"
                      type="password"
                      autoComplete="new-password"
                      value={secret}
                      required={editing === "new"}
                      disabled={busy}
                      onChange={(e) => setSecret(e.target.value)}
                    />
                    <FieldDescription id="connection-secret-description">
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
                    </FieldDescription>
                  </Field>
                )}
              </FieldGroup>
              {editing !== "new" && (
                <p className="text-xs text-muted-foreground">
                  Stop open chats before replacing credentials. Chats started
                  with the previous credentials keep their history and require a
                  new chat to use the updated account.
                </p>
              )}
              <DialogFooter>
                <Button type="submit" size="sm" disabled={busy}>
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
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
