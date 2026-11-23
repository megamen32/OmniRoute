import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const providerID = "omniroute-zcode";
const providerPackage = "@opencode/ai/providers/openai-compatible";

export default {
  id: "omniroute-zcode-discovery",
  async setup(ctx) {
    const options = ctx.options ?? {};
    const keyPath = options.keyFile ?? join(homedir(), ".config/llm-keys/opencode-100.key");
    const baseURL = options.baseURL ?? "https://omniroute.bezrabotnyi.com/v1";
    const settings = { baseURL };
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
      const key = (await readFile(keyPath, "utf8")).trim();
      const response = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(options.fetchTimeoutMs ?? 15000),
      });
      if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
      const payload = await response.json();
      const entries = Array.isArray(payload?.data)
        ? payload.data.filter(
            (model) => typeof model?.id === "string" && model.id.startsWith("zcode-native/")
          )
        : [];
      const snapshot = JSON.stringify(entries);
      if (snapshot === published) return snapshot;
      models = entries.map(({ id, name, context_length: context, max_output_tokens: output }) => ({
        id,
        modelID: id,
        name: name || id,
        providerID,
        package: providerPackage,
        settings,
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: [],
        time: { released: 0 },
        cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
        status: "active",
        enabled: true,
        limit: { context: context || 0, output: output || 0 },
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
        published = snapshot;
        if (reload) await ctx.provider.reload();
      } catch (error) {
        console.warn("[zcode-catalog] OmniRoute catalog refresh failed:", error.code ?? error.name);
      } finally {
        refreshing = false;
      }
    }

    const base = new URL(baseURL);
    const auth = await ctx.session.hook(
      "http.request",
      async ({ request, sessionID }) => {
        const target = new URL(request.url);
        if (
          target.origin === base.origin &&
          target.pathname === base.pathname + "/chat/completions"
        ) {
          const key = (await readFile(keyPath, "utf8")).trim();
          if (!key) throw new Error("OmniRoute gateway key is empty");
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

    // OmniRoute performs upstream discovery on its standard six-hour scheduler.
    // This loop only rereads the already-built /v1/models catalog in OpenCode.
    const timer = setInterval(() => void refresh(true), options.intervalMs ?? 6 * 60 * 60 * 1000);
    timer.unref?.();
    return async () => {
      stopped = true;
      clearInterval(timer);
      await catalog?.dispose();
      await auth?.dispose();
    };
  },
};
