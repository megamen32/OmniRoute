import fs from "node:fs";
import path from "node:path";
import { getSettings, getSettingsRevision, updateSettings } from "../../src/lib/db/settings.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

const desiredOrder = ["keenable-search", "tinyfish-search", "searxng-search"];
try {
  const revision = await getSettingsRevision();
  const settings = await getSettings();
  if (revision !== (await getSettingsRevision()))
    throw new Error("Settings changed during inspection");
  const before = {
    searchProviderOrder: settings.searchProviderOrder ?? null,
    searchTimeoutMs: settings.searchTimeoutMs ?? null,
    searchProviderTimeoutsMs: settings.searchProviderTimeoutsMs ?? null,
  };
  if (!process.argv.includes("--apply")) {
    console.log(JSON.stringify({ revision, before, desiredOrder }));
  } else {
    if (
      before.searchProviderOrder !== null &&
      JSON.stringify(before.searchProviderOrder) !== JSON.stringify(desiredOrder)
    ) {
      throw new Error("Another search order is configured; inspect it before replacing");
    }
    const backupPath = path.resolve(".tmp/standard-search-20261127/settings-before.json");
    fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(backupPath))
      fs.writeFileSync(backupPath, JSON.stringify({ revision, before }, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
    const providerTimeouts =
      settings.searchProviderTimeoutsMs && typeof settings.searchProviderTimeoutsMs === "object"
        ? (settings.searchProviderTimeoutsMs as Record<string, number>)
        : {};
    const desired = {
      searchProviderOrder: desiredOrder,
      searchTimeoutMs: 30000,
      searchProviderTimeoutsMs: {
        ...providerTimeouts,
        "keenable-search": 8000,
        "tinyfish-search": 8000,
        "searxng-search": 6000,
      },
    };
    await updateSettings(desired, { expectedRevision: revision });
    const verified = await getSettings();
    for (const [key, value] of Object.entries(desired)) {
      if (JSON.stringify(verified[key]) !== JSON.stringify(value))
        throw new Error("Setting verification failed: " + key);
    }
    console.log(
      JSON.stringify({ ok: true, revision: await getSettingsRevision(), ...desired, backupPath })
    );
  }
} finally {
  resetDbInstance();
}
