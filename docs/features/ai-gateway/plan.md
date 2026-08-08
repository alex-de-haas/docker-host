# AI Gateway

Status: Ready
Created: 2026-08-08
Updated: 2026-08-08

Extracted from the [AI Agent Bridge](../ai-agent-bridge/plan.md) umbrella (its rollout step 8). The umbrella's decisions of 2026-07-11 and 2026-08-08 — execution profiles, placement in a system app, token mechanics, approval policy — govern this feature; this document does not restate their rationale.

## Goal

Ship the first Hosty assistant: the `hosty.ai-gateway` system app hosting admin-only operator chat sessions on a host-resident CLI agent harness, plus the Shell UI that exposes them. After this feature, an administrator can open a chat in Shell (globally or from an app's page), ask the assistant to investigate live logs, diagnose failures, modify app source through dev-mode workflows, or run lifecycle actions — with every proposed write pausing for approval in Shell.

## Scope

In scope — the umbrella's operator milestone:

- the gateway system app (localCommand runtime profile) declaring the `ai-gateway` interface;
- the session API (create, stream, message, approve/deny, cancel), restricted to administrators;
- the harness adapter contract and its first implementation;
- the Shell assistant UI: chat panel, first contextual entry point, approval flow;
- transcript storage and retention in the gateway's app data directory;
- Core audit records for session lifecycle and approved actions.

Out of scope, tracked by the umbrella: the non-admin user profile (MCP-only sessions), the `/api/ai/generate` broker capability, durable jobs, voice, the `hosty mcp` connector, sandboxed one-shot development jobs.

Prerequisite note: the umbrella flags token scopes as a prerequisite for scoped agent tokens. That does not block this feature — operator sessions are admin-only, so the existing role model is sufficient; no scope machinery is required here.

## Target Behavior

### Gateway system app

- `hosty.ai-gateway` is an optional, removable system app with a localCommand runtime profile: it spawns CLI harness processes on the host, so it does not run in a container.
- The manifest declares the `ai-gateway` interface (draft extension of `app.0.1`, per the umbrella decision). When the interface is not installed, no assistant surface exists anywhere in the platform.
- Harness configuration (which CLI, binary path, pinned version) is gateway app config. Harness CLIs authenticate through their own vendor mechanisms under the host user; the gateway never stores or proxies those credentials.
- The gateway detects a missing or logged-out harness and reports an "assistant unavailable" state with the reason through its health/status surface; Shell renders that state instead of a chat box.

### Sessions and the harness adapter

- Session API: create a session (with optional structured page context: app id, route), stream events, send a user message, approve or deny a proposed action, cancel. Streaming is SSE, consistent with existing Core/Shell streams.
- Only Host administrators can create or attach to sessions. Shell authenticates to the gateway with short-lived Core-issued delegated tokens (audience = gateway) validated locally by the gateway with the Core-injected verification key — the standard Shell→system-app data-plane pattern.
- The harness adapter is a small internal contract (start / stream / approve / resume / cancel) with pinned harness versions. The first adapter drives the Claude Code CLI in headless streaming mode or the Claude Agent SDK; its permission callback pauses proposed writes and surfaces them as approval events.
- Every write proposed by the harness is approval-gated — no exceptions in v1. Live logs and app data are untrusted model input; approvals attach to individual actions.
- Session records and transcripts live in the gateway's app data directory with an explicit retention setting; standard app backup and removal semantics apply. Core audit receives session lifecycle events and approved actions only — never transcript content.

### Shell UI

- A chat panel available to administrators, gated on discovery of an installed, healthy `ai-gateway` interface.
- Contextual entry points open a session pre-seeded with structured page context; the first one lives on an app's page. The prompt stays free-form — the context is what is structured.
- Approval requests render inline in the chat with the proposed action, its target, and approve/deny controls.
- A non-admin user never sees the assistant surface. An admin with no installed interface sees nothing; an admin with an unavailable harness sees the reason.

## Deliverables

- [ ] Manifest interface draft extension: `interfaces.ai-gateway` accepted by Core validation and exposed through the registry/discovery API.
- [ ] Shell→system-app delegated-token exchange usable by the browser client against the gateway (confirm or build issue/validate/refresh).
- [ ] Gateway app skeleton: manifest (system app, localCommand profile, `ai-gateway` interface), install/removal through the standard system-app distribution flow, health surface with "harness unavailable" reason.
- [ ] Harness adapter contract plus the first adapter, pinned version, approval-pause verified end to end.
- [ ] Session API: create/stream/message/approve/deny/cancel, admin-only, SSE streaming, session records and transcripts in app data with retention config.
- [ ] Core audit records for session lifecycle and approved actions.
- [ ] Shell chat panel: discovery-gated, admin-only, streaming rendering, approval UX.
- [ ] Shell contextual entry point on the app page passing app id and route as session context.
- [ ] `feature.md` for this folder, umbrella rollout checkbox, regenerated index.

## Phases

1. **Platform plumbing** — manifest interface extension, registry exposure, Shell→gateway delegated tokens. Verifiable with direct HTTP calls before any gateway code exists.
2. **Gateway core** — app skeleton, harness adapter, session API. Verifiable headless: create a session with an admin token, stream events, approve a write, observe it executed.
3. **Shell surface** — chat panel, approval UX, contextual entry point, unavailability states.

## Open Questions

- Question: Which harness adapter ships first — Claude Code CLI headless streaming or the Claude Agent SDK?
  Answer: The umbrella prefers either; they differ in supervision complexity, approval-callback fidelity, and version pinning ergonomics.
  Recommendation: Decide with a short spike at the start of phase 2 against three criteria: approval pause fidelity, streaming event quality, and resumability.
  Decision (2026-08-08): As recommended — the choice is delegated to a short spike at the start of phase 2 against those three criteria; the spike outcome is recorded in this document.

- Question: What is the gateway's implementation stack?
  Answer: The Claude Agent SDK is TypeScript-native, and the existing first-party apps are Node-based; nothing in the gateway needs .NET.
  Recommendation: Node/TypeScript, matching the other first-party runtime apps.
  Decision (2026-08-08): Node/TypeScript.

- Question: One active session, or concurrent sessions per admin?
  Answer: Concurrent operator sessions can edit the same app checkout — the umbrella lists this edge case; the risk class equals two human administrators working over SSH simultaneously.
  Recommendation: Allow concurrent sessions in v1 without locking, document the risk, revisit if it bites in practice.
  Decision (2026-08-08): Concurrent sessions are allowed in v1 without locking; the risk class equals two administrators working over SSH and is accepted, to be revisited only if it causes real problems.

- Question: Do sessions survive a closed Shell tab or a gateway restart?
  Answer: Session records persist in app data either way; the question is live harness process continuity.
  Recommendation: Reattach-by-id must work after a tab close (process keeps running). After a gateway restart, resume through the harness-native session-resume mechanism when the chosen adapter supports it; otherwise start a fresh session seeded with the stored transcript.
  Decision (2026-08-08): As recommended — reattach-by-id after a tab close; after a gateway restart, harness-native resume when the adopted adapter supports it, otherwise a fresh session seeded with the stored transcript.

## Verification

- `hosty core start`; install the gateway manifest with a local/source runtime profile; `hosty apps start hosty.ai-gateway`.
- Create an operator session with an admin delegated token: verify SSE streaming, a read-only action executing without approval, a write pausing and executing only after approval, and a denied write leaving state untouched.
- Verify a non-admin token is rejected by the session API and the assistant surface is absent in Shell for non-admin users.
- Log the harness out (or remove the CLI) and verify Shell shows "assistant unavailable" with the reason.
- Verify transcripts land in the app data directory, retention cleanup runs, and Core audit contains lifecycle and approval records without transcript content.
- Run the standard suites: `dotnet test` for Core/CLI changes, lint/build for the gateway and Shell.
