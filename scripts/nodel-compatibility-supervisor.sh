#!/usr/bin/env bash
# Starts compatibility services in isolated sessions for the legacy Nodel runtime.
set -u

compat_dir=${NODEL_COMPAT_DIR:?NODEL_COMPAT_DIR is required}
nodel_jar=${NODEL_COMPAT_JAR:?NODEL_COMPAT_JAR is required}
java_bin=${NODEL_COMPAT_JAVA:-java}
node_bin=${NODEL_COMPAT_NODE:-node}
nodel_port=${NODEL_COMPAT_NODEL_PORT:-8085}
sidecar_port=${NODEL_COMPAT_SIDECAR_PORT:-8765}
sidecar_entry=${NODEL_COMPAT_SIDECAR_ENTRY:-dist/index.js}
case "$sidecar_entry" in
  /*) ;;
  *) sidecar_entry="$PWD/$sidecar_entry" ;;
esac
status_file="$compat_dir/startup-status.jsonl"
fifo_path="$compat_dir/nodel.stdin"
cleanup_in_progress=0
script_dir=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
script_path="$script_dir/nodel-compatibility-supervisor.sh"

emit_status() {
  local component=$1 phase=$2 outcome=$3 exit_classification=$4
  printf '{"component":"%s","phase":"%s","outcome":"%s","exitClassification":"%s"}\n' \
    "$component" "$phase" "$outcome" "$exit_classification" >>"$status_file"
}

fail() {
  emit_status "$1" "$2" "failed" "$3"
  printf 'Compatibility startup failed: %s %s.\n' "$1" "$2" >&2
  exit 1
}

# /proc start ticks distinguish a reused PID from our original session leader.
process_metadata() {
  local stat rest
  test -r "/proc/$1/stat" || return 1
  IFS= read -r stat <"/proc/$1/stat" || return 1
  rest=${stat##*) }
  test "$rest" != "$stat" || return 1
  set -f
  # Fields begin with state (3): state, pgrp (5), session (6), starttime (22).
  # shellcheck disable=SC2086 # Intentional field split of the Linux proc stat suffix.
  set -- $rest
  set +f
  test "$#" -ge 20 || return 1
  printf '%s %s %s %s\n' "$1" "$3" "$4" "${20}"
}

record_process_group() {
  local component=$1 pid_file="$compat_dir/$1.pid" pid pgrp start_time state actual_pgrp session actual_start_time
  local attempt
  for ((attempt = 1; attempt <= 50; attempt += 1)); do
    test -s "$pid_file" && break
    sleep 0.1
  done
  read -r pid pgrp start_time <"$pid_file" || fail "$component" "launch" "not_started"
  case "$pid:$pgrp:$start_time" in
    *[!0-9:]* | :* | *:) fail "$component" "launch" "not_started" ;;
  esac
  read -r state actual_pgrp session actual_start_time < <(process_metadata "$pid") || fail "$component" "launch" "not_started"
  if test "$state" = "Z" || test "$pgrp" != "$pid" || test "$actual_pgrp" != "$pid" || test "$session" != "$pid" || test "$actual_start_time" != "$start_time"; then
    fail "$component" "launch" "exited"
  fi
  emit_status "$component" "launch" "started" "running"
}

verified_process_group() {
  local component=$1 pid pgrp start_time state actual_pgrp session actual_start_time
  test -r "$compat_dir/$component.pid" || return 1
  read -r pid pgrp start_time <"$compat_dir/$component.pid" || return 1
  case "$pid:$pgrp:$start_time" in
    *[!0-9:]* | :* | *:) return 1 ;;
  esac
  test "$pid" = "$pgrp" || return 1
  read -r state actual_pgrp session actual_start_time < <(process_metadata "$pid") || return 1
  test "$state" != "Z" && test "$actual_pgrp" = "$pgrp" && test "$session" = "$pid" && test "$actual_start_time" = "$start_time"
}

group_exists() {
  local pgrp=$1
  /bin/kill -0 -- "-$pgrp" 2>/dev/null
}

group_has_live_processes() {
  local stat_path candidate state pgrp session start_time
  for stat_path in /proc/[0-9]*/stat; do
    candidate=${stat_path#/proc/}
    candidate=${candidate%/stat}
    read -r state pgrp session start_time < <(process_metadata "$candidate") || continue
    if test "$pgrp" = "$1" && test "$state" != "Z"; then return 0; fi
  done
  return 1
}

# After TERM the leader may be gone, so prove every survivor remains in its original session.
trusted_surviving_group() {
  local component=$1 pid pgrp leader_start state actual_pgrp session actual_start stat_path candidate found=0
  test -r "$compat_dir/$component.pid" || return 1
  read -r pid pgrp leader_start <"$compat_dir/$component.pid" || return 1
  case "$pid:$pgrp:$leader_start" in
    *[!0-9:]* | :* | *:) return 1 ;;
  esac
  test "$pid" = "$pgrp" || return 1

  # A reused leader PID means its session ID may also have been reused: never signal it.
  if read -r state actual_pgrp session actual_start < <(process_metadata "$pid"); then
    test "$actual_start" = "$leader_start" && test "$actual_pgrp" = "$pgrp" && test "$session" = "$pid" || return 1
  fi

  for stat_path in /proc/[0-9]*/stat; do
    candidate=${stat_path#/proc/}
    candidate=${candidate%/stat}
    read -r state actual_pgrp session actual_start < <(process_metadata "$candidate") || continue
    if test "$actual_pgrp" = "$pgrp" && test "$state" != "Z"; then
      # Session membership and post-leader start time establish attributable descendants.
      test "$session" = "$pid" && test "$actual_start" -ge "$leader_start" || return 1
      found=1
    fi
  done
  test "$found" -eq 1
}

stop_component_group() {
  local component=$1 signal=$2 pid pgrp start_time
  test -r "$compat_dir/$component.pid" || return 0
  read -r pid pgrp start_time <"$compat_dir/$component.pid" || return 1
  case "$pid:$pgrp:$start_time" in
    *[!0-9:]* | :* | *:) return 1 ;;
  esac
  if ! group_exists "$pgrp"; then return 0; fi
  # Verify again immediately before every signal, including the KILL pass.
  verified_process_group "$component" || return 1
  /bin/kill "-$signal" -- "-$pgrp" 2>/dev/null
}

report_cleanup_failure() {
  emit_status "$1" "cleanup" "failed" "cleanup_failed"
  printf 'Compatibility cleanup failed: %s.\n' "$1" >&2
}

cleanup() {
  local component cleanup_failed=0
  if test "$cleanup_in_progress" -ne 0; then return 0; fi
  cleanup_in_progress=1

  for component in sidecar nodel fifo-holder; do
    if ! stop_component_group "$component" TERM; then
      report_cleanup_failure "$component"
      cleanup_failed=1
    fi
  done
  sleep 2
  for component in sidecar nodel fifo-holder; do
    if test -r "$compat_dir/$component.pid"; then
      local pid pgrp start_time
      read -r pid pgrp start_time <"$compat_dir/$component.pid" || {
        report_cleanup_failure "$component"
        cleanup_failed=1
        continue
      }
      case "$pid:$pgrp:$start_time" in
        *[!0-9:]* | :* | *:)
          report_cleanup_failure "$component"
          cleanup_failed=1
          continue
          ;;
      esac
      if group_has_live_processes "$pgrp"; then
        # The verified leader may have exited after TERM; only then use session proof.
        if ! trusted_surviving_group "$component" || ! /bin/kill -KILL -- "-$pgrp" 2>/dev/null; then
          report_cleanup_failure "$component"
          cleanup_failed=1
          continue
        fi
        sleep 0.1
        if group_has_live_processes "$pgrp"; then
          report_cleanup_failure "$component"
          cleanup_failed=1
          continue
        fi
      fi
      emit_status "$component" "cleanup" "stopped" "stopped"
    fi
  done
  cleanup_in_progress=0
  return "$cleanup_failed"
}

wait_for_ready() {
  local component=$1 url=$2 attempt=1
  while test "$attempt" -le 60; do
    verified_process_group fifo-holder || fail fifo-holder "readiness" "exited"
    verified_process_group "$component" || fail "$component" "readiness" "exited"
    if test "$component" = "sidecar"; then verified_process_group nodel || fail nodel "readiness" "exited"; fi
    if curl --silent --fail "$url" >/dev/null 2>&1; then
      emit_status "$component" "readiness" "ready" "running"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  fail "$component" "readiness" "timeout"
}

write_own_metadata() {
  local pid_file=$1 state pgrp session start_time
  read -r state pgrp session start_time < <(process_metadata "$$") || return 1
  test "$state" != "Z" && test "$pgrp" = "$$" && test "$session" = "$$" || return 1
  printf '%s %s %s\n' "$$" "$pgrp" "$start_time" >"$pid_file"
}

run_fifo_holder() {
  write_own_metadata "$1" || exit 1
  exec 3<>"$2"
  exec tail -f /dev/null >&3 2>/dev/null
}

run_nodel() {
  write_own_metadata "$1" || exit 1
  cd "$2" || exit 1
  exec "$3" -jar "$4" -p "$5" --messagingPort 0 --disableAdvertisements <"$6"
}

run_sidecar() {
  write_own_metadata "$1" || exit 1
  cd "$2" || exit 1
  exec "$3" "$4"
}

start() {
  mkdir -p "$compat_dir/nodel-data" "$compat_dir/sidecar-state" 2>/dev/null || fail supervisor "setup" "not_started"
  : >"$status_file" || fail supervisor "setup" "not_started"
  rm -f "$compat_dir/fifo-holder.pid" "$compat_dir/nodel.pid" "$compat_dir/sidecar.pid" "$fifo_path"
  mkfifo "$fifo_path" 2>/dev/null || fail fifo-holder "launch" "not_started"

  # Never pass inherited sidecar credentials into disposable subprocesses.
  unset NODEL_MCP_TOKEN MCP_TOKEN MCP_AUTH_TOKEN MCP_BEARER_TOKEN NODEL_AUTH_TOKEN NODEL_API_TOKEN NODEL_PASSWORD NODEL_API_KEY

  # Each service is a session/process-group leader, so group signals include descendants.
  setsid bash "$script_path" run-fifo-holder "$compat_dir/fifo-holder.pid" "$fifo_path" &
  record_process_group fifo-holder

  setsid bash "$script_path" run-nodel "$compat_dir/nodel.pid" "$compat_dir/nodel-data" "$java_bin" "$nodel_jar" "$nodel_port" "$fifo_path" \
    >"$compat_dir/nodel.log" 2>&1 &
  record_process_group nodel
  wait_for_ready nodel "http://127.0.0.1:$nodel_port/REST"

  NODEL_BASE_URL="http://127.0.0.1:$nodel_port" MCP_PORT="$sidecar_port" MCP_BIND_ADDRESS=127.0.0.1 \
    NODEL_STATE_DIR="$compat_dir/sidecar-state" NODEL_ENABLE_WRITES=true NODEL_ENABLE_NODE_LIFECYCLE=true \
    NODEL_ENABLE_DELETES=true NODEL_REQUIRE_WRITE_APPROVAL=false setsid bash "$script_path" run-sidecar \
    "$compat_dir/sidecar.pid" "$compat_dir" "$node_bin" "$sidecar_entry" \
    >"$compat_dir/sidecar.log" 2>&1 &
  record_process_group sidecar
  wait_for_ready sidecar "http://127.0.0.1:$sidecar_port/healthz"
  wait_for_ready sidecar "http://127.0.0.1:$sidecar_port/readyz"
  verified_process_group nodel || fail nodel "readiness" "exited"
}

on_exit() {
  local status=$? cleanup_status=0
  trap - EXIT TERM INT HUP
  cleanup || cleanup_status=$?
  if test "$status" -eq 0 && test "$cleanup_status" -ne 0; then exit "$cleanup_status"; fi
  exit "$status"
}

on_signal() {
  local signal_number=$1
  trap - EXIT TERM INT HUP
  cleanup || true
  exit "$((128 + signal_number))"
}

case "${1:-}" in
  run-fifo-holder)
    run_fifo_holder "$2" "$3"
    ;;
  run-nodel)
    run_nodel "$2" "$3" "$4" "$5" "$6" "$7"
    ;;
  run-sidecar)
    run_sidecar "$2" "$3" "$4" "$5"
    ;;
  start)
    trap on_exit EXIT
    trap 'on_signal 1' HUP
    trap 'on_signal 2' INT
    trap 'on_signal 15' TERM
    start
    trap - EXIT TERM INT HUP
    ;;
  cleanup)
    trap 'on_signal 1' HUP
    trap 'on_signal 2' INT
    trap 'on_signal 15' TERM
    cleanup
    ;;
  *)
    printf 'Usage: nodel-compatibility-supervisor.sh start|cleanup\n' >&2
    exit 2
    ;;
esac
