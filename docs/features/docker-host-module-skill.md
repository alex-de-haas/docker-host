# Docker Host Module Skill

## Description

The repository ships a Codex skill for agents that implement Docker Host modules. The skill lives under `skills/docker-host-module` and packages the module workflow, compact references, and a minimal metadata template.

The skill helps agents:

- wrap an existing application as a Docker Host module;
- create new module metadata using the supported `schemaVersion: "0.2"` contract;
- add shell app UI metadata;
- integrate Host gateway identity and scoped user directory access;
- implement module-owned roles;
- validate modules with the local developer-mode workflow.

The skill is intentionally not a copy of the full documentation. `SKILL.md` is a short workflow guide, while `references/` contains focused topic documents that agents load only when needed.

```mermaid
flowchart LR
  A["Agent task"] --> B["skills/docker-host-module/SKILL.md"]
  B --> C["Metadata reference"]
  B --> D["Auth and users reference"]
  B --> E["Developer mode reference"]
  B --> F["Checklist"]
  B --> G["Module template asset"]
  C --> H["Docker Host module implementation"]
  D --> H
  E --> H
  F --> H
  G --> H
```

## Files

- `skills/docker-host-module/SKILL.md` - trigger metadata and core workflow.
- `skills/docker-host-module/agents/openai.yaml` - UI-facing skill metadata.
- `skills/docker-host-module/references/module-metadata.md` - compact metadata schema and lifecycle guide.
- `skills/docker-host-module/references/module-auth-and-users.md` - Host roles, gateway policies, identity tokens, scoped directory, and module-owned roles.
- `skills/docker-host-module/references/module-dev-mode.md` - local developer target workflow.
- `skills/docker-host-module/references/demo-module-patterns.md` - practical patterns from `modules/demo-module`.
- `skills/docker-host-module/references/module-implementation-checklist.md` - final implementation and validation checklist.
- `skills/docker-host-module/assets/module-template/metadata.json` - minimal valid metadata skeleton.

## Installation And Updates

The repository copy is usable by agents that receive this checkout as context.

Inside the Codex app, install it by asking Codex:

```text
Use $skill-installer to install the skill from alex-de-haas/docker-host at skills/docker-host-module.
```

The built-in Codex skill installer installs the GitHub path into `$CODEX_HOME/skills`. It is the preferred first-install path when working inside Codex.

For repeatable command-line updates, run:

```bash
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install-docker-host-module-skill.sh | sh
```

The installer downloads `skills/docker-host-module` from GitHub and atomically installs it into:

```text
${CODEX_HOME:-$HOME/.codex}/skills/docker-host-module
```

Run the same command again to update the global skill. Restart Codex after installing or updating so the skill registry is reloaded.

The command-line installer is intentionally kept even though Codex has a built-in installer, because the built-in installer does not overwrite an existing skill directory. The script is the simple update path for Codex and for other agents or machines that do not have the Codex app helper available.

Install from a local checkout while developing the skill:

```bash
sh scripts/install-docker-host-module-skill.sh --source-dir skills/docker-host-module
```

Install a specific branch, tag, or commit:

```bash
curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install-docker-host-module-skill.sh | sh -s -- --ref main
```

For private forks, set `GITHUB_TOKEN` or `GH_TOKEN`, or pass `--repo OWNER/REPO`.

## Usage From Other Repositories

After installation and Codex restart, open any application repository and invoke the skill explicitly:

```text
Use $docker-host-module to wrap this app as a Docker Host module.
```

The skill may also trigger implicitly for module-related work, but explicit invocation is preferred when converting external application repositories.

## Maintenance

Keep the skill aligned with the source documentation:

- update `references/module-metadata.md` when `docs/features/module-metadata.md` changes;
- update `references/module-auth-and-users.md` when `docs/features/auth-gateway.md` or `docs/features/user-management.md` changes;
- update `references/module-dev-mode.md` when `docs/features/module-developer-mode.md` changes;
- update `references/demo-module-patterns.md` when `modules/demo-module` changes in a way agents should copy.

Run the skill validator after changes:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" skills/docker-host-module
```
