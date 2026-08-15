# Hosty plugin for Claude Code

Connects a Claude Code session to one Hosty host: every app that exposes an MCP interface appears as
tools on a single server, discovered live rather than listed in a config file.

## What is in it

| Piece | What it does |
| --- | --- |
| `.mcp.json` | Registers `hosty mcp` as a stdio MCP server named `hosty`. |
| `skills/hosty-mcp-connector` | Tells the model how to read the tool names, what the read-only boundary means, and what each failure code implies. |

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

Built and unit-tested; **not yet installed into a client end to end**. Until that happens, treat the
plugin manifest and hook wiring as unverified against a real Claude Code installation — the connector
itself is exercised by the CLI's own suite.
