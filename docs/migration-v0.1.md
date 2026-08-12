# Migration to v0.1.x Public Preview

This guide applies to operators upgrading from earlier local builds.

## Pre-migration actions

1. Stop the existing sidecar process.
2. Back up runtime files:

```sh
cp .env .env.backup-$(date +%Y%m%d-%H%M%S)
cp -R .state .state.backup-$(date +%Y%m%d-%H%M%S)
```

3. Record current `NODEL_*` policy settings for comparison.
4. Verify non-loopback access has token/origin policy where required.

## New/changed settings to review

- `NODEL_MCP_TOKEN` and exact `MCP_ALLOWED_ORIGINS` are enforced for non-loopback
  service exposure; non-loopback operation is not multi-user and requires TLS at
  a trusted reverse proxy. `NODEL_BASE_URL` origin is always allowed. `NODEL_ALLOWED_RUNTIME_ORIGINS` only adds exact additional runtime origins, and an empty list means no additional explicit origins.
- `MCP_TRUST_REQUEST_ID_HEADER`, `MCP_REQUEST_BODY_LIMIT_BYTES`, and
  `MCP_SHUTDOWN_TIMEOUT_MS` add request identity, bounded bodies, and bounded
  shutdown behavior. `NODEL_ALLOWED_NODE_PREFIXES` restricts visible node names.
- `NODEL_STATE_DIR`, approval TTL, post-write settle/readiness timeouts, Nodel
  and public-recipe request timeouts, audit rotation, and backup retention are
  configurable; review every default in [`operations.md`](operations.md).
- Lifecycle gates now depend on one another: lifecycle requires writes, and
  deletes require writes plus lifecycle plus the explicit delete gate.
- Setting `NODEL_REQUIRE_WRITE_APPROVAL=false` is an unsafe warning. Pending
  approvals are invalidated and must be freshly approved after migration.
- Missing-file semantics changed for supporting-file reads: only explicit HTTP 404 is
  treated as missing.
- `nodel.create_node` no longer accepts legacy ignored inputs (`description`,
  `files`).
- Proposal/dry-run tools are available read-only; applying still requires the
  relevant gates and approval. Canonical tool metadata now exposes capability,
  stability, and gate requirements.
- Responses use top-level `ok` and `resultOk` (domain result status does not
  change tool transport success), uniform errors, and typed error codes.
- No-op writes return `no_change` before approval, backup, or audit side effects.
- Write results use named verification statuses and readback results; a successful
  external mutation may be `succeeded_verification_pending` when verification is
  unavailable. Only HTTP 404 means a resource is missing.
- Audit records now include attempted/succeeded/failed/ambiguous outcomes
  and stable operation ids.

## Explicit breaking-change inventory

The table below captures the public-preview contract changes for affected tools.
It intentionally stays in migration notes even though complete field-level schemas
are in [`docs/tool-reference.generated.md`](tool-reference.generated.md).

| Tool or tool group                          | Old contract                                                                         | New contract                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| All tools (response envelope)               | Tool responses were consumed as direct payloads.                                     | Every tool now uses a stable transport envelope with `ok`, `resultOk`, and `error`. Success remains `{ ok: true, ...payload }`; legacy payload `ok` fields are surfaced as `resultOk` when present. Error paths are `{ ok: false, status, error }` where status is `ambiguous`, `remote_failed`, or `failed` (derived from typed `error.code`).                                                                                                                          |
| Proposal tooling                            | Proposal/apply flows were less explicit in earlier local builds.                     | The exact proposal tools now always remain read-only and proposal-only: `nodel.propose_node_bindings`, `nodel.propose_context_bindings`, `nodel.propose_recipe_script`, `nodel.propose_recipe_script_edit`, `nodel.propose_node_file_text`, `nodel.propose_node_file_base64`, `nodel.propose_node_file_edit`. They are always available with `capability: proposal` and gate `always`; apply tools still require normal side-effect gates + approval.                    |
| `nodel.create_node` input contract          | Legacy builds accepted ignored migration-only fields like `description` and `files`. | Input contract is now strict and limited to `name`, `runtimeUrl`, `dryRun`, `approvalId`, and `reason`. `description` and `files` are no longer accepted, and lifecycle gating still requires writes before apply.                                                                                                                                                                                                                                                       |
| Parameter, binding, recipe, and file writes | Parameter and file writes did not uniformly expose no-op short-circuit behavior.     | `nodel.set_node_parameter`, `nodel.patch_node_parameters`, `nodel.set_node_parameters`, `nodel.set_node_bindings`, `nodel.patch_node_bindings`, `nodel.apply_node_binding_plan`, `nodel.save_recipe_script`, `nodel.apply_recipe_script_edit`, `nodel.save_node_file_text`, `nodel.save_node_file_base64`, and `nodel.apply_node_file_edit` return `status: no_change` when no state change is detected. In `no_change`, approval, backup, and audit writes are skipped. |
| Action and lifecycle mutation verification  | Mutation tools returned success without explicit post-apply status.                  | `nodel.call_action`, `nodel.restart_node`, `nodel.create_node`, and `nodel.delete_node` return explicit verification strategy/status. Successful paths resolve to `succeeded_verified` or `succeeded_verification_pending`; when no durable verification is available, callers get guidance for follow-up list/describe checks.                                                                                                                                          |
| Status and audit outcomes                   | Status and audit channels were mixed in some flows.                                  | Write flow statuses are now explicit: `no_change`, `succeeded_verified`, `succeeded_verification_pending`. Transport failure statuses are `ambiguous`, `remote_failed`, and `failed`. Write audit records are separate lines with `attempted`, `succeeded`, `failed`, and `ambiguous` outcomes. A failed post-side-effect audit returns `succeeded_audit_failed` and leaves the orphan `attempted` record.                                                               |

## Public status and error contract

- Exact write/status values now used by callers:
  - Success/flow states: `no_change`, `succeeded_verified`, `succeeded_verification_pending`.
  - Top-level transport failure states: `ambiguous`, `remote_failed`, `failed`, `succeeded_audit_failed`.
- The legacy `ok` domain flag is still accepted in payload data when present, but is
  surfaced to callers as `resultOk` to keep transport success separate from domain
  status.
- Error payload fields are stable and typed: `code`, `message`, `retryable`, and
  optional `ambiguous`.
- Recognized error codes include:
  - `VALIDATION`, `CONFLICT`, `APPROVAL_REQUIRED`, `POLICY`, `STATE`, `REMOTE`,
    `INTERNAL`
  - `NODEL_*` transport errors (for example `NODEL_NOT_FOUND`, `NODEL_HTTP`,
    `NODEL_TIMEOUT`, etc.)
  - `AUDIT_POST_SIDE_EFFECT`, `AUDIT_REMOTE_FAILURE`
- Transport failure status is computed from code classification:
  - `ambiguous` when `error.ambiguous === true`
  - `remote_failed` when the code is `NODEL_*`
  - `failed` for all other errors

## Audit outcomes

Audit JSONL records persist four outcomes:

- `attempted`: written before the remote mutation
- `succeeded`: written after successful remote mutation
- `failed`: written when remote mutation fails before returning a response
- `ambiguous`: written when the mutation request may have reached Nodel but its
  result cannot be known, such as a timeout, network loss, invalid response, or
  rejected redirect after dispatch
- A failed post-side-effect audit leaves the durable `attempted` record in place;
  the tool reports `succeeded_audit_failed` with its operation id.

`succeeded_verification_pending` is a tool result status: the remote mutation was
accepted and durably audited as `succeeded`, but post-write verification did not
complete. It is not an audit outcome.

The operation id is stable across attempts and is emitted in tool results to
correlate proposals, backups, and audit lines.

## Backward compatibility notes

Before `1.0.0`, patch releases should avoid intentional breaking changes and minor
releases may break MCP compatibility. `v0.1.x` does **not** provide compatibility
shims and documents breaking changes in changelog notes.

## Importing existing configuration

1. Start the new version with write tools disabled.
2. Run health/read smoke checks against read endpoints.
3. Re-enable maintenance mode only when required.
4. Expect pending approvals carried over from older formats to be invalidated.

If a write mode is enabled, re-establish your operator workflow for:

- `nodel.get_write_status`
- proposal/dry-run tooling
- re-approval for each applied write operation

## Backup, audit, and pending approval invalidation

Existing pending approvals from earlier formats are treated as invalid after upgrade;
request fresh operator confirmations.

Existing read and backup files are still readable where possible, but do not assume
automatic continuity for in-flight approvals.

## Startup verification

After startup in read-only mode:

1. Confirm `GET /healthz` succeeds.
2. Confirm one or more read operations (`list_nodes`, `get_node_parameters`,
   `read_recipe`) succeed in your environment.
3. Confirm readiness checks match your deployment policy.

Only after these checks are green should you enable any experimental write tooling.

## Complete rollback

1. Stop the sidecar and confirm no live process owns `.instance.lock`.
2. Restore the previous release files, dependencies, `.env`, and state directory.
3. Start the restored sidecar read-only and run health, readiness, and read smoke checks.
4. If Nodel state changed during the failed upgrade, inspect current parameters
   and bindings. A sidecar rollback cannot undo Nodel mutations.
5. Restore parameters or bindings only through a newly reviewed, dry-run write
   plan with fresh approval, or through the manual Nodel operator process.

External changes are nontransactional; do not retry solely because the sidecar
reported a timeout or ambiguous readback.
