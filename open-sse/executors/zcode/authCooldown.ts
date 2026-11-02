/**
 * In-memory backoff for definitive expired-auth responses. No credentials are
 * stored: callers supply a one-way fingerprint. No background probes are made.
 */
export class ZcodeAuthCooldown {
  private failures = new Map<string, { until: number; probing: boolean; recovered: boolean }>();
  constructor(
    private now: () => number = Date.now,
    private cooldownMs = 300_000
  ) {}
  acquire(key: string): boolean {
    const state = this.failures.get(key);
    if (!state) return true;
    if (state.until > this.now() || state.probing) return false;
    state.probing = true;
    return true;
  }
  settle(key: string, status: number): void {
    if (status === 401) {
      if (this.failures.size >= 256 && !this.failures.has(key)) {
        this.failures.delete(this.failures.keys().next().value!);
      }
      const previous = this.failures.get(key);
      this.failures.set(key, {
        // At most one on-demand recovery for the same rejected credential.
        // Another definitive 401 waits for a changed credential, not forever-polling.
        until: previous?.probing || previous?.recovered ? Infinity : this.now() + this.cooldownMs,
        probing: false,
        recovered: Boolean(previous?.probing || previous?.recovered),
      });
    } else if (status >= 200 && status < 400) {
      this.failures.delete(key);
    } else {
      const state = this.failures.get(key);
      if (state?.probing) {
        state.probing = false;
        state.until = this.now() + Math.min(this.cooldownMs, 30_000);
      }
    }
  }
}
export const zcodeAuthCooldown = new ZcodeAuthCooldown();
