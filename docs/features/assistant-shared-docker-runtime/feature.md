---
created: 2026-10-15
updated: 2026-11-12
summary: Harness runs its conversation API and UI in one Docker service and consumes independently installed Local agent providers through their public interface.
components: [apps/harness, apps/core]
---

# Shared Docker Agent Runtime

## Harness Runtime Boundary

Harness declares one `api` service. Docker is its default runtime; production Local and source
profiles remain available. Core owns ordinary installation, health, logs, resources, Stop and
removal. The Docker source profile mounts the registered source read-only and puts production
build outputs in a Core-owned cache. The installed image remains locked to Core's resolved digest.

Native execution belongs to the separately installed Local Codex, Claude Code and Ollama apps.
The [Agent Provider interface](../agent-provider-interface/feature.md) owns their public HTTP/SSE
contract, provider-owned accounts, native sessions, journals, scoped authority, host prerequisites
and known-stop evidence. Harness contains neither native SDK dependencies nor a worker image,
service credential handshake or private execution listener. Its execution client uses the public
SDK and qualified provider/account references; the Core stores no Harness conversation database.

The consuming application's runtime does not identify the provider's process or filesystem
boundary. Docker Harness can call Local providers, and restarting Harness preserves the provider's
accepted execution. Availability and supported operations come from the selected provider's
capabilities. A failed provider does not select another account or replay a completed native turn.

## Source And Execution Ownership

Native providers resolve authorized Core worktrees and acquire exact execution-owned leases before
using them. Core preserves the original actor and current collection permissions. A resource list
names initial execution contexts; it is not an additional source-authority allowlist. Additional
worktrees prepared through scoped Core MCP join the same owned cleanup ledger. Leases remain held
when process exit or external effects are unknown. Release uses exact recorded ownership after
confirmed native stop, including after consumer restart.

Harness retains its own conversation projection, immutable accepted attachments, replay cursors,
profile instructions, task state and exact provider request identities. The provider retains native
context and resumes that exact session; Harness does not replay the entire transcript as a new
native conversation. User-facing conversation history remains in the
[Conversation History contract](../conversation-history/feature.md).

Provider applications use normal Core lifecycle and their own data/cache/secret namespaces.
Provider settings use ordinary Hosty sign-in. Host tools are installed explicitly by the operator;
provider setup does not install project SDKs, Docker or an Ollama server. The read-only prerequisite
doctor distinguishes startup requirements from optional project tools.

## Cutover And Recovery

The first extraction uses the owner's explicit clean-slate policy. Operators install and configure
new providers, stop existing work and remove the selected legacy sessions/history before updating
Harness. The cutover guard rejects legacy state rather than adopting accounts or native sessions.
After a verified clean transition it records the new format; later isolated conversation corruption
does not block healthy new conversations. No implementation or test resets ordinary host data.

New provider state survives compatible, operator-quiescent updates. A lost response, disconnected
client or provider restart does not prove a native process stopped. Provider-owned receipts and
supported SDK stop confirmation determine recovery; caller attestations do not substitute for
that proof. Unknown effects are preserved independently of process-exit evidence. Detailed
recovery/cancellation behavior is defined by the public provider contract.

The [remaining predecessor acceptance](plan.md) retains native Windows, Linux, macOS and actual
provider evidence. Removing the worker image alone does not complete that acceptance. The provider
plan tracks its replacement checks and the observed limits of each platform run.

## Testing Expectations

- Run Harness unit/component tests, typecheck and production web build for consumer changes.
- Run the provider runtime suites, SDK conformance, Core authority/HTTP tests and affected builds.
- Use `npm run test:integration -- agent-providers` for managed production Local setup,
  provider-owned settings and public session/restart/recovery checks with disposable fixtures.
- Verify Docker Harness to Local providers in a Core-managed child using normal password login,
  advertised Core/app preview URLs, separate data and observed service readiness.
- Check selected-only native dependency closures and independent release/cache inputs. Harness
  installs and images must contain no Codex SDK, Claude SDK or provider-runtime package.
- Exercise native Windows, macOS and Linux process/filesystem/network behavior on those hosts.
  Protocol fixtures, cross-compilation and Linux containers on macOS are not native OS evidence.
- Preserve unknown native stop/effects and source leases; verify owned sandbox Finish cleanup.
  The heavyweight task suite remains opt-in under the repository verification policy.
