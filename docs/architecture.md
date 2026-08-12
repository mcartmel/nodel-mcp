# Architecture and Trust Model

This document describes the deployment model and operational trust boundaries for the
public `v0.1.x` preview.

## Core Boundary

The sidecar has three trust domains:

1. **Operator/MCP client** calls the sidecar HTTP/MCP endpoint.
2. **Sidecar process** resolves state, gates writes, keeps approvals/audit, and
   calls Nodel REST APIs.
3. **Nodel runtime** hosts node definitions and performs all side effects.

Only domain `2` is the security boundary this sidecar enforces. The sidecar
does not claim to replace authentication, network isolation, or Nodel-native
security controls.

## API Surface

The sidecar publishes:

- `GET /healthz` for minimal unauthenticated liveness
- protected `GET /readyz` for Nodel readiness and runtime connectivity checks
- `POST /mcp` MCP Streamable HTTP JSON-RPC endpoint

The MCP tool set and schema are registered from a single canonical tool
registry. The generated tool reference in
[`docs/tool-reference.generated.md`](tool-reference.generated.md) is the canonical
contract surface for external clients.

Each collected `ToolSpec` contains the complete captured SDK definition, its actual
Zod input schema and generated JSON input schema, handler, and policy metadata. The
same collected specs are used for runtime registration and documentation generation;
there are no parallel tool definitions.

## Nodel discovery and SSRF controls

The sidecar applies a trusted-resolution policy:

- It loads and normalizes `NODEL_BASE_URL` and treats it as the trust root.
- It validates caller-supplied strings that look like local names.
- It resolves nodes against the local runtime discovery endpoints first.
- It does not blindly fetch caller-supplied URLs.
- Runtime-origin overrides for explicit `runtimeUrl` operations must be in
  `NODEL_ALLOWED_RUNTIME_ORIGINS`.
- Only resolved endpoints from the trusted discovery flow are used for sidecar
  follow-up calls.

This blocks SSRF-style arbitrary URL probing through MCP arguments in normal
operation.

## Read/Write Boundary

The sidecar keeps read behavior permissive but write behavior tightly gated:

- Read-only mode is default (`NODEL_ENABLE_WRITES=false`).
- Write tools are unavailable unless write/lifecycle/delete gates are enabled.
- Every mutable flow requires an operation plan, proposal checks, and audit records.
- Only HTTP `404` is treated as missing for write-readback logic; all other status
  and network failures are surfaced as operational failures.

## State, backup, and audit data

State lives in `NODEL_STATE_DIR` and includes approvals, audit trail, and backup
artifacts.

- Permissions are expected to be process-restricted for confidentiality.
- Approval IDs are single-use and operation-bound.
- Audit records capture `attempted`, `succeeded`, `failed`, and `ambiguous`
  outcomes with request ids and normalized operation metadata. A post-side-effect
  audit failure leaves an orphan `attempted` record and returns
  `succeeded_audit_failed`.
- `succeeded_verification_pending` describes a tool's post-write verification state;
  it is not an audit outcome.
- Backups preserve previous parameter/binding state when available.

Backups may include sensitive values and must be treated as secrets.

## Approval limitations

`nodel.approve_write` and MCP elicitation are operator workflow tools only:

- They do not represent an external authorization authority.
- They do not alter file/OS permissions or OS-level process controls.
- They depend on out-of-band trust in the configured operator and deployment.

For the definitive statement, see
[`SUPPORT.md`](../SUPPORT.md) and [`SECURITY.md`](../SECURITY.md).

## Observability and telemetry

This preview does not include external telemetry beacons. Internal logs are
structured, redact secrets and bearer tokens, and include request correlation
identifiers where available.

## What this architecture does not do

- Provide transaction boundaries for Nodel-side mutations.
- Guarantee external write idempotence.
- Replace Nodel runtime controls.
- Provide multi-user isolation or tenant-aware authorization.
