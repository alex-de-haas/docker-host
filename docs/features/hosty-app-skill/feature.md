---
created: 2026-06-01
updated: 2026-10-05
summary: The repository ships hosty-app-skill, an agent skill for creating, wrapping, updating and validating Hosty runtime apps.
components: [skills/hosty-app-skill]
---

# Hosty App Skill

The repository ships `hosty-app-skill`, an agent skill for creating, wrapping, updating and
validating Hosty runtime apps that use `schemaVersion: "app.0.1"`. It works with Claude Code and
Codex (`agents/openai.yaml` carries the Codex metadata).

## Sources

`skills/hosty-app-skill/SKILL.md` is the entry point. Its `references/` folder holds the detailed
guides: the manifest, feeds, auth and users, development and launch modes, the implementation
checklist and Demo App patterns. `scripts/install-hosty-app-skill.sh` installs the skill for local
agents.

## Contract

The skill guides agents toward:

- an `app.0.1` manifest at `apps/{app}/manifest.json` or the app repository root;
- Core-managed local runs through `hosty apps install ... --runtime dev`;
- app auth code exchange and app-origin sessions through the Hosty App SDK;
- scoped app directory access through `HOSTY_APP_SERVICE_TOKEN`;
- app-owned role storage under the app data directory;
- app data backups through Core.

When a manifest or platform contract changes, the skill's references change in the same PR.

## Testing Expectations

- Reference documents name only manifest fields, environment variables and commands that Core and
  the CLI accept; a contract change updates them in the same PR.
- The install script places the skill where Claude Code and Codex discover it.
