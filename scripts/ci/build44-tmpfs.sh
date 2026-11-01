#!/usr/bin/env bash
set -Eeuo pipefail
IMAGE="docker.io/library/node:24-bookworm@sha256:8544b46b91d1a8c8bf8fc0d53ae9f276ed07d0ffa9098dc4a9c2f627363a13a0"
BASE="a1d8cf634868c5f504ad63efbdf49ace12f5a299"
HEAD="2c7577111d574b501f5e722923190cfc5f5381ef"
NAME="omniroute-pr7-tmpfs-build-20261101"
RESERVE=21474836480
ROOT_MARGIN=2684354560
RAM_LIMIT=42949672960
RAM_RESERVE=42949672960
ram="$(awk '/MemAvailable:/ {print $2*1024}' /proc/meminfo | cut -d. -f1)"
free="$(df -B1 --output=avail / | tail -1 | tr -d ' ')"
echo "PREFLIGHT disk_free=$free mem_available=$ram reserve=$RESERVE margin=$ROOT_MARGIN"
(( free >= RESERVE+ROOT_MARGIN && ram >= RAM_LIMIT+RAM_RESERVE )) || { echo "BLOCKED: reserves"; exit 78; }
[[ "$(docker info --format '{{.CgroupVersion}}')" == "2" ]] || { echo "BLOCKED cgroup v2"; exit 78; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "BLOCKED pinned image missing"; exit 78; }
if docker ps -a --format '{{.Names}}' | grep -Fxq "$NAME"; then echo "BLOCKED task container already exists"; exit 78; fi
OUT="$(mktemp -d /tmp/omniroute-pr7-build44.XXXXXXXX)"
chmod 700 "$OUT"
echo "TASK_OUTPUT=$OUT"
set +e
timeout --signal=TERM --kill-after=25s 1950s docker run \
 --name "$NAME" --label omniroute.pr7.build44=1 \
 --rm --pull=never --read-only --memory=40g --memory-swap=40g --cpus=4 --pids-limit=512 \
 --tmpfs /work:rw,exec,nosuid,size=12g,mode=1777 \
 --tmpfs /tmp:rw,exec,nosuid,size=1g,mode=1777 \
 --mount "type=bind,src=$OUT,dst=/out" \
 -e HOME=/work -e TMPDIR=/tmp -e npm_config_cache=/work/.npm \
 -e NODE_OPTIONS="--max-old-space-size=8192 --heap-prof" \
 -e OMNIROUTE_USE_TURBOPACK=0 -e ONNXRUNTIME_NODE_INSTALL=skip \
 -e BASE="$BASE" -e HEAD="$HEAD" "$IMAGE" bash -lc '
 set -Eeuo pipefail
 failures=0
 for label in base head; do
   if [[ "$label" == base ]]; then ref="$BASE"; else ref="$HEAD"; fi
   mkdir -p /work/src
   cd /work/src
   echo "PHASE checkout $label $ref"
   if ! (curl -fsSL --retry 2 --connect-timeout 15 --max-time 180 --max-filesize 350000000 \
       "https://github.com/megamen32/OmniRoute/archive/$ref.tar.gz" | tar xz --strip-components=1); then
     echo "CHECKOUT_FAIL $label" | tee -a /out/receipt.txt
     exit 81
   fi
   echo "PHASE npm-ci $label"
   set +e
   timeout --signal=TERM --kill-after=15s 300s npm ci --no-audit --no-fund 2>&1 | tail -c 16384 > "/out/$label-npm.log"
   install_rc=${PIPESTATUS[0]}
   set -e
   if (( install_rc != 0 )); then
     echo "INSTALL_FAIL $label exit=$install_rc" | tee -a /out/receipt.txt
     tail -c 3000 "/out/$label-npm.log"
     exit "$install_rc"
   fi
   # npm 11 can skip optional better-sqlite3 despite successful npm ci.
   # Use only the exact lockfile version and the documented native install flow.
   if ! node -e "require.resolve('better-sqlite3')" >/dev/null 2>&1; then
     echo "PHASE pinned native dependency $label"
     set +e
     timeout --signal=TERM --kill-after=10s 180s npm install better-sqlite3@13.0.3 --no-save --foreground-scripts --package-lock=false --no-audit --no-fund 2>&1 | tail -c 8192 > "/out/$label-native.log"
     native_rc=${PIPESTATUS[0]}
     set -e
     if (( native_rc != 0 )); then
       echo "NATIVE_FAIL $label exit=$native_rc" | tee -a /out/receipt.txt
       tail -c 1600 "/out/$label-native.log"
       exit "$native_rc"
     fi
   fi
   echo "PHASE build $label"
   set +e
   timeout --signal=TERM --kill-after=20s 720s npm run build:fast 2>&1 | tail -c 32768 > "/out/$label-build.log"
   build_rc=${PIPESTATUS[0]}
   set -e
   echo "BUILD_RESULT $label exit=$build_rc" | tee -a /out/receipt.txt
   tail -c 1800 "/out/$label-build.log"
   if (( build_rc == 0 )); then
     if [[ ! -f .build/next/BUILD_ID ]]; then
       echo "ARTIFACT_FAIL $label missing BUILD_ID" | tee -a /out/receipt.txt
       failures=1
     else
       echo "BUILD_ID $label $(cat .build/next/BUILD_ID)" | tee -a /out/receipt.txt
       sha256sum .build/next/BUILD_ID >> /out/receipt.txt
       paths=(.build)
       [[ -d dist ]] && paths+=(dist)
       set +e
       tar -czf - "${paths[@]}" | head -c 1073741824 > "/out/$label-artifact.tar.gz"
       archive_rc=${PIPESTATUS[0]}
       set -e
       if (( archive_rc != 0 )) || ! tar -tzf "/out/$label-artifact.tar.gz" >/dev/null 2>&1; then
         echo "ARTIFACT_FAIL $label size/integrity" | tee -a /out/receipt.txt
         failures=1
       else
         sha256sum "/out/$label-artifact.tar.gz" | tee -a /out/receipt.txt
       fi
     fi
   else
     failures=1
   fi
   cd /work
   rm -rf /work/src
 done
 exit "$failures"
 ' > "$OUT/task-output.log" 2>&1 &
pid=$!
breach=0
while kill -0 "$pid" 2>/dev/null; do
  disk="$(df -B1 --output=avail / | tail -1 | tr -d ' ')"
  mem="$(awk '/MemAvailable:/ {print $2*1024}' /proc/meminfo | cut -d. -f1)"
  printf '%s disk=%s mem=%s\n' "$(date -u +%FT%TZ)" "$disk" "$mem" >> "$OUT/resources.log"
  if (( disk < RESERVE+536870912 || mem < RAM_RESERVE )); then
    breach=1
    echo "GUARD: stopping only $NAME" >> "$OUT/resources.log"
    if docker inspect "$NAME" --format '{{index .Config.Labels "omniroute.pr7.build44"}}' 2>/dev/null | grep -Fxq 1; then
      docker stop --time=3 "$NAME" >/dev/null 2>&1 || true
    fi
    break
  fi
  sleep 10
done
wait "$pid"
rc=$?
set -e
echo "RESULT exit=$rc breach=$breach output=$OUT"
for f in "$OUT"/*.log; do
  [[ -f "$f" ]] && echo "LOG $(basename "$f") sha256=$(sha256sum "$f" | cut -d' ' -f1)"
done
for f in "$OUT"/*artifact.tar.gz; do
  [[ -f "$f" ]] && echo "ARTIFACT size=$(stat -c %s "$f") sha256=$(sha256sum "$f" | cut -d' ' -f1) path=$f"
done
tail -c 3000 "$OUT/task-output.log"
if (( breach != 0 )); then exit 78; fi
exit "$rc"
