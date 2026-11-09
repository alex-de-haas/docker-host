---
created: 2026-08-21
updated: 2026-10-26
summary: Apps supply multiple complete SKILL.md packages to Core through stable agent.skills declarations.
components: [apps/core, apps/harness, apps/documents, apps/demo-app]
---

# App-Provided Skill Packages

An app contributes optional reusable guidance to the [shared skill library](../agent-skills/feature.md).
MCP describes callable tools; a package explains useful workflows and can include supporting files.

## Manifest Contract

```json
"agent": {
  "skills": [
    { "key": "default", "path": "skills/my-app" },
    { "key": "review", "path": "skills/my-app-review" }
  ]
}
```

Each path names a complete directory relative to the manifest. Its `SKILL.md` contains YAML
`name` and `description`; the name matches the directory name. References, scripts and assets stay
in their original directory tree. Stable keys preserve selection across app updates; new keys do
not auto-select themselves. Keys and directory paths must be unique and non-overlapping. Core
refuses traversal, symlinks, reserved runtime/data paths and invalid or oversized packages.

Core prepares and validates all declared packages before committing the application record. Name
collisions are checked against the shared library under its publication lock. App updates replace
the supplying app's current package set; removing an app removes its packages and selected exports.
Local manifests supply contained directories. Repository-backed manifest URLs supply packages
from the same repository/ref; Core verifies the fetched manifest against the reviewed digest.

`agent.skillFile` is retired. New installations and updates require `agent.skills`; installed legacy
apps can still be stopped, removed and upgraded. The old single-file read endpoints are removed.
Documents and Demo App use the stable `default` key for their migrated guidance.

## Selection And Authority

Skills are selected independently of MCP permissions and standing instructions. Apps do not inject
all their prose into prompts. Authorized consumers discover/read packages through Core, choose
stable IDs and provision native exports. There is no repeated content-digest acceptance gate.
Updating files does not retract text already loaded by a native conversation.

The library records supplying app/version and preserves complete portable contents. An app skill
does not grant tools, host access or permission to execute a bundled script. Package authors should
describe procedures, domain terms and failure handling rather than duplicate the MCP tool inventory.

## Testing Expectations

- Verify multiple complete packages, nested references and scripts, stable key selection and
  rejection of invalid metadata/paths, overlapping paths and native-name collisions.
- Cover app install/update/removal and failed preparation without replacing existing skills.
- Keep native package discovery separate from MCP tool access and app authentication tests.
