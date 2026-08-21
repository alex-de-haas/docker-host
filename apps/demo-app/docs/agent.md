# Demo App

A Hosty reference app for host identity, app-owned roles, and a scoped user directory. Its tools
answer questions about *this host's* people and permissions — not about the internet, and not about
the operator running the agent.

## Where to start

`get_my_app_role` first, always. Everything else this app exposes is gated on the caller's app role,
so a refusal further in is usually this answer arriving late. It returns the role **and** the
permission list behind it, which is what tells you whether to attempt the rest at all.

## What the words mean here

- **Host role** (`host.admin`, `host.user`) is Hosty's, and this app does not grant it.
- **App role** is the demo app's own, assigned per user by an administrator. The two are independent:
  a host administrator with no app role has no permissions here, and that is not a misconfiguration.
- **App directory** is the set of host users explicitly assigned to this app. It is deliberately not
  the host's user list — an app never sees people who were not given to it.

## When a call is refused

Read the permission name in the error rather than retrying. `demo.people.read` missing means the
operator has not been assigned, and no amount of retrying changes an assignment. Say which permission
is missing and stop; a human grants it in Shell, and only then is the call worth repeating.

## What not to do

Do not infer the fleet from this app. It knows its own users and nothing about other apps, so
questions about what else runs on the host belong to the host's own tools.
