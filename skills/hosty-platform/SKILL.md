---
name: hosty-platform
description: Understand and operate a Hosty instance through its authorized tools, including apps, permissions, workspaces and isolated previews. Use for platform navigation, app operations and diagnosing Hosty state.
---

# Hosty Platform

Hosty is a self-hosted application platform. Read [the platform introduction](references/introduction.md)
for its component model and authority boundaries. This package ships with Core; its catalog entry
identifies the running Core version. Installed applications and clients can have independent versions.

## Orient To The Actual Instance

Identify the Core instance and app the user means before changing anything. Read the host status
and installed app directory through the tools available in this client. Resolve informal app names
to returned IDs; use display names in conversation. Inspect current state, runtime and advertised
URLs rather than inferring them from a repository or an old browser tab.

Core is usable through its API and CLI without any standard applications. Shell is a UI client;
Harness supplies agent conversations, profiles and execution; Documents presents source-backed
documentation. Their names describe common distribution apps, not identities Core requires or
permission grants. Discover installed capabilities from current declarations.

## Operate And Diagnose

Prefer typed Core/app tools for supported operations. The operator CLI is another supported client
when separately authorized. Check the returned operation state and current readiness after an action:
a request being accepted does not prove that a process started, an update completed or data changed.
Use app logs for runtime failures and the audit log for actions performed on the instance.

Use the supported lifecycle, update, backup and recovery operations. Select the intended data root
explicitly in CLI operations. Do not edit Core's private registry or stop/remove its containers with
raw Docker commands. A refused operation explains a missing permission or unavailable capability;
report it and preserve work, rather than changing credentials or clients to bypass the refusal.

## Source And Preview

Runtime source, a registered development workspace and an agent's current directory are different
things. For source edits, prepare or resume the authorized workspace and read its repository rules.
Keep required activity leases while native editors/processes use that worktree. A dirty workspace
is preserved work, not proof of a published change. Commits, publication and cleanup need their
own authorization.

A Core-managed sandbox/child Core provides a separate preview with its own users and data. Use
normal setup/login and advertised Core/app preview URLs. It does not authorize using production
data, switching an installed app into development mode or restarting the parent Core. Finish an
owned preview through its managing Core after collecting useful results; retain unfinished source.
Use the environment-specific tools supplied by the current client; an agent worker is not an app
preview server. Native and system workloads retain their supported test paths.

For creating or changing applications, use `hosty-app-skill` when selected. The running Core's
`get_app_development_guide` (or Harness `app_creation_guide`) supplies versioned development topics.
Its read access grants no mutation authority. If this client lacks a required tool, describe that
limitation rather than assuming another client or host's capabilities.
