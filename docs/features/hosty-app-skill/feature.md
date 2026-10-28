---
created: 2026-06-01
updated: 2026-10-28
summary: The repository ships hosty-app-skill, an agent skill for creating, wrapping, updating and validating Hosty runtime apps.
components: [skills/hosty-app-skill, apps/core]
---

# Hosty App Skill

Core ships the repository's complete `hosty-app-skill` package, an agent skill for creating, wrapping, updating and
validating Hosty runtime apps that use `schemaVersion: "app.0.1"`. It works with Claude Code and
Codex (`agents/openai.yaml` carries the Codex metadata). It appears in the shared Skills library
with the running Core version and remains optional in Harness profiles. The separate
[platform skill](../core-platform-skills/feature.md) supplies general operating context.

## Sources

`skills/hosty-app-skill/SKILL.md` is the entry point. Its `references/` folder holds the detailed
guides: SDK/app creation, the manifest, feeds, auth and users, managed development and test modes,
the implementation checklist and Demo App patterns. Package-relative links work after export
without a repository checkout. The running Core development guide supplies version-specific API
and manifest detail through `get_app_development_guide` or Harness `app_creation_guide`. `scripts/install-hosty-app-skill.sh` installs the skill for local
agents.

## Contract

The skill guides agents toward:

- an `app.0.1` manifest at `apps/{app}/manifest.json` or the app repository root;
- registered development workspaces and Core-managed test sandboxes, using supported Docker or
  local recipes with separate test data and normal password login;
- published `@hosty-sdk/app` or `HostySdk.App` SDKs for identity and platform integration;
- app auth code exchange and app-origin sessions through the Hosty App SDK;
- scoped app directory access through `HOSTY_APP_SERVICE_TOKEN`;
- app-owned role storage under the app data directory;
- app data backups through Core.

When a manifest or platform contract changes, the skill's references change in the same PR.

## Testing Expectations

- Reference documents name only manifest fields, environment variables and commands that Core and
  the CLI accept; a contract change updates them in the same PR.
- Validate both package metadata and relative links outside the repository; check native discovery
  of Core-exported packages without requiring the source checkout.
- The install script places the skill where Claude Code and Codex discover it.
