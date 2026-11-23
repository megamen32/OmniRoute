import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ZCode 3.17.2 Linux x64. The native model returns displayable reasoning parts
// in result.reasoning. The vendor's own $uo extracts their text and omits
// metadata-only parts, blank text and opaque reasoning signatures.
const worker = {
  sha256: "d9afd58d694f98a5279bf548cdc7646413c125762e86730605a6071f9e0346d6",
  edits: [
    [
      "{text:D.text,selection:{providerId:n.providerId,modelId:n.modelId",
      "{text:D.text,reasoning:$uo(D.reasoning),selection:{providerId:n.providerId,modelId:n.modelId",
    ],
    [
      "return{text:u.text,selection:u.selection,finishReason:u.finishReason",
      "return{text:u.text,...u.reasoning?{reasoning:u.reasoning}:{},selection:u.selection,finishReason:u.finishReason",
    ],
    [
      "Aps=m.object({text:m.string(),selection:Nl",
      "Aps=m.object({text:m.string(),reasoning:m.string().optional(),selection:Nl",
    ],
  ],
};

const host = {
  sha256: "0bab21780816e6db2a6a3da566b447688f93bfca96555a722fab36fb6179a0bf",
  edits: [
    [
      "var zcodeWorkspaceGenerateTextResultSchema = z77.object({\n  text: z77.string(),",
      "var zcodeWorkspaceGenerateTextResultSchema = z77.object({\n  text: z77.string(),\n  reasoning: z77.string().optional(),",
    ],
  ],
};

export function visibleReasoningOverlay(sourceRoot, records) {
  const files = new Map();
  for (const [name, spec] of [
    ["zcode.cjs", worker],
    ["server-core.js", host],
  ]) {
    const record = records.find((entry) => entry.path === name);
    if (record?.type !== "file" || record.sha256 !== spec.sha256)
      throw new Error(`Unsupported ZCode runtime for --visible-reasoning: ${name}`);
    let text = readFileSync(join(sourceRoot, name), "utf8");
    for (const [before, after] of spec.edits) {
      if (text.indexOf(before) < 0 || text.indexOf(before) !== text.lastIndexOf(before))
        throw new Error(`Expected one reasoning patch site in ${name}`);
      text = text.replace(before, () => after);
    }
    files.set(name, { text, sha256: createHash("sha256").update(text).digest("hex") });
  }
  return files;
}
