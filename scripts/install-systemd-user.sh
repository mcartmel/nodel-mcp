#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH="" cd -- "$(dirname -- "$0")/.." && pwd)"
SERVICE_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SERVICE_DIR}/nodel-ai.service"
INSTALL_DIR="${INSTALL_DIR:-$ROOT_DIR}"
ENV_FILE="${ENV_FILE:-$INSTALL_DIR/.env}"
STATE_DIR="${STATE_DIR:-$INSTALL_DIR/.state}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
DRY_RUN="${NODL_INSTALL_DRY_RUN:-${INSTALL_DRY_RUN:-0}}"

CURRENT_UID="$(id -u)"
CURRENT_GID="$(id -g)"

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

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  fail "Could not find a supported Node executable; set NODE_BIN=/path/to/node."
fi

if ! "$NODE_BIN" -e 'process.exit((Number(process.versions.node.split(".")[0]) < 22) ? 1 : 0)' ; then
  fail "Node.js 22 or newer is required: $NODE_BIN"
fi

if [ ! -f "$INSTALL_DIR/dist/index.js" ]; then
  fail "Missing $INSTALL_DIR/dist/index.js; install the release archive (no build is required)."
fi

if [ -e "$STATE_DIR" ]; then
  assert_regular_path_mode_owner "$STATE_DIR" directory "$CURRENT_UID" "$CURRENT_GID" 700 "state directory"
else
run_file_action mkdir -p "$STATE_DIR"
run_file_action chmod 0700 "$STATE_DIR"
fi

if [ -e "$ENV_FILE" ]; then
  assert_regular_path_mode_owner "$ENV_FILE" file "$CURRENT_UID" "$CURRENT_GID" 600 "environment file"
else
  run_file_action mkdir -p "$(dirname -- "$ENV_FILE")"
  run_file_action cp "$ROOT_DIR/.env.example" "$ENV_FILE"
  run_file_action chmod 0600 "$ENV_FILE"
fi

run_file_action mkdir -p "$SERVICE_DIR"
run_file_action "$NODE_BIN" "${ROOT_DIR}/scripts/systemd-render.mjs" "${ROOT_DIR}/systemd/nodel-ai.service" "$SERVICE_FILE" \
  "INSTALL_DIR=$INSTALL_DIR" "ENV_FILE=$ENV_FILE" "STATE_DIR=$STATE_DIR" "NODE_BIN=$NODE_BIN"

run_file_action systemctl --user daemon-reload
run_file_action systemctl --user enable nodel-ai.service

printf '%s\n' "Installed user service: ${SERVICE_FILE}"
printf '%s\n' "Start with: systemctl --user start nodel-ai.service"
printf '%s\n' "Logs: journalctl --user -u nodel-ai.service -f"
