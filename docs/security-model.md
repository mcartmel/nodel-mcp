# Security Model

This document records the security assumptions for the public preview and where
controls are enforced in the sidecar.

## Deployment assumptions

- Single-operator, loopback-first use is the expected baseline.
- Non-loopback exposure should be behind a trusted reverse proxy with strict
  `NODEL_MCP_TOKEN` and `MCP_ALLOWED_ORIGINS` controls.
- Direct exposure to untrusted networks is not supported in this release line.
- TLS termination is the operator's trusted reverse-proxy responsibility; the
  sidecar does not provide TLS and remains a single-operator service. The tested
  Caddy template is an optional aid, never a bundled or automatic installer.

This host currently has plaintext/basic-auth `8080` and unauthenticated `8085`
exposure. This work does not firewall or rebind those listeners; the overall
host is not secure until that exposure is addressed. Caddy rendering only warns.

## Authentication and request filtering

- If set, `NODEL_MCP_TOKEN` must be supplied via `Authorization: Bearer ...` for
  protected routes.
- `MCP_ALLOWED_ORIGINS` is an exact allowlist for browser `Origin` values.
- Non-browser requests without `Origin` are still supported.
- `MCP_REQUEST_BODY_LIMIT_BYTES` constrains request parsing overhead.
- Use `0700` directories and `0600` files. systemd templates set `UMask=0077`.
- Keep the out-of-band bearer token in a `0600` `.env` or equivalent secret
  store. TLS, the allowed CIDR, and the token are layered controls.

## SSRF and endpoint trust

The sidecar constrains URL use to the configured base runtime and trusted
discovery responses. Caller-provided absolute node URLs are not fetched directly.
Explicit `runtimeUrl` values for lifecycle operations are validated by exact
origin. The configured `NODEL_BASE_URL` origin is always allowed.
`NODEL_ALLOWED_RUNTIME_ORIGINS` adds additional exact origins.
An empty list means no additional explicit origins.

## State and secrets

The project treats the following as sensitive:

- `NODEL_MCP_TOKEN`
- `NODEL_STATE_DIR` content (approvals, audit logs, backups)
- Nodel credentials embedded in runtime APIs

Operational guidance:

- Keep state and config paths under restrictive permissions.
- Store backups and audit files on protected filesystems where practical.
- Rotate any exposed credentials before release or visibility changes.

## Approval semantics

Approval is an operational control, not an external authorization layer.

- Native `nodel.request_write_approval` uses MCP form elicitation with an
  unchecked-by-default boolean decision when the client advertises form support.
  The client controls the rendering; this does not guarantee a particular UI or
  universal client support. It is the confirmation step, not an additional
  confirmation after a chat prompt.
- The optional assistant-supplied summary is unverified context and is not bound
  into the proposal hash. Review the detailed proposal identity and consequences
  separately; do not include secrets in the summary.
- Typed `nodel.approve_write` remains a compatibility path for explicit
  `fallbackOnly` or known unavailable form elicitation. Only if
  `fallbackAvailable=true`, obtain explicit operator approval of the exact
  `confirmText` before calling `nodel.approve_write`. A decline, cancellation,
  invalid response, or failure is terminal for that request: do not recommend
  fallback or automatic retry. This is workflow guidance, not durable denial
  enforcement; the manual tool remains callable and cannot establish that a
  human approved anything.
- `ok` is the tool-envelope success flag and `resultOk` is the domain result
  flag. For native approval, inspect both `resultOk=true` and
  `outcome=approved` before applying its approval ID. An unavailable native
  elicitor is a non-error result with `ok=true`, `resultOk=false`,
  `outcome=unavailable`, and `fallbackAvailable=true`; manual approval then
  returns its approval ID on success with `ok=true` (it does not return native
  `outcome=approved`). Other non-error native outcomes include
  `fallbackAvailable=false`; fallback instructions are included only when the
  value is true. When approval is disabled, proposals report
  `approvalRequest.required=false`; skip approval tools in the normal workflow.
  If `nodel.request_write_approval` is unnecessarily called, the helper returns
  `outcome=not_required` without prompting or issuing an approval ID. Callers
  must not invent an approval step.
- Native form confirmation is distinct from MCP client's tool-permission
  dialogs, which are client-controlled and may be separate.
- Approval IDs are short-lived, single-use, and operation-scoped.
- In-process keyed locks serialize writes, expected hashes provide optimistic
  concurrency, and readback reports named verification statuses. These controls
  cannot prevent races from another sidecar/process or make external Nodel
  changes transactional; lost responses remain ambiguous.

## Recipe verification limits

The static recipe verifier is a heuristic Python 2.5/Jython 2.5 and import/call
policy check, not a complete parser or runtime sandbox. It can produce false
positives for valid dynamic or unusual code and false negatives for behavior it
cannot recognize. Always run runtime verification in Nodel after a proposed
recipe change and treat a verifier pass as non-authoritative.

## No external telemetry

No telemetry is required for standard operation. Use local logs for troubleshooting
and audit review only.

Audit records and rotations retain `attempted`, `succeeded`, `failed`, and
`ambiguous` outcomes with operation and request IDs. A post-side-effect audit
failure leaves an orphan `attempted` record and returns `succeeded_audit_failed`.
`succeeded_verification_pending` is a tool status after a successfully audited
mutation, not an audit outcome. Approval fallback is not independent authentication
and must not be used to make the service multi-user.

## Failure behavior

Security-related errors avoid token/path/body leakage. Error payloads avoid stack
traces and return stable machine-readable fields for operational handling.

For exact claims and response examples, see
[`SECURITY.md`](../SECURITY.md).
