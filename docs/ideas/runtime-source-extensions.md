# Runtime Source Extensions

Status: Idea.

## Context

Current runtime source workflows support one app-level source repository, managed checkouts for public-readable HTTP(S) or local repositories, and administrator-selected local source overrides.

## Ideas

- Add a future `source.repositories[]` manifest contract for multi-repository runtime apps.
- Add a Core-owned credential provider for private repositories.
- Define how repository credentials are stored, scoped, rotated, audited, and withheld from Shell-visible state.

## Boundaries

- Current managed checkouts must continue to reject embedded credentials and SSH-style repository URLs.
- Private repositories should use administrator-managed local source overrides until Hosty has a credential provider.
- Multi-repository apps should remain split into separate runtime apps unless a future manifest contract is approved.

