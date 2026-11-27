#!/usr/bin/env python3
"""One-shot, fenced rollout of the standard web-search repair on server-100."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import uuid

ROOT = Path("/home/roomhacker")
REPO = ROOT / "agents-projects/omniroute-zcode"
WORK = REPO / ".claude/worktrees/tinyfish-search-20261127"
SHA = "fc4452a1cf5805cdbe9ee40d8e700300d08aae16"
PREVIOUS = ROOT / "omniroute-releases/releases/server44-6658a6f483"
CANDIDATE = ROOT / ("omniroute-releases/releases/server44-" + SHA)
STATE = ROOT / ".local/state/omniroute-build44/deployments"
RECORD = STATE / (SHA + "-standard-search-rollout.json")
NODE = ROOT / ".nvm/versions/node/v22.22.3/bin/node"
ADMIN = REPO.parent / ".fleet-candidate/releases/192da6d31bf71e95b03606fcf4cbf7749b2ec292/dist/project-release-admin.js"
LEDGER = ROOT / ".local/state/agent-herder/project-release-leases.json"
VHOSTS = [
    Path("/etc/nginx/sites-enabled/omniroute.bezrabotnyi.com"),
    Path("/etc/nginx/sites-available/omniroute.bezrabotnyi.com"),
    ROOT / "ServersAdministartion/nginx-dev/state/files/sites-available/omniroute.bezrabotnyi.com",
]
OVERLAY_NAME = "zzzzzzzzzz-standard-search-20261127.conf"
OVERLAY_BYTES = ('[Service]\nEnvironment="OMNIROUTE_PKG=' + str(CANDIDATE) + '"\n').encode()
SESSION = str(uuid.uuid4())
PRIVATE = STATE / ("standard-search-worker-" + SESSION)
PRIVATE.mkdir(mode=0o700, parents=True, exist_ok=False)
os.umask(0o077)
stat_text = Path("/proc/self/stat").read_text()
OWNER = {
    "hostId": "roomhacker-server-100",
    "harness": "chatgpt-gptadmin",
    "nativeSessionId": SESSION,
    "process": {
        "pid": os.getpid(),
        "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        "startTicks": int(stat_text[stat_text.rfind(")") + 2:].split()[19]),
    },
}
proof = None
record = {}
locked_files = []

def command(*argv, timeout=30):
    result = subprocess.run([str(a) for a in argv], capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError("Command failed: " + str(argv[0]) + "; exit=" + str(result.returncode))
    return result.stdout

def write_json(path, data):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n")
    os.replace(temporary, path)

def save(status, **extra):
    record.update(status=status, updated_at_ms=int(time.time() * 1000), **extra)
    write_json(RECORD, record)
    print(json.dumps({"phase": status, **extra}), flush=True)

def lease(action):
    global proof
    request = {"action": action, "cwd": str(REPO), "owner": OWNER}
    if action == "acquire":
        request["ttlSeconds"] = 1800
    else:
        request.update(token=proof["token"], fence=proof["fence"])
    if action == "renew":
        request["ttlSeconds"] = 1800
    request_path = PRIVATE / (action + ".json")
    write_json(request_path, request)
    argv = [str(NODE), str(ADMIN), "--ledger", str(LEDGER),
            "--authority-host", "roomhacker-server-100", "--request", str(request_path)]
    if action == "acquire":
        argv += ["--proof-out", str(PRIVATE / "proof.json")]
    env = dict(os.environ, AGENT_HERDER_AUTOPILOT_STATE_DIR=str(ROOT / ".local/state/agent-herder/autopilot-live"))
    result = subprocess.run(argv, env=env, capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError("Release lease " + action + " denied or unavailable")
    value = json.loads(result.stdout)
    if action == "acquire":
        if value.get("acquired") is not True:
            raise RuntimeError("Release lease was not acquired")
        proof = json.loads((PRIVATE / "proof.json").read_text())
        current = value["lease"]
    elif action == "release":
        if value.get("released") is not True:
            raise RuntimeError("Release lease was not released")
        return value
    else:
        current = value
    if (value.get("authorityHost") != "roomhacker-server-100"
        or current.get("project") != proof["project"]
        or current.get("fence") != proof["fence"]
        or current.get("owner") != OWNER
        or current.get("expiresAt", 0) <= time.time() * 1000
        or current.get("disabled") or current.get("bypassed")):
        raise RuntimeError("Release lease identity or expiry mismatch")
    return current

def unit(port):
    return "omniroute@" + str(port) + ".service"

def overlay(port):
    return Path("/etc/systemd/system") / (unit(port) + ".d") / OVERLAY_NAME

def runtime(port):
    pid = int(command("systemctl", "show", unit(port), "-p", "MainPID", "--value"))
    package = None
    if pid:
        for entry in Path("/proc/" + str(pid) + "/environ").read_bytes().split(b"\0"):
            if entry.startswith(b"OMNIROUTE_PKG="):
                package = entry.split(b"=", 1)[1].decode()
    config_hash = hashlib.sha256(command("systemctl", "cat", unit(port))).hexdigest()
    return {"pid": pid, "package": package, "config_sha256": config_hash}

def ingress():
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in VHOSTS}

def ensure_ingress():
    if ingress() != record["ingress"]:
        raise RuntimeError("Ingress changed concurrently")
    text = VHOSTS[0].read_text()
    if "server 127.0.0.1:20130 max_fails=3 fail_timeout=10s;" not in text or \
       "server 127.0.0.1:20128 backup max_fails=3 fail_timeout=10s;" not in text:
        raise RuntimeError("Unexpected ingress topology")

def health(port):
    try:
        with urllib.request.urlopen("http://127.0.0.1:" + str(port) + "/api/monitoring/health", timeout=4) as response:
            return response.status == 200
    except Exception:
        return False

def wait_ready(port, package):
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        if health(port):
            actual = runtime(port)
            if actual["package"] == str(package):
                return actual
        time.sleep(2)
    raise RuntimeError("Readiness failed for " + str(port))

def consumer(name, base):
    log = PRIVATE / (name + ".log")
    env = dict(os.environ, OMNIROUTE_TEST_URL=base)
    with log.open("wb") as stream:
        result = subprocess.run([str(NODE), str(WORK / "scripts/ops/check-standard-web-search.mjs")],
                                env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=200)
    if result.returncode:
        raise RuntimeError("Consumer failed; log=" + str(log))
    value = json.loads(log.read_text().splitlines()[-1])
    if value.get("ok") is not True:
        raise RuntimeError("Consumer did not confirm success")
    return value

def install_overlay(port):
    lease("check")
    ensure_ingress()
    path = overlay(port)
    if path.exists():
        raise RuntimeError("Own overlay already exists; inspect before retrying")
    staged = PRIVATE / ("overlay-" + str(port) + ".conf")
    staged.write_bytes(OVERLAY_BYTES)
    command("sudo", "-n", "install", "-m", "0644", staged, path)
    command("sudo", "-n", "systemctl", "daemon-reload")

def remove_overlay(port):
    lease("check")
    path = overlay(port)
    if path.exists():
        if path.read_bytes() != OVERLAY_BYTES:
            raise RuntimeError("Own overlay changed concurrently; rollback stopped")
        command("sudo", "-n", "rm", "--", path)
        command("sudo", "-n", "systemctl", "daemon-reload")

def restart(port):
    lease("check")
    command("sudo", "-n", "systemctl", "restart", unit(port), timeout=120)

def rollback(port):
    remove_overlay(port)
    restart(port)
    return wait_ready(port, PREVIOUS)

def stage():
    global record
    if RECORD.exists():
        raise RuntimeError("Rollout receipt already exists; inspect before retrying")
    if any(overlay(port).exists() for port in (20128, 20130)):
        raise RuntimeError("Own overlay must be absent before first staging")
    installed = json.loads((STATE / (SHA + ".json")).read_text())
    if installed.get("status") != "installed" or installed.get("package_root") != str(CANDIDATE):
        raise RuntimeError("Verified install receipt is required")
    if not SHA.startswith((CANDIDATE / "BUILD_SHA").read_text().strip()):
        raise RuntimeError("Candidate build SHA mismatch")
    before = {str(p): runtime(p) for p in (20128, 20130)}
    if any(v["package"] != str(PREVIOUS) for v in before.values()):
        raise RuntimeError("Expected live release changed")
    if not all(health(p) for p in (20128, 20130)):
        raise RuntimeError("Existing instances must both be healthy")
    record = {"commit": SHA, "artifact_sha256": installed["sha256"], "previous_package": str(PREVIOUS),
              "candidate_package": str(CANDIDATE), "before": before, "ingress": ingress(),
              "stage_worker": SESSION, "stage_lease_fence": proof["fence"], "private_log_dir": str(PRIVATE)}
    save("staging")
    try:
        install_overlay(20128)
        restart(20128)
        green = wait_ready(20128, CANDIDATE)
        if runtime(20130) != before["20130"]:
            raise RuntimeError("Primary changed during standby staging")
        result = consumer("standby-consumer", "http://127.0.0.1:20128")
        ensure_ingress()
        save("staged", green=green, standby_consumer=result)
    except Exception as error:
        save("stage_failed", error=str(error))
        if overlay(20128).exists():
            restored = rollback(20128)
            save("stage_failed_rolled_back", restored=restored)
        raise

def promote(idle_path):
    global record
    record = json.loads(RECORD.read_text())
    if record.get("status") != "staged":
        raise RuntimeError("Standby acceptance is required")
    if runtime(20128) != record["green"] or runtime(20130) != record["before"]["20130"]:
        raise RuntimeError("Runtime changed since standby acceptance")
    ensure_ingress()
    if not health(20128) or not health(20130):
        raise RuntimeError("Both instances must be healthy before promotion")
    idle = json.loads(Path(idle_path).read_text())
    now_ms = time.time() * 1000
    if (idle.get("status") != 200 or idle.get("active") != 0 or idle.get("pending") != 0
        or not 0 <= now_ms - idle.get("at", 0) <= 15000
        or idle.get("primary_pid") != record["before"]["20130"]["pid"]):
        raise RuntimeError("Fresh authenticated idle evidence for the current primary is required")
    lease("check")
    save("promoting", primary_idle=idle, promotion_worker=SESSION, promotion_lease_fence=proof["fence"])
    stopped = False
    try:
        if not 0 <= time.time() * 1000 - idle["at"] <= 15000:
            raise RuntimeError("Idle evidence expired before stop")
        if runtime(20130) != record["before"]["20130"]:
            raise RuntimeError("Primary changed immediately before stop")
        stopped = True
        command("sudo", "-n", "systemctl", "stop", unit(20130), timeout=120)
        if runtime(20130)["pid"] != 0:
            raise RuntimeError("Old primary did not stop")
        if runtime(20128) != record["green"] or not health(20128):
            raise RuntimeError("Accepted standby lost readiness")
        via_backup = consumer("public-backup-consumer", "https://omniroute.bezrabotnyi.com")
        save("backup_serving", public_backup_consumer=via_backup)
        install_overlay(20130)
        lease("check")
        command("sudo", "-n", "systemctl", "start", unit(20130), timeout=120)
        primary = wait_ready(20130, CANDIDATE)
        direct_primary = consumer("primary-consumer", "http://127.0.0.1:20130")
        result = consumer("public-final-consumer", "https://omniroute.bezrabotnyi.com")
        ensure_ingress()
        save("live_verified", primary=primary, primary_consumer=direct_primary, public_consumer=result, green=runtime(20128))
    except Exception as error:
        save("promotion_failed", error=str(error))
        if stopped:
            restored_primary = rollback(20130)
            restored_green = rollback(20128)
            save("promotion_failed_rolled_back", restored_primary=restored_primary, restored_green=restored_green)
        raise

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["stage", "promote"])
    parser.add_argument("--idle-evidence")
    args = parser.parse_args()
    if args.action == "promote" and not args.idle_evidence:
        raise RuntimeError("Promotion requires fresh idle evidence")
    try:
        lease("acquire")
        for name in ["omniroute-release.lock", "omniroute-deploy.lock"]:
            handle = (ROOT / ".local/state" / name).open("a")
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked_files.append(handle)
        if args.action == "stage":
            stage()
        else:
            promote(args.idle_evidence)
    finally:
        if proof is not None:
            lease("release")
        for handle in reversed(locked_files):
            handle.close()

if __name__ == "__main__":
    main()
