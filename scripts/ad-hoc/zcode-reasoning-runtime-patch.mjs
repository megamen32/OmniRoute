import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const runtime = process.argv[2];
const staging = process.argv[3];
if (!runtime || !staging) throw new Error("runtime and staging paths required");
const helper = ts.transpileModule(
  readFileSync("open-sse/executors/zcode/responseText.ts", "utf8").replace(
    "export function",
    "function"
  ),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
).outputText;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const records = [];
for (const name of ["41147.js", "37000.js", "14726.js", "77299.js"]) {
  const path = join(runtime, "dist/.build/next/server/chunks", name);
  const original = readFileSync(path, "utf8");
  let patched = original;
  function replaceOnce(before, after) {
    if (patched.split(before).length !== 2) throw new Error(`Pattern not unique: ${name}`);
    patched = patched.replace(before, after);
  }
  if (["41147.js", "37000.js"].includes(name)) {
    replaceOnce(
      "function D(a,b,c){",
      `${helper}\nfunction D(a,b,c){const nativeResponseText=normalizeZcodeResponseText(typeof b.text==="string"?b.text:"",typeof b.reasoning==="string"?b.reasoning:"");`
    );
    replaceOnce(
      'content:"string"==typeof b.text?b.text:"",',
      "content:nativeResponseText.content,...nativeResponseText.reasoning?{reasoning_content:nativeResponseText.reasoning}:{},"
    );
    replaceOnce(
      "content:k.content,...m?",
      "content:k.content,...k.reasoning_content?{reasoning_content:k.reasoning_content}:{},...m?"
    );
  } else {
    replaceOnce(
      'text:b,finishReason:"stop",usage:',
      'text:b,reasoning:l(d.parts).filter(a=>"reasoning"===a.type).map(a=>String(a.text??"")).join("\\n\\n"),finishReason:"stop",usage:'
    );
  }
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const dest = join(staging, name);
  if (existsSync(dest)) throw new Error("Staging path already exists");
  writeFileSync(dest, patched);
  execFileSync(process.execPath, ["--check", dest]);
  records.push({ path, before: sha(original), after: sha(patched), staged: dest });
}
writeFileSync(
  join(staging, "manifest.json"),
  JSON.stringify(
    {
      sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      builtSource: "99e4d0b4bc",
      purpose: "Native reasoning and compression-prefix normalization",
      files: records,
    },
    null,
    2
  )
);
console.log(JSON.stringify({ staged: records.length, syntax: "PASS" }));
