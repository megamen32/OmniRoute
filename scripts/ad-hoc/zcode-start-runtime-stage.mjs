import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
const runtime = process.argv[2];
const stage = process.argv[3];
const compiled = fs.readFileSync(process.argv[4], "utf8");
fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const files = [];
for (const name of ["14726.js", "77299.js", "41147.js", "37000.js"]) {
  const file = path.join(runtime, "dist/.build/next/server/chunks", name);
  const before = fs.readFileSync(file, "utf8");
  let after = before;
  if (name === "14726.js" || name === "77299.js") {
    const id = name === "14726.js" ? "11581" : "294762";
    const start = before.indexOf(id + ":(a,b,c)=>{");
    if (start < 0) throw Error("Missing module");
    const pattern = "d()}catch(a){d(a)}})}";
    const end = before.indexOf(pattern, start) + pattern.length;
    if (end < start) throw Error("Missing module end");
    let body = compiled.replace(/^import .*;\n/gm, "").replaceAll("export ", "");
    const module =
      id +
      ":(a,b,c)=>{c.a(a,async(a,d)=>{try{c.d(b,{k:()=>NativeSessionError,m:()=>NativeZcodeSessionBridge});var cryptoModule=c(977598),httpModule=c(937067),fsModule=c(51455),pathModule=c(176760),zModule=c(42971),dep=a([zModule]);zModule=(dep.then?(await dep)():dep)[0];const {createHash,randomUUID}=cryptoModule,{createServer}=httpModule,{mkdir,rm}=fsModule,{join}=pathModule,{z}=zModule;" +
      body +
      ";d()}catch(a){d(a)}})}";
    after = before.slice(0, start) + module + before.slice(end);
  } else {
    const replace = (x, y) => {
      if (after.split(x).length !== 2) throw Error("Pattern not unique " + name);
      after = after.replace(x, y);
    };
    replace(
      "prompt_tokens_details:{cached_tokens:Number(e.cacheReadTokens||0)}",
      "prompt_tokens_details:{cached_tokens:Number(e.cacheReadTokens||0),cache_creation_tokens:Number(e.cacheWriteTokens||0)}"
    );
    replace("transformedBody:{model:c.model,buffered:!0,plan:m.providerId}", "transformedBody:k");
  }
  const dest = path.join(stage, name);
  fs.writeFileSync(dest, after);
  execFileSync(process.execPath, ["--check", dest]);
  files.push({ path: file, staged: dest, before: sha(before), after: sha(after) });
}
{
  const file = path.join(runtime, "dist/.build/next/server/chunks/57562.js");
  const before = fs.readFileSync(file, "utf8");
  const needle = "(0,z.runWithProxyContext)(l?.proxy||null,()=>(0,q.wk)";
  if (before.split(needle).length !== 2) throw Error("proxy context pattern not unique");
  const replacement =
    '((/^zcode(?:-|$)/.test(d)&&["","app-server","native-host"].includes((process.env.ZCODE_TRANSPORT||"").trim().toLowerCase()))?((proxy,fn)=>(0,z.runWithDirectFetchContext)(fn)):z.runWithProxyContext)(l?.proxy||null,()=>(0,q.wk)';
  const after = before.replace(needle, replacement);
  const dest = path.join(stage, "57562.js");
  fs.writeFileSync(dest, after);
  execFileSync(process.execPath, ["--check", dest]);
  files.push({ path: file, staged: dest, before: sha(before), after: sha(after) });
}
fs.writeFileSync(
  path.join(stage, "manifest.json"),
  JSON.stringify({ purpose: "Start continuation recovery and exact usage", files }, null, 2)
);
console.log(JSON.stringify({ files: files.length, syntax: "PASS" }));
