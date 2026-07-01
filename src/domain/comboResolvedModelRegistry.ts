export type ComboResolvedModelRecord = {
  requestId: string;
  sessionId: string | null;
  comboName: string;
  requestedModel: string;
  resolvedModel: string;
  provider: string | null;
  providerId: string | null;
  connectionId: string | null;
  targetIndex: number | null;
  strategy: string | null;
  latencyMs: number | null;
  timestamp: string;
};

type RegistryStore = {
  byRequestId: Map<string, ComboResolvedModelRecord>;
  recent: ComboResolvedModelRecord[];
  lastCleanupAt: number;
};

const STORE_KEY = Symbol.for("omniroute.comboResolvedModelRegistry.v1");
const MAX_RECORDS = 1000;
const TTL_MS = 60 * 60 * 1000;

function getStore(): RegistryStore {
  const globalObj = globalThis as typeof globalThis & { [STORE_KEY]?: RegistryStore };
  if (!globalObj[STORE_KEY]) {
    globalObj[STORE_KEY] = {
      byRequestId: new Map<string, ComboResolvedModelRecord>(),
      recent: [],
      lastCleanupAt: 0,
    };
  }
  return globalObj[STORE_KEY];
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function cleanupStore(store = getStore(), now = Date.now()): void {
  if (now - store.lastCleanupAt < 60_000 && store.recent.length <= MAX_RECORDS) return;
  const cutoff = now - TTL_MS;
  store.recent = store.recent.filter((record) => {
    const ts = Date.parse(record.timestamp);
    const keep = Number.isFinite(ts) && ts >= cutoff;
    if (!keep) store.byRequestId.delete(record.requestId);
    return keep;
  });
  while (store.recent.length > MAX_RECORDS) {
    const removed = store.recent.shift();
    if (removed) store.byRequestId.delete(removed.requestId);
  }
  store.lastCleanupAt = now;
}

export function recordComboResolvedModel(input: {
  requestId?: string | null;
  sessionId?: string | null;
  comboName?: string | null;
  requestedModel?: string | null;
  resolvedModel?: string | null;
  provider?: string | null;
  providerId?: string | null;
  connectionId?: string | null;
  targetIndex?: number | null;
  strategy?: string | null;
  latencyMs?: number | null;
}): ComboResolvedModelRecord | null {
  const requestId = normalizeText(input.requestId);
  const comboName = normalizeText(input.comboName);
  const requestedModel = normalizeText(input.requestedModel) || comboName;
  const resolvedModel = normalizeText(input.resolvedModel);
  if (!requestId || !comboName || !requestedModel || !resolvedModel) return null;

  const record: ComboResolvedModelRecord = {
    requestId,
    sessionId: normalizeText(input.sessionId),
    comboName,
    requestedModel,
    resolvedModel,
    provider: normalizeText(input.provider),
    providerId: normalizeText(input.providerId),
    connectionId: normalizeText(input.connectionId),
    targetIndex: Number.isFinite(input.targetIndex) ? Number(input.targetIndex) : null,
    strategy: normalizeText(input.strategy),
    latencyMs: Number.isFinite(input.latencyMs)
      ? Math.max(0, Math.round(Number(input.latencyMs)))
      : null,
    timestamp: new Date().toISOString(),
  };

  const store = getStore();
  cleanupStore(store);
  const previous = store.byRequestId.get(requestId);
  if (previous) {
    const index = store.recent.findIndex((item) => item.requestId === requestId);
    if (index >= 0) store.recent.splice(index, 1);
  }
  store.byRequestId.set(requestId, record);
  store.recent.push(record);
  cleanupStore(store);
  return record;
}

export function getComboResolvedModel(params: {
  requestId?: string | null;
  sessionId?: string | null;
  comboName?: string | null;
  requestedModel?: string | null;
}): ComboResolvedModelRecord | null {
  const store = getStore();
  cleanupStore(store);

  const requestId = normalizeText(params.requestId);
  if (requestId) return store.byRequestId.get(requestId) ?? null;

  const sessionId = normalizeText(params.sessionId);
  const comboName = normalizeText(params.comboName);
  const requestedModel = normalizeText(params.requestedModel);

  for (let i = store.recent.length - 1; i >= 0; i -= 1) {
    const record = store.recent[i];
    if (sessionId && record.sessionId !== sessionId) continue;
    if (comboName && record.comboName !== comboName) continue;
    if (requestedModel && record.requestedModel !== requestedModel) continue;
    return record;
  }

  return null;
}

export function listComboResolvedModels(
  params: {
    sessionId?: string | null;
    comboName?: string | null;
    requestedModel?: string | null;
    limit?: number | null;
  } = {}
): ComboResolvedModelRecord[] {
  const store = getStore();
  cleanupStore(store);
  const sessionId = normalizeText(params.sessionId);
  const comboName = normalizeText(params.comboName);
  const requestedModel = normalizeText(params.requestedModel);
  const limit = Number.isFinite(params.limit)
    ? Math.max(1, Math.min(100, Math.floor(Number(params.limit))))
    : 20;
  const rows: ComboResolvedModelRecord[] = [];

  for (let i = store.recent.length - 1; i >= 0 && rows.length < limit; i -= 1) {
    const record = store.recent[i];
    if (sessionId && record.sessionId !== sessionId) continue;
    if (comboName && record.comboName !== comboName) continue;
    if (requestedModel && record.requestedModel !== requestedModel) continue;
    rows.push(record);
  }

  return rows;
}
