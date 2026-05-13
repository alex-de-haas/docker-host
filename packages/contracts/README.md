# Contracts

This package is reserved for the shared Host API contract between:

- `apps/host` Web UI;
- `apps/host` backend API;
- future `apps/cli` module commands.

Executable OpenAPI files and generated clients are deferred until the endpoint model stabilizes. Changes in this directory are treated as shared contract changes and must trigger both Host and CLI checks.
