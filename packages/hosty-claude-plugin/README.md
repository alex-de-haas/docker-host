# Hosty plugin for Claude Code

Connects a Claude Code session to one Hosty host: every app that exposes an MCP interface appears as
tools on a single server, discovered live rather than listed in a config file.

## What is in it

| Piece | What it does |
| --- | --- |
| `.mcp.json` | Registers `hosty mcp` as a stdio MCP server named `hosty`. |
| `skills/hosty-mcp-connector` | Tells the model how to read the tool names, what the read-only boundary means, and what each failure code implies. |

## Installing

The repository root is a plugin marketplace, so the plugin is installed from it:

```bash
claude plugin marketplace add alex-de-haas/docker-host   # or ./path to a local clone
claude plugin install hosty@hosty
```

`claude plugin details hosty@hosty` should then list one skill and one MCP server.

**Set `HOSTY_MCP_USER` in the environment your client runs in, before starting a session.** Without it
the client passes the literal `${HOSTY_MCP_USER}` through, and the connector now refuses to start
rather than connecting and exporting nothing — which is what it used to do, green tick and all.

**If you already registered the server by hand** with `claude mcp add hosty`, remove it
(`claude mcp remove hosty -s local`). Two servers of the same name collide, and the manual one wins
silently: the plugin's entry simply vanishes from `claude mcp list` with nothing to say it was
shadowed.

## Requirements

- The `hosty` CLI on `PATH`, version 0.81.0 or later.
- Hosty Core running locally. The connector talks to it over the local control channel, so there is
  no login and no token in any config file.
- `HOSTY_MCP_USER` set to the Host user the session should act as — an email or a user id.

That last one is not optional and cannot be defaulted: the control channel identifies no user, while
an app decides what a caller may see from the Hosty user it acts for. Leaving it unset would mean
picking an administrator on the operator's behalf.

## The read-only boundary

The connector exports an app tool only when the app declares `readOnlyHint: true` on it. A tool that
declares nothing is treated as possibly mutating and is not offered at all — so an app can be missing
capabilities here that it plainly has.

**What that filter is and is not.** It stops a tool the app never claimed was safe from ever reaching
a client. It does **not** make the claim trustworthy: `readOnlyHint` is an assertion the app writes
about itself, and an app that is buggy or hostile can label a mutating tool read-only.

There is deliberately **no** `PreToolUse` hook here. An earlier draft shipped one that auto-allowed
connector tools, reasoning that the server enforces read-only. That reasoning was wrong, and review
caught it: what the server enforces is that the *assertion is present*, not that the tool behaves. A
hook resting on it would have let any installed app bypass your approval prompt by writing one field
into its manifest. Connector calls therefore go through Claude Code's normal permission flow, like
anything else. Auto-allowing them needs read-only enforced by something the app cannot assert for
itself — a scoped token — which Hosty does not have yet.

## Status

Installed and exercised end to end in Claude Code on 2026-08-17: the marketplace entry resolves, the
plugin installs, and `claude plugin details hosty@hosty` lists one skill and one MCP server from this
bundle. The connector behind it is covered by the CLI's own suite and was driven live against a
running host.

What has **not** been exercised is a session demonstrably *using the skill* — it is discovered and
offered, but nothing here proves a model read it before choosing a tool.
