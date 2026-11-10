import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const host = "roomhacker@192.168.2.5";
const remoteRoot = "/home/roomhacker/omniroute-timeout-patch-20261110";
const local =
  "/home/roomhacker/agents-projects/omniroute-zcode/.build/zcode-timeout-patch-20261110";
const name = "input-individual-70ffac46331b38fb";
async function remoteStageIndividual() {
  const assert = (await import("node:assert/strict")).default;
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { hostname } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const { patchExecutorBranch, sha256 } =
    await import("/home/roomhacker/omniroute-timeout-patch-20261110/runner.mjs");
  assert.equal(hostname(), "server-44");
  const root = "/home/roomhacker/omniroute-timeout-patch-20261110";
  const source = path.join(root, "input-v2-70ffac46331b38fb/output");
  const destination = path.join(root, "input-individual-70ffac46331b38fb/output");
  assert(!fs.existsSync(destination), "Inspect prior variant outcome before replay");
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  execFileSync("cp", ["-a", source, destination]);
  const manifest = JSON.parse(fs.readFileSync(path.join(destination, "patch.json")));
  manifest.standbyReferenceFiles = structuredClone(manifest.files);
  manifest.providerScope = "individual";
  const { parse } = createRequire("/home/roomhacker/omniroute-build-142a2f04d8/package.json")(
    "acorn"
  );
  for (const entry of manifest.overlay.executorMap) {
    entry.individualOnly = true;
    const original = fs.readFileSync(path.join(destination, "rollback", entry.path), "utf8");
    const result = patchExecutorBranch(
      original,
      parse,
      entry,
      path.basename(manifest.overlay.sidecarPath)
    );
    fs.writeFileSync(path.join(destination, entry.path), result.after, { mode: 0o600 });
    execFileSync(process.execPath, ["--check", path.join(destination, entry.path)]);
    manifest.files.find((file) => file.path === entry.path).after = sha256(result.after);
  }
  manifest.checks.startBranchPreserved = true;
  manifest.checks.individualProfileIsolated = true;
  manifest.partialSourceApplication = {
    providers: ["zcode-individual", "zcode-cn-individual"],
    startSource: manifest.overlay.expectedSourceSha,
    connectionSuffix: ":plain-individual",
  };
  fs.writeFileSync(path.join(destination, "patch.json"), JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      phase: "individual-variant-staged",
      destination,
      providerScope: manifest.providerScope,
      sourceSha: manifest.sourceSha,
    })
  );
}
execFileSync("scp", [
  "-q",
  "scripts/ad-hoc/patch-zcode-timeout-artifact-20261110.mjs",
  host + ":" + remoteRoot + "/runner.mjs",
]);
execFileSync("ssh", ["-o", "BatchMode=yes", host, "node --input-type=module"], {
  input: "await (" + remoteStageIndividual.toString() + ")();",
  stdio: ["pipe", "inherit", "inherit"],
});
execFileSync("scp", ["-qr", host + ":" + remoteRoot + "/" + name, local + "/"]);
const manifest = JSON.parse(readFileSync(local + "/" + name + "/output/patch.json"));
assert.equal(manifest.providerScope, "individual");
console.log(
  JSON.stringify({
    artifact: local + "/" + name + "/output",
    sourceSha: manifest.sourceSha,
    providerScope: manifest.providerScope,
  })
);
