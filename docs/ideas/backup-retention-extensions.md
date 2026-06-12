# Backup Retention Extensions

Status: Idea.

## Context

Current backup retention uses global defaults. Manual backups are kept until explicit deletion. Automatic `pre-update`, `pre-restore`, `pre-runtime-switch`, and `scheduled` backups keep the latest five backups per app. Cleanup preview and apply are implemented for Core, Shell, and CLI.

## Ideas

- Add age-based cleanup rules.
- Add per-app retention overrides.
- Expand retention policy support for the only known backup candidate if a product need is identified.

## Boundaries

- Keep the current conservative default policy unless a new spec explicitly changes it.
- Cleanup must continue to verify candidate paths stay under the Hosty backup root.
- Cleanup apply should continue to require a reviewed plan digest.

