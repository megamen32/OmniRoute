#!/usr/bin/env node
// scripts/check/check-deps.mjs
// Gate anti-slopsquatting: toda dependência em QUALQUER package.json do repo deve
// estar numa allowlist commitada (dependency-allowlist.json). Uma dep nova exige
// adição EXPLÍCITA à allowlist — assim um agente não consegue introduzir um pacote
// alucinado/typosquatted silenciosamente (CSA 2026: 19,7% do código IA cita pacotes
// inexistentes; 43% dos nomes alucinados reaparecem, registráveis por atacantes).
// A revisão humana ao adicionar à allowlist é o ponto de controle.
//
// 6A.8: Expandido de 2 manifests hardcoded (package.json + electron/package.json)
// para descoberta automática de TODOS os package.json do repo, excluindo:
//   - node_modules/ (dep tree)
//   - .next/, .build/, dist/, dist-electron/ (build artefatos)
//   - .claude/ (worktrees de agentes)
//   - _references/, _mono_repo/ (código de referência não pertencente ao repo)
// Isso garante que workspaces novos (opencode-plugin, opencode-provider, open-sse, etc.)
// sejam automaticamente cobertos sem edição do script.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertNoStale } from "./lib/allowlist.mjs";

const ROOT = process.cwd();
const ALLOWLIST_PATH = path.join(ROOT, "dependency-allowlist.json");

// Directories to exclude when discovering package.json files.
// Using a set of path segment prefixes (relative to ROOT, forward slashes).
const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  ".next",
  ".build",
  "dist",
  "dist-electron",
  ".claude",
  "_references",
  "_mono_repo",
]);

/**
 * 6A.8: Discover all package.json files in the repo, excluding build artefacts,
 * reference code, and agent worktrees. Returns relative paths (forward slashes).
 */
export function discoverManifests(root) {
  const out = [];

  function walk(dir, depth) {
    if (depth > 5) return; // guard against very deep nesting
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (EXCLUDED_SEGMENTS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.name === "package.json") {
        out.push(path.relative(root, full).replace(/\\/g, "/"));
      }
    }
  }

  walk(root, 0);
  return out.sort();
}

/** Nomes de deps no manifesto que não estão na allowlist (de-dup, ordem preservada). */
export function findUnapprovedDeps(depNames, allowlist) {
  const seen = new Set();
  const out = [];
  for (const name of depNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!allowlist.has(name)) out.push(name);
  }
  return out;
}

function depNamesFromManifest(root, rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return [];
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch {
    return []; // skip malformed manifests (e.g. reference code)
  }
  return [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
  ];
}

function collectDepNames(root) {
  return discoverManifests(root).flatMap((rel) => depNamesFromManifest(root, rel));
}

function main() {
  if (!fs.existsSync(ALLOWLIST_PATH)) {
    console.error(
      `[check-deps] FAIL — ${path.basename(ALLOWLIST_PATH)} ausente. Gere com:\n` +
        `  node -e "require('./scripts/check/check-deps.mjs')" (ou veja o passo de bootstrap no PLANO)`
    );
    process.exit(1);
  }
  const allowlist = new Set(JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8")).allowed || []);
  const allDepNames = collectDepNames(ROOT);

  // 6A.8: stale-allowlist enforcement.
  // A dep in the allowlist that is no longer used in ANY manifest is stale — the dep
  // was removed, but the allowlist entry was not. Stale entries let the dep silently
  // re-appear without triggering the review gate (regression risk).
  // Note: only flag entries that appear in NO manifest; a dep may be in the allowlist
  // but only transitively installed, so we check against what manifests declare.
  const liveDepSet = new Set(allDepNames);
  assertNoStale(allowlist, liveDepSet, "check-deps");

  const unapproved = findUnapprovedDeps(allDepNames, allowlist);
  if (unapproved.length) {
    console.error(
      `[check-deps] ${unapproved.length} dependência(s) FORA da allowlist:\n` +
        unapproved.map((d) => "  ✗ " + d).join("\n") +
        `\n  → confirme que o pacote é legítimo (existe no registry, publisher conhecido, não é typosquat)\n` +
        `    e adicione o nome a dependency-allowlist.json ("allowed"). Esse é o ponto de revisão humana.`
    );
    process.exit(1);
  }
  if (process.exitCode === 1) return; // stale entries already logged
  const manifests = discoverManifests(ROOT);
  console.log(
    `[check-deps] OK — ${allowlist.size} dependências na allowlist, ` +
      `${manifests.length} manifests escaneados, nenhuma nova dep`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
