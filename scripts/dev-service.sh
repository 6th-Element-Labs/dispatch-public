#!/usr/bin/env bash
set -u

if [[ $# -ne 2 ]]; then
  echo "usage: dev-service.sh <repository-root> <service-name>" >&2
  exit 64
fi

repo_root="$1"
service_name="$2"
child_pid=""
case "${service_name}" in
  web) service_port=8410 ;;
  mail) service_port=8411 ;;
  agent) service_port=8412 ;;
  *) echo "unknown Dispatch service: ${service_name}" >&2; exit 64 ;;
esac

stop() {
  if [[ -n "${child_pid}" ]]; then
    kill -TERM "${child_pid}" 2>/dev/null || true
    wait "${child_pid}" 2>/dev/null || true
  fi
  exit 0
}

trap stop INT TERM

while true; do
  npm --prefix "${repo_root}/services/${service_name}" run dev &
  child_pid="$!"
  failures=0
  while kill -0 "${child_pid}" 2>/dev/null; do
    sleep 1
    if curl -fsS --max-time 1 "http://127.0.0.1:${service_port}/health" >/dev/null 2>&1; then
      failures=0
    else
      failures=$((failures + 1))
      if [[ ${failures} -ge 5 ]]; then
        echo "dispatch-dev: ${service_name} health failed 5 times; terminating the stuck process" >&2
        pkill -TERM -P "${child_pid}" 2>/dev/null || true
        kill -TERM "${child_pid}" 2>/dev/null || true
        break
      fi
    fi
  done
  if wait "${child_pid}"; then
    status=0
  else
    status="$?"
  fi
  child_pid=""
  echo "dispatch-dev: ${service_name} exited with ${status}; restarting in 1 second" >&2
  sleep 1
done
