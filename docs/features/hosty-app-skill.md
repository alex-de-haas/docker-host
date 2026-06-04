# Hosty App Skill

## Description

The repository ships a Codex skill for creating, wrapping, updating, and validating Hosty runtime apps that use `schemaVersion: "app.0.1"`.

## Skill Sources

- `skills/hosty-app-skill/SKILL.md`
- `skills/hosty-app-skill/references/app-manifest.md`
- `skills/hosty-app-skill/references/app-auth-and-users.md`
- `skills/hosty-app-skill/references/app-implementation-checklist.md`
- `skills/hosty-app-skill/references/demo-app-patterns.md`

## Current Contract

The skill should guide agents toward:

- `apps/{app}/manifest.json`
- Core-managed local runs through `hosty apps install ... --runtime dev`
- app auth code exchange and app-origin sessions
- scoped app directory access through `HOSTY_APP_SERVICE_TOKEN`
- app-owned role storage under the app data directory
- app data backups through Core
