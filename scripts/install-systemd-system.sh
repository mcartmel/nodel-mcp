#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH="" cd -- "$(dirname -- "$0")/.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/nodel-ai}"
ENV_FILE="${ENV_FILE:-/etc/nodel-ai.env}"
STATE_DIR="${STATE_DIR:-/var/lib/nodel-ai}"
SERVICE_USER="${SERVICE_USER:-nodel-ai}"
SERVICE_FILE="/etc/systemd/system/nodel-ai.service"
NODE_BIN="${NODE_BIN:-}"
DRY_RUN="${NODL_INSTALL_DRY_RUN:-${INSTALL_DRY_RUN:-0}}"

run_file_action() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '%s\n' "DRY-RUN: $*"
  else
    "$@"
  fi
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

assert_no_symlink_path_component() {
  path="$1"
  label="$2"
  if [ -L "$path" ]; then
    fail "Refusing to use ${label}: final path is a symlink: $path"
  fi

  _old_ifs=$IFS
  IFS=/
  _current=""
  if [ "${path#/}" != "$path" ]; then
    _current="/"
    _path="${path#/}"
  else
    _path="$path"
  fi

  for _component in $_path; do
    if [ -z "$_component" ] || [ "$_component" = "." ]; then
      continue
    fi

    if [ "$_component" = ".." ]; then
      fail "Refusing to use ${label}: traversal component is not allowed in ${path}"
    fi

    if [ -z "$_current" ] || [ "$_current" = "/" ]; then
      _current="/$_component"
    else
      _current="$_current/$_component"
    fi

    if [ -L "$_current" ]; then
      fail "Refusing to use ${label}: path component is a symlink: $_current"
    fi
  done
  IFS=$_old_ifs

  unset _component _current _old_ifs
}

assert_regular_path_mode_owner() {
  path="$1"
  kind="$2"
  expected_uid="$3"
  expected_gid="$4"
  required_mode="$5"
  label="$6"

  if [ -L "$path" ]; then
    fail "Refusing to use ${label}: ${path} is a symlink"
  fi

  if [ "$kind" = "directory" ] && [ ! -d "$path" ]; then
    fail "Refusing to use ${label}: expected an existing directory at ${path}"
  fi
  if [ "$kind" = "file" ] && [ ! -f "$path" ]; then
    fail "Refusing to use ${label}: expected an existing regular file at ${path}"
  fi

  actual_uid="$(stat -c %u "$path")"
  actual_gid="$(stat -c %g "$path")"
  actual_mode="$(stat -c %a "$path")"

  if [ "$actual_uid" -ne "$expected_uid" ] || [ "$actual_gid" -ne "$expected_gid" ]; then
    fail "Refusing to use ${label}: expected owner ${expected_uid}:${expected_gid}, found ${actual_uid}:${actual_gid}"
  fi

  if [ "$actual_mode" -ne "$required_mode" ]; then
    fail "Refusing to use ${label}: expected mode ${required_mode}, found $(printf '%03o' "$actual_mode")"
  fi
}

for path_name in "INSTALL_DIR:$INSTALL_DIR" "ENV_FILE:$ENV_FILE" "STATE_DIR:$STATE_DIR"; do
  _entry_name=$(printf '%s' "$path_name" | cut -d: -f1)
  _entry_path=$(printf '%s' "$path_name" | cut -d: -f2-)
  assert_no_symlink_path_component "$_entry_path" "$_entry_name"
done

if [ "$DRY_RUN" != "1" ] && [ "$(id -u)" -ne 0 ]; then
  fail "Run as root, for example: sudo $0"
fi

if [ -n "$NODE_BIN" ]; then
  SELECTED_NODE_BIN="$NODE_BIN"
elif command -v node >/dev/null 2>&1; then
  SELECTED_NODE_BIN="$(command -v node)"
else
  fail "Could not find node on PATH. Set NODE_BIN=/path/to/node."
fi

if ! getent group "$SERVICE_USER" >/dev/null 2>&1; then
  if [ "$DRY_RUN" != "1" ]; then
    run_file_action groupadd --system "$SERVICE_USER"
  fi
elif [ "$DRY_RUN" = "1" ]; then
  true
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  if [ "$DRY_RUN" = "1" ]; then
    fail "SERVICE_USER must exist for dry-run checks: $SERVICE_USER"
  fi

  if [ -x /usr/sbin/nologin ]; then
    NOLOGIN_SHELL=/usr/sbin/nologin
  elif [ -x /sbin/nologin ]; then
    NOLOGIN_SHELL=/sbin/nologin
  else
    NOLOGIN_SHELL=/bin/false
  fi

  run_file_action useradd --system --gid "$SERVICE_USER" --home-dir /nonexistent --shell "$NOLOGIN_SHELL" "$SERVICE_USER"
fi

SERVICE_UID="$(id -u "$SERVICE_USER")"
SERVICE_GID="$(id -g "$SERVICE_USER")"

if [ ! -f "$ROOT_DIR/dist/index.js" ]; then
  fail "Missing $ROOT_DIR/dist/index.js; install the release archive (no build is required)."
fi
if ! "$SELECTED_NODE_BIN" -e 'process.exit((Number(process.versions.node.split(".")[0]) < 22) ? 1 : 0)' ; then
  fail "Node.js 22 or newer is required: $SELECTED_NODE_BIN"
fi

if [ -e "$INSTALL_DIR" ]; then
  if [ -L "$INSTALL_DIR" ] || [ ! -d "$INSTALL_DIR" ]; then
    fail "Refusing to use INSTALL_DIR: expected a directory at ${INSTALL_DIR}"
  fi
else
  run_file_action mkdir -p "$INSTALL_DIR"
fi

if [ "$ROOT_DIR" != "$INSTALL_DIR" ]; then
  run_file_action cp -R "$ROOT_DIR"/. "$INSTALL_DIR"/
  if [ ! -f "$INSTALL_DIR/dist/index.js" ]; then
    fail "Installation did not produce $INSTALL_DIR/dist/index.js; use a complete release archive."
  fi
fi

if [ -e "$STATE_DIR" ]; then
  assert_regular_path_mode_owner "$STATE_DIR" directory "$SERVICE_UID" "$SERVICE_GID" 700 "state directory"
else
  run_file_action mkdir -p "$STATE_DIR"
  run_file_action chown "$SERVICE_UID:$SERVICE_GID" "$STATE_DIR"
  run_file_action chmod 0700 "$STATE_DIR"
fi

if [ -e "$ENV_FILE" ]; then
  assert_regular_path_mode_owner "$ENV_FILE" file "$SERVICE_UID" "$SERVICE_GID" 600 "environment file"
else
  run_file_action mkdir -p "$(dirname -- "$ENV_FILE")"
  run_file_action cp "$ROOT_DIR/.env.example" "$ENV_FILE"
  run_file_action chown "$SERVICE_UID:$SERVICE_GID" "$ENV_FILE"
  run_file_action chmod 0600 "$ENV_FILE"
fi

run_file_action "$SELECTED_NODE_BIN" "$ROOT_DIR/scripts/systemd-render.mjs" "$ROOT_DIR/systemd/nodel-ai.system.service.in" "$SERVICE_FILE" \
  "INSTALL_DIR=$INSTALL_DIR" "ENV_FILE=$ENV_FILE" "STATE_DIR=$STATE_DIR" \
  "SERVICE_USER=$SERVICE_USER" "NODE_BIN=$SELECTED_NODE_BIN"

run_file_action systemctl daemon-reload
run_file_action systemctl enable nodel-ai.service

printf '%s\n' "Installed system service: $SERVICE_FILE"
printf '%s\n' "Install app files under: $INSTALL_DIR"
printf '%s\n' "Config file: $ENV_FILE"
printf '%s\n' "State directory: $STATE_DIR"
printf '%s\n' "Start with: systemctl start nodel-ai.service"
printf '%s\n' "Logs: journalctl -u nodel-ai.service -f"
