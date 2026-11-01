#!/usr/bin/env bash
set -euo pipefail
# Run on a dedicated Docker-capable runner, not a production host.
# Requires >=16 GiB free for a single container plus host overhead.
BASE="${BASE_REF:-a1d8cf634868c5f504ad63efbdf49ace12f5a299}"
HEAD="${HEAD_REF:-2c7577111d574b501f5e722923190cfc5f5381ef}"
ROOT="$(git rev-parse --show-toplevel)"
OUT="${OUTPUT_DIR:-$ROOT/.review-logs/base-vs-head}"
mkdir -p "$OUT"
command -v docker >/dev/null || { echo "BLOCKED: docker runner capability absent" >&2; exit 78; }
docker info >/dev/null 2>&1 || { echo "BLOCKED: Docker daemon unavailable" >&2; exit 78; }
# Fail closed before any clone/archive/install/build. Docker layers and worktree
# may share the same backing filesystem even when paths differ.
docker_root="$(docker info --format '{{.DockerRootDir}}')"
scratch="${BUILD_SCRATCH_DIR:-$(dirname "$OUT")}"
mkdir -p "$scratch"
root_dev="$(stat -c %d /)"
docker_dev="$(stat -c %d "$docker_root")"
scratch_dev="$(stat -c %d "$scratch")"
root_free_kb="$(df -Pk / | awk 'END {print $4}')"
scratch_free_kb="$(df -Pk "$scratch" | awk 'END {print $4}')"
# 20 GiB protected production root; 24 GiB dedicated build scratch.
if ((root_dev == docker_dev || root_dev == scratch_dev)); then
  if ((root_free_kb < 44*1024*1024)); then
    echo "BLOCKED: Docker/scratch shares root; require 44 GiB free (24 GiB build + 20 GiB production), observed $((root_free_kb/1024/1024)) GiB" >&2
    exit 78
  fi
elif ((scratch_free_kb < 24*1024*1024 || root_free_kb < 20*1024*1024)); then
  echo "BLOCKED: scratch needs 24 GiB and root reserve 20 GiB" >&2
  exit 78
fi
available_kb="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
if ((available_kb < 20*1024*1024)); then echo "BLOCKED: require 20 GiB host MemAvailable to reserve 16 GiB job safely" >&2; exit 78; fi
for label in base head; do
  if [[ "$label" == base ]]; then ref="$BASE"; else ref="$HEAD"; fi
  work="$(mktemp -d)"
  git -C "$ROOT" archive "$ref" | tar -x -C "$work"
  echo "$ref" > "$OUT/$label.ref"
  set +e
  docker run --rm --memory=16g --memory-swap=16g --cpus=2 \
    -e NODE_OPTIONS="--max-old-space-size=8192 --heap-prof" \
    -e OMNIROUTE_USE_TURBOPACK=0 \
    -e ONNXRUNTIME_NODE_INSTALL=skip \
    -v "$work:/work" -w /work node:24-bookworm \
    bash -lc 'npm ci --ignore-scripts --no-audit --no-fund && timeout --signal=TERM --kill-after=20s 720s npm run build:fast; rc=$?; if [ -f .build/next/BUILD_ID ]; then sha256sum .build/next/BUILD_ID; fi; exit $rc' \
    > "$OUT/$label.log" 2>&1
  rc=$?
  set -e
  echo "$rc" > "$OUT/$label.exit"
  find "$work/.build/next" -maxdepth 2 -type f \( -name BUILD_ID -o -name required-server-files.json \) -exec sha256sum {} \; > "$OUT/$label.artifacts.sha256" 2>/dev/null || true
  find "$work" -maxdepth 2 -name '*.heapprofile' -exec sha256sum {} \; > "$OUT/$label.heap.sha256" 2>/dev/null || true
  sha256sum "$OUT/$label.log" > "$OUT/$label.log.sha256"
  tail -c 800 "$OUT/$label.log"
  rm -rf "$work"
  if (( rc != 0 )); then echo "FAILED $label exit $rc; refusing to launch next build" >&2; exit "$rc"; fi
done
echo "PASS: both builds finished; compare outputs in $OUT"
