---
name: hosty-mcp-connector
description: Work with a Hosty host through the hosty mcp connector — discovering which apps expose tools, reading host and app state, and understanding why a capability is missing. Use when a Hosty MCP server is connected, when tools named mcp__hosty__* appear, when asked what runs on a Hosty host, or when a Hosty app tool is refused or absent.
---

# Hosty MCP Connector

`hosty mcp` presents every app on one Hosty host as a single MCP server. This skill is what an agent
client needs to use it well; it does not describe how to build the connector.

## What the tools are

Tool names are `<app>__<tool>`, and the client prefixes its own server name — so a tool arrives as
`mcp__hosty__com_dhaas_ddemo-app__list_people`. Read them right to left: the last segment is the
app's own tool, and everything before it identifies the app.

The app segment is an escaped app id: `_d` stands for `.` and `_u` for `_`. So
`com_dhaas_ddemo-app` is `com.haas.demo-app`. Long ids are truncated with a short digest, so treat
the segment as an opaque handle rather than something to decode.

Each tool's description begins with the app's display name in brackets — `[Demo App] Lists the
people…`. When two apps offer similar tools, that prefix is how to tell them apart.

## The read-only boundary, and why a tool may be missing

**The connector is read-only, and it is enforced, not advertised.** An app tool is offered only if it
declares `readOnlyHint: true`. A tool that declares nothing is treated as if it might mutate and is
not offered at all.

This matters when a user asks for something an app plainly supports and no tool exists for it. The
right answer is that the connector does not expose write operations — not that the app cannot do it.
Do not look for a way around this: there is none through this server, by design.

## When a tool fails

Failures come back as ordinary results with `isError: true` and a readable sentence. They are not
protocol errors, so the turn continues and another tool can be tried.

- `app_stopped` — the app is not answering. It is probably stopped; the host operator can start it.
- `app_unauthorized` — Hosty would not issue a credential for this user and app. The user is not
  assigned to that app, or the app is admin-only and they are not an administrator. This is an
  answer, not a transient fault: retrying will not change it.
- `app_error` — the app answered, and refused. The message is the app's own.
- "not an available Hosty tool" — the tool is gone from the catalog. Ask for the tool list again
  rather than guessing at a replacement.

## The fleet changes under you

The connector polls the host and sends `notifications/tools/list_changed` when apps start, stop, or
are installed. A tool that existed at the start of a conversation may be gone later, and new ones may
appear. If a call fails with the tool missing, re-read the list before concluding anything about the
host.

## What this connector is not

It carries **app** tools only. Host control — installing, starting, stopping, updating apps — is not
here, and is not something to attempt through app tools. If the user wants those, tell them to use
the `hosty` CLI on the host, or Hosty Shell.

Core's own read-only observability lives on a separate MCP endpoint (`/api/mcp`), which is a
different server entry. Do not assume the two are the same connection.
