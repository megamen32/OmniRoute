#!/usr/bin/env bash
set -euo pipefail
# Dedicated task only: no image pull, no host-mounted writable project directory.
IMAGE='node:24-bookworm@sha256:8544b46b91d1a8c8bf8fc0d53ae9f276ed07d0ffa9098dc4a9c2f627363a13a0'
BASE='a1d8cf634868c5f504ad63efbdf49ace12f5a299'
HEAD='2c7577111d574b501f5e722923190cfc5f5381ef'
ROOT_RESERVE=$((20*1024*1024*1024))
RAM_RESERVE=$((40*1024*1024*1024))
ROOT_AVAIL="$(df -B1 --output=avail / | tail -1 | tr -d ' ')"
RAM_AVAIL="$(awk '/MemAvailable:/ {print $2*1024}' /proc/meminfo | cut -d. -f1)"
[[ "$ROOT_AVAIL" -gt "$ROOT_RESERVE" ]] || { echo "BLOCKED root reserve"; exit 78; }
[[ "$RAM_AVAIL" -gt $((RAM_RESERVE+40*1024*1024*1024)) ]] || { echo "BLOCKED RAM reserve"; exit 78; }
[[ "$(docker info --format '{{.CgroupVersion}}')" == '2' ]] || { echo "BLOCKED cgroups v2"; exit 78; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "BLOCKED: pinned official Node24 image not cached. No automatic pull onto production root."; exit 78; }
mkdir -p .review-logs
# One 40-GiB cgroup, no swap. 12-GiB /work tmpfs includes source, lockfile, npm cache,
# node_modules, Next output and logs, thus ENOSPC is bounded independent of host root.
# Read-only rootfs, no persistent bind mount, image must exist locally (--pull=never).
docker run --rm --pull=never --read-only --memory=40g --memory-swap=40g --cpus=4 --pids-limit=512 \
  --tmpfs /work:rw,exec,nosuid,size=12g,mode=1777 \
  --tmpfs /tmp:rw,nosuid,size=1g,mode=1777 \
  -e BASE="$BASE" -e HEAD="$HEAD" -e HOME=/work -e npm_config_cache=/work/.npm -e NODE_OPTIONS='--max-old-space-size=8192 --heap-prof' \
  -e OMNIROUTE_USE_TURBOPACK=0 -e ONNXRUNTIME_NODE_INSTALL=skip \
  "$IMAGE" bash -ec '
    cd /work
    for item in "base:$BASE" "head:$HEAD"; do
      label="${item%%:*}"; ref="${item#*:}"
      mkdir -p "/work/$label"
      curl -fsSL --retry 2 "https://github.com/megamen32/OmniRoute/archive/$ref.tar.gz" | tar xz --strip-components=1 -C "/work/$label"
      cd "/work/$label"
      npm ci --ignore-scripts --no-audit --no-fund > "/work/$label-npm.log" 2>&1
      set +e
      timeout --signal=TERM --kill-after=20s 720s npm run build:fast > "/work/$label-build.log" 2>&1
      code=$?
      set -e
      echo "RESULT $label exit=$code"
      test ! -f .build/next/BUILD_ID || sha256sum .build/next/BUILD_ID
      tail -c 1300 "/work/$label-build.log"
      cd /work
      rm -rf "/work/$label"
      test "$code" -eq 0 || exit "$code"
    done
  ' > .review-logs/tmpfs-build44-summary.log 2>&1
