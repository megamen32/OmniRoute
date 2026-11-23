import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const providerID = "omniroute-zcode";
const providerPackage = "@opencode/ai/providers/openai-compatible";

export default {
  id: "omniroute-zcode-discovery",
  async setup(ctx) {
    const options = ctx.options ?? {};
    const data = options.manifest ?? join(homedir(), ".omniroute/zcode-opencode-catalog.json");
    const keyPath = options.keyFile ?? join(homedir(), ".config/llm-keys/opencode-100.key");
    const settings = { baseURL: options.baseURL ?? "https://omniroute.bezrabotnyi.com/v1" };
    const info = {
      id: providerID,
      activation: "enabled",
      name: "ZCode Individual",
      package: providerPackage,
      settings,
    };

    let published;
    let models = [];
    async function readCatalog() {
      const snapshot = await readFile(data, "utf8").catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return "[]";
      });
      if (snapshot === published) return snapshot;
      const entries = JSON.parse(snapshot);
      models = entries.map(({ id, name, limit }) => ({
        id,
        modelID: id,
        name,
        providerID,
        package: providerPackage,
        settings,
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: [],
        time: { released: 0 },
        cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
        status: "active",
        enabled: true,
        limit: { context: 0, output: 0, ...limit },
      }));
      return snapshot;
    }

    let stopped = false;
    let refreshing = false;
    async function refresh(reload) {
      if (stopped || refreshing) return;
      refreshing = true;
      try {
        const snapshot = await readCatalog();
        if (stopped || snapshot === published) return;
        if (reload) await ctx.provider.reload();
        published = snapshot;
      } catch (error) {
        console.warn("[zcode-catalog] refresh failed:", error.code ?? error.name);
      } finally {
        refreshing = false;
      }
    }

    const base = new URL(settings.baseURL);
    const auth = await ctx.session.hook(
      "http.request",
      async ({ request, sessionID }) => {
        const target = new URL(request.url);
        if (
          target.origin === base.origin &&
          target.pathname === base.pathname + "/chat/completions"
        ) {
          const key = (await readFile(keyPath, "utf8")).trim();
          if (!key) throw new Error("ZCode gateway key is empty");
          request.headers.set("Authorization", "Bearer " + key);
          request.headers.set("x-opencode-session", sessionID);
        }
      },
      { providerID }
    );
    await refresh(false);
    const catalog = await ctx.provider.transform((editor) => {
      editor.add({ info, models });
    });

    const timer = setInterval(() => void refresh(true), options.intervalMs ?? 20_000);
    timer.unref?.();
    return async () => {
      stopped = true;
      clearInterval(timer);
      await catalog?.dispose();
      await auth?.dispose();
    };
  },
};
