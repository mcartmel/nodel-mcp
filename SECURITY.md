# Security Policy

## Supported version

The current `v0.1.x` pre-1.0 public preview is the only supported release
line for security reports. Read-only functionality is preview-supported;
write, lifecycle, and delete tools are experimental and disabled by default.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/mcartmel/nodel-mcp/security/advisories/new)
for this repository. Do not
open a public issue or include exploitable details in a pull request. Include
the affected version, deployment shape, reproduction steps, impact, and any
safe mitigation. Reports are reviewed on a best-effort basis; there is no
response-time or remediation-time promise.

## Threat model

This is a single-operator sidecar intended for direct loopback use or behind
a trusted TLS reverse proxy. It is not a multi-user or multi-tenant service.
Treat the Nodel runtime, its network discovery, state directory, MCP client,
and any configured bearer token as trusted deployment inputs. Do not expose
the service directly to an untrusted network.

Write approval is a workflow guardrail, not independent authorization.
`nodel.approve_write` is the documented fallback when MCP elicitation is not
available and depends on client/operator discipline.

The sidecar permits one process per state directory. Approval updates and audit
append/rotation are synchronous within that process, so they do not interleave;
the PID startup lock excludes a second writer. A stale or malformed lock is
handled conservatively and may require operator recovery.

State directories must be `0700` and files `0600`; the supplied systemd units use
`UMask=0077`. Audit entries record `attempted`, `succeeded`, `failed`, `ambiguous`,
and operation and request IDs. A post-side-effect audit failure leaves an orphan
`attempted` record and returns `succeeded_audit_failed`.
`succeeded_verification_pending` is a tool status, not an audit outcome. There is
no telemetry.

The static recipe verifier is heuristic only. It may falsely flag valid dynamic
code or miss unsupported behavior, does not fully parse or execute Jython, and
cannot replace runtime verification in Nodel.

Write safety uses in-process keyed locks and optimistic expected hashes. Hashes do
not exclude races from another process or external Nodel actor, and a timeout or
lost response can leave a nontransactional mutation ambiguous; readback may be
unavailable or inconclusive. TLS, certificate validation, forwarding of
`Authorization`/`Origin`, and proxy body limits are the operator's trusted
reverse-proxy responsibility.

Approval fallback is a workflow mechanism, not independent authentication.

## Disclosure

Please avoid public disclosure until maintainers have had a reasonable
opportunity to assess a report. This project makes no SLA or guaranteed
security-fix commitment.
