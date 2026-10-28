---
name: hosty-app-skill
description: Create, wrap, update and test Hosty applications using the manifest, published SDKs, identity and Core-managed development workflow. Use for application development and Hosty integration.
---

# Hosty App Skill

Build applications that integrate with Hosty Core. This development skill ships with Core alongside
`hosty-platform`; it is selected separately for developer profiles. It works from an exported
package without a checkout of the Hosty repository.

## Establish The Target Contract

Identify the running Core version, language/framework, existing app or new-app request, and the
capabilities available to this client. Retrieve `get_app_development_guide` over authorized direct
Core MCP, or `app_creation_guide` in Harness. Start with `overview`, then read the topics relevant
to the work: `source`, `docker`, `sdk`, `identity`, `preview`, `checks`, `finish`. The response carries
Core version, guide revision and manifest schema. Refresh it after upgrading Core.

An already authorized operator can use `hosty --data-root <root> apps guide --topic <id> --format json`.
Guide reads grant no mutation authority. Do not use another credential or client to bypass a refusal.
If no guide reader is available, use these packaged references and clearly identify any contract
that still needs verification. A repository checkout is evidence when available, not a prerequisite
for using this package.

## Create Or Change An Application

Use the client's supported app-creation/workspace tools and the repository's instructions. The
packaged Node/React starter is a default, not a required stack. Prepare or resume the registered
workspace before edits; preserve the original/shared source checkout. Retain activity leases while
native consumers run. Select the intended Core/data root explicitly for lifecycle operations.

Read [SDK and app creation](references/sdk-and-app-creation.md) when choosing a stack or integrating
authentication. Read only the additional references needed for the task:

- [Manifest](references/app-manifest.md): schema `app.0.1`, runtime services, settings, data,
  dependencies, backups and app-owned MCP interfaces.
- [Identity and users](references/app-auth-and-users.md): browser sign-in, own-app sessions,
  app-owned roles and scoped directory access.
- [Development mode](references/app-dev-mode.md): ordinary-data development controls and Return;
  use only when the operator explicitly requests a live-data trial.
- [Launch mode](references/app-launch-mode.md): standalone versus embedded UI and navigation.
- [Feeds](references/app-feeds.md): application feed publishing when requested.
- [Demo patterns](references/demo-app-patterns.md): source examples when a repository checkout is
  available. The templates in `assets/app-template` are examples to adapt, not a launch command.

## Validate And Finish

Run affected builds and tests in the registered worktree. For runtime, identity and embedding
acceptance, use a Core-managed sandbox/child Core with separate data, normal setup/password login
and advertised preview URLs. A standalone app, a direct diagnostic identity token or an agent
worker's local server does not prove browser authentication or Shell embedding works.

Follow the running guide's `preview`, `checks` and `finish` topics and the
[implementation checklist](references/app-implementation-checklist.md). Do not start a second Core
against an active data root or install a test into the ordinary host by default. Use the supported
native/system test path where Docker does not apply. Preserve incomplete source, report observed
results and verification limits, and Finish the owned test environment through its manager.
Commit, publication and a live-data development trial remain separate authorized actions.
