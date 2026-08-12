# Operations Guide

This guide is for day-to-day operation of a `v0.1.x` preview install from the
versioned GitHub Release archive.

## 1) Initial configuration

1. Extract the release archive and copy `.env.example` to `.env`.
2. Run `npm ci --omit=dev`; the archive is precompiled and needs no build.
3. Adjust `.env` and environment variables for your environment.
4. Keep write gates disabled unless maintenance is planned:

```sh
NODEL_ENABLE_WRITES=false
NODEL_ENABLE_NODE_LIFECYCLE=false
NODEL_ENABLE_DELETES=false
```

5. Start with `node dist/index.js` and verify `GET /healthz`.

## 2) Configuration guidance

### Read-only default (`v0.1.x` preview)

- Leave write tools disabled.
- Keep `MCP_BIND_ADDRESS=127.0.0.1` for loopback-only operation.
- Use low-noise log output during observation.

### Complete environment reference

Every variable in `.env.example` is listed here. Empty defaults mean an empty
value, not an omitted policy.

| Variable                                 | Exact default           | Purpose                                               | Safety notes and gate dependencies                                                                                              |
| ---------------------------------------- | ----------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `NODEL_BASE_URL`                         | `http://127.0.0.1:8085` | Nodel REST base URL                                   | Trusted runtime endpoint; do not point at an untrusted service.                                                                 |
| `MCP_PORT`                               | `8765`                  | Sidecar listen port                                   | Use a firewall/proxy when not loopback.                                                                                         |
| `MCP_BIND_ADDRESS`                       | `127.0.0.1`             | Sidecar listen address                                | Non-loopback requires a high-entropy token and exact browser origins.                                                           |
| `NODEL_MCP_TOKEN`                        | empty                   | Bearer token for protected MCP/readiness requests     | Required on non-loopback; use high entropy and never commit it.                                                                 |
| `MCP_ALLOWED_ORIGINS`                    | empty                   | Comma-separated exact browser `Origin` allowlist      | Empty rejects browser-origin requests; do not use `*` for trusted operation.                                                    |
| `MCP_TRUST_REQUEST_ID_HEADER`            | `false`                 | Trust a proxy-supplied `X-Request-Id`                 | Enable only after a trusted proxy sanitizes the header.                                                                         |
| `NODEL_ALLOWED_RUNTIME_ORIGINS`          | empty                   | Exact origins allowed for explicit `runtimeUrl`       | `NODEL_BASE_URL` origin is always allowed. This list adds exact additional origins. Empty means no additional explicit origins. |
| `MCP_REQUEST_BODY_LIMIT_BYTES`           | `1048576`               | Maximum JSON request body                             | Keep aligned with the proxy limit; base64 payloads consume the same cap.                                                        |
| `MCP_SHUTDOWN_TIMEOUT_MS`                | `10000`                 | Graceful shutdown deadline                            | Bounded socket shutdown releases the instance lock.                                                                             |
| `NODEL_ALLOWED_NODE_PREFIXES`            | empty                   | Comma-separated visible node-name prefixes            | Empty permits all node names; restrict this for least privilege.                                                                |
| `NODEL_STATE_DIR`                        | `.state`                | Approvals, audit, lock, and parameter/binding backups | Protect as secret-bearing state; use a private filesystem path.                                                                 |
| `NODEL_ENABLE_WRITES`                    | `false`                 | Enables maintenance writes/actions                    | Required by every side-effecting write/action tool.                                                                             |
| `NODEL_ENABLE_NODE_LIFECYCLE`            | `false`                 | Enables create/restart lifecycle tools                | Requires `NODEL_ENABLE_WRITES=true`.                                                                                            |
| `NODEL_ENABLE_DELETES`                   | `false`                 | Enables node deletion                                 | Requires both writes and lifecycle gates.                                                                                       |
| `NODEL_REQUIRE_WRITE_APPROVAL`           | `true`                  | Requires short-lived approval IDs                     | Disabling is unsafe and emits a warning; this is workflow control, not auth.                                                    |
| `NODEL_WRITE_APPROVAL_TTL_SECONDS`       | `600`                   | Approval lifetime in seconds                          | Approvals are operation-scoped and single-use.                                                                                  |
| `NODEL_POST_WRITE_SETTLE_MS`             | `3000`                  | Delay before readiness/read-back probes               | Tune only for known Nodel restart behavior.                                                                                     |
| `NODEL_POST_WRITE_READY_TIMEOUT_SECONDS` | `20`                    | Maximum post-write readiness wait                     | A timeout can leave an external change ambiguous.                                                                               |
| `NODEL_REQUEST_TIMEOUT_MS`               | `10000`                 | Nodel REST request timeout                            | Bounds calls but does not make remote changes transactional.                                                                    |
| `PUBLIC_RECIPE_REQUEST_TIMEOUT_MS`       | `15000`                 | Public recipe GitHub request timeout                  | Applies to optional public recipe reads only.                                                                                   |
| `NODEL_AUDIT_MAX_BYTES`                  | `10485760`              | Audit JSONL rotation size                             | Rotates at 10 MiB; retain enough files for incident review.                                                                     |
| `NODEL_AUDIT_RETENTION_FILES`            | `5`                     | Number of rotated audit files retained                | Rotation deletes older local records after retention is exceeded.                                                               |
| `NODEL_BACKUP_RETENTION_DAYS`            | `30`                    | Backup age retention                                  | Backups may contain credentials.                                                                                                |
| `NODEL_BACKUP_RETENTION_PER_NODE_KIND`   | `50`                    | Backup count cap per node and kind                    | Applies separately to parameter and binding backups.                                                                            |

### Trusted reverse-proxy TLS example: Caddy

This repository supplies a tested Caddy template and renderer. Caddy is not
bundled or auto-installed. Keep the sidecar loopback-only where possible,
preserve `Authorization` and `Origin`, match the 1 MiB body limit, and layer TLS
with a high-entropy `NODEL_MCP_TOKEN`. Approval IDs are workflow controls, not
authentication. Caddy preserves incoming request headers by default; do not add
`header_up` rewrites for `Authorization` or `Origin`, especially because an
absent `Origin` must remain absent.

#### Local test profile (local-only)

The following is explicitly for the local test host, not a portable default:

```sh
node scripts/caddy-render.mjs \
  --hostname nodel-mcp.internal \
  --bind-address 10.78.0.216 \
  --allow-cidr 10.78.0.0/16 \
  --output ./nodel-mcp.Caddyfile
```

Avoid `.local`, which is reserved for mDNS. Prefer a corporate FQDN. This local
profile uses the organization's trusted `10.78.0.0/16` test, build, and deployment network
because clients may enter through several routed subnets. The CIDR is only one
layer, so retain TLS and the bearer token on a trusted LAN.
The renderer accepts exactly `--hostname`, `--bind-address`, repeated
`--allow-cidr`, `--upstream`, `--body-limit-bytes`, and `--output`.

Choose `--allow-cidr` from the actual client source address observed at the
proxy, not from an `X-Forwarded-For` header. Prefer a dedicated management VLAN
CIDR and a known client IP or small management range over a broad office LAN.

Run `npm run caddy:check -- --config ./nodel-mcp.Caddyfile`. Validation is
optional without Caddy, but `CADDY_REQUIRED=true` fails when Caddy is missing or
not v2. The checker warns, rather than fixes, unrelated listeners.

#### Install, import, and rollback

1. Render a candidate to a new file and check it against the existing config with
   `--existing-config /path/to/caddy/Caddyfile`.
2. The check runs real Caddy syntax validation and adapts the existing file from
   its own directory so relative imports remain valid. It checks adapted HTTP
   host/SNI routes for the hostname conflict, not merely a shared bind/listener.
3. Record any nonblocking `8080`/`8085` listener warnings from the check. A
   missing `ss` prints `Listener diagnostics skipped: ss is unavailable` and has
   `available: false`; it does not authorize or block a rollout by itself.
4. **STOP for explicit operator approval.** Do not alter `.env`, generate or set
   a token, touch the host Caddy configuration, or restart/reload any service before this approval.
5. After approval, set a high-entropy out-of-band `NODEL_MCP_TOKEN` in `.env`
   with mode `0600`, keep the sidecar upstream loopback-only, and restart the
   sidecar. Direct loopback requests to `/mcp` and `/readyz` without credentials
   must both return `401` before Caddy is installed or reloaded.
6. Install Caddy from the operating system package or Caddy's official
   repository. Never download an unverified binary or assume this project
   installed Caddy. Back up the host Caddyfile with a protected `0600` copy
   in a protected directory before editing, for example with a `0700` backup
   directory, `umask 077`, and `chmod 600` on the copied file. Manually review the approved
   candidate as the exact site file configured by the host. Add the matching
   Caddy import to the host Caddyfile only if
   that import is absent. Validate the live Caddyfile, then reload Caddy with
   the host service manager.
7. Verify the Caddy negative preflight: `/mcp` and `/readyz` without the token
   return `401`, a bad token also returns `401`, a client outside the configured
   CIDR receives `403` without an upstream call, and `/healthz` returns `200`
   JSON with `ok: true` and a version. Then run positive authenticated MCP and
   readiness tests from an allowed client, preserving `Authorization` and
   `Origin`. For write-capable operation, verify a proposal is rejected without
   approval and succeeds only after the explicit write-approval flow.
8. On any failure, restore the Caddy backup, validate, and reload it. If the
   sidecar change is implicated, restore its prior `.env`, restart it, and rerun
   the direct-loopback and proxy preflights. Never overwrite a live config blindly.

`tls internal` creates a Caddy internal CA. Export its root certificate and
record its SHA-256 fingerprint. Distribute that root through the approved
Windows trust mechanism and verify the fingerprint before trusting it. Transfer
only the public CA root; never transfer a private key, Caddy data directory, or
server certificate with private material. Configure DNS, or a controlled hosts
entry for the local test, to resolve the hostname to `10.78.0.216`.

For Codex, keep the token out of TOML and JSON and use the protected environment variable:

```toml
[mcp_servers.nodel]
url = "https://nodel-mcp.internal/mcp"
bearer_token_env_var = "NODEL_MCP_TOKEN"
```

This host currently has plaintext/basic-auth `8080` and unauthenticated `8085`
exposure. That is outside this change: the overall host is not secure until
those listeners are firewalled or rebound. The renderer only warns.

### Maintenance window (experimental writes)

1. Enable maintenance gates:

```sh
NODEL_ENABLE_WRITES=true
NODEL_ENABLE_NODE_LIFECYCLE=true   # for create/restart
NODEL_ENABLE_DELETES=false
NODEL_REQUIRE_WRITE_APPROVAL=true
```

2. Confirm expected approval behavior via `nodel.get_write_status`.
3. Execute proposal/dry-run flows first.
4. Require explicit operator confirmation before apply.
5. Return to read-only when done.

## 3) State, backup, and audit checks

- `NODEL_STATE_DIR` holds approvals, audit logs, and backups.
- Backup retention defaults:
  - audit: 10 MiB per file, five files retained
  - backups: 30 days, max 50 per node+kind
- Audit logs are append-only and capture `attempted`, `succeeded`, `failed`, and
  `ambiguous` outcomes, operation ids, and tool context. A failed post-side-effect
  audit leaves an orphan `attempted` record and returns `succeeded_audit_failed`.

State handling is deliberately conservative:

- Create state directories with mode `0700` and state files with mode `0600`.
  The supplied systemd units set `UMask=0077`; verify existing deployments too.
- Only one process may use a state directory. `.instance.lock` contains the
  owner PID and is refused while that PID is live. Never delete a live lock.
- A malformed lock is protected by a five-minute grace period. Dead or expired
  malformed locks are quarantined rather than silently reused; a dead valid lock
  is also quarantined. Inspect the quarantine and process table before recovery.
- Safe recovery is: stop the service, confirm no live owner PID, preserve the
  lock/quarantine evidence, then restart. Do not manually remove a lock for a
  running process.
- Audit rotation is JSONL size-based (`NODEL_AUDIT_MAX_BYTES`) with retained
  files (`NODEL_AUDIT_RETENTION_FILES`). Review outcome, operation, and request
  IDs when correlating a change across logs and Nodel.

List or read backups with the corresponding read-only audit tools. Restoration
is not a file copy shortcut: inspect the backup, create a fresh reviewed and
dry-run write plan, obtain approval, and apply through the normal write tool.
Backups and `.env` can contain credentials. External Nodel changes are
nontransactional; a timeout or lost response can mean the mutation happened,
so inspect Nodel before retrying.

Before any risky change, snapshot state for rollback support:

```sh
cp -R .state .state.backup-$(date +%Y%m%d-%H%M%S)
```

Backups may contain credentials and must be protected like `.env`.

## 4) Upgrades and rollback

### Upgrade checklist

1. Stop the sidecar.
2. Back up `.env` and `.state`.
3. Deploy the new archive files and run `npm ci --omit=dev`; do not build in the install tree.
4. Start in read-only mode.
5. Run readiness and read smoke checks.
6. Enable maintenance gates only if maintenance is required.

### Rollback checklist

1. Stop service immediately.
2. Restore previous release files, dependencies, configuration, and state.
3. Start in read-only mode.
4. Re-run read smoke tests before considering maintenance writes.

Nodel-side mutations are not transactional; if ambiguity occurs, inspect live Nodel
state before retrying operations.

## 5) Health and readiness

- `GET /healthz`: minimal process liveness; no runtime secrets.
- `GET /readyz`: protected Nodel readiness and runtime connectivity check.
- `nodel.health` MCP tool:
  - includes current config and optional reachability checks.
- `nodel.verify_write_plan` and read-back tools support post-apply verification.

## 6) Log interpretation

- Start-up warnings show unsafe mode choices (for example, writes enabled without
  approvals).
- Tool results use stable statuses such as `succeeded_verified`,
  `succeeded_verification_pending`, and `remote_failed`. The pending-verification
  status is not an audit outcome; audit records use only `attempted`, `succeeded`,
  `failed`, and `ambiguous`. `succeeded_audit_failed` is a tool status, not an
  audit outcome.
- On post-write ambiguity, inspect logs and Nodel node state before retries.

## 7) systemd operations

The system and user installers accept configurable install, environment, state,
service user, and Node binary paths. Values are rendered by Node rather than
interpolated through `sed`, so spaces, `#`, `&`, and backslashes are preserved.
Defaults are the extracted directory, `.env`, and `.state` for user installs;
system installs default to `/opt/nodel-ai`, `/etc/nodel-ai.env`, and
`/var/lib/nodel-ai`.

Use the provided scripts:

- `scripts/install-systemd-user.sh`
- `scripts/install-systemd-system.sh`

Before enabling the service, confirm that the deployment directory and state
permissions are writable only by the service user.

## 8) Maintenance readiness

Use `scripts/check-shell-systemd.mjs` before release packaging:

```sh
node scripts/check-shell-systemd.mjs
```

This verifies shell and systemd service templates before shipping.
