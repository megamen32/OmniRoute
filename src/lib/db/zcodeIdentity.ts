import { randomUUID } from "node:crypto";
import { getDbInstance } from "./core";

/** One durable identity for this OmniRoute installation, shared across accounts. */
export function getZcodeInstallationDeviceId(): string {
  const db = getDbInstance();
  db.prepare("INSERT OR IGNORE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    "zcodeRuntime",
    "deviceId",
    randomUUID()
  );
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get("zcodeRuntime", "deviceId") as { value: string } | undefined;
  if (!row?.value) throw new Error("ZCode installation identity is unavailable");
  return row.value;
}
