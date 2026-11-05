import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
vi.unmock("next-intl");
import { NextIntlClientProvider } from "next-intl";
import en from "../../src/i18n/messages/en.json";
import CodexAccountDetails from "../../src/app/(dashboard)/dashboard/providers/[id]/components/CodexAccountDetails";
import ConnectionQuotaPanel from "../../src/app/(dashboard)/dashboard/providers/[id]/components/ConnectionQuotaPanel";
import { codexCutoffOverrides } from "../../src/app/(dashboard)/dashboard/providers/[id]/components/codexQuotaDisplay";

afterEach(cleanup);

it("labels each configured cutoff from its cached window, never from position", () => {
  expect(
    codexCutoffOverrides(
      { session: 15 },
      {
        session: { displayName: "Weekly", windowSeconds: 604800 },
      }
    )
  ).toEqual([{ window: "7d", value: 15 }]);
  expect(
    codexCutoffOverrides(
      { session: 0 },
      {
        session: { windowSeconds: 18000 },
      }
    )
  ).toEqual([{ window: "5h", value: 0 }]);
  expect(codexCutoffOverrides({ session: 15 })).toEqual([{ window: "session", value: 15 }]);
  expect(
    codexCutoffOverrides(
      { session: 15 },
      {
        session: { displayName: "Weekly" },
      }
    )
  ).toEqual([{ window: "Weekly", value: 15 }]);
  expect(
    codexCutoffOverrides(
      { session: 15 },
      {
        session: { displayName: "5h", windowSeconds: 604800 },
      }
    )
  ).toEqual([{ window: "7d", value: 15 }]);
  expect(codexCutoffOverrides(null)).toEqual([]);
  expect(codexCutoffOverrides({ weekly: NaN, session: 101 })).toEqual([]);
});

it("does not render the incorrect pool window and shows the cached weekly quota", () => {
  const pool = {
    parentConnectionId: "a",
    aggregate: { status: "available", limitedChildCount: 0 },
    children: [
      {
        key: { parentConnectionId: "a", scope: "codex" },
        unavailable: false,
        cooldown: { active: false, rateLimitedUntil: null },
        quota: {
          exhaustedWindow: null,
          observedAt: null,
          windows: {
            "5h": { usedPercentage: 53, usage: null, limit: null, resetAt: null },
            "7d": null,
          },
        },
      },
    ],
  } as any;
  render(
    <NextIntlClientProvider locale="en" messages={{ providers: en.providers }} timeZone="UTC">
      <CodexAccountDetails pool={pool} />
      <ConnectionQuotaPanel
        providerId="codex"
        connection={{ id: "a", provider: "codex" }}
        cache={{ quotas: { weekly: { remainingPercentage: 47, used: 53, total: 100 } } }}
      />
    </NextIntlClientProvider>
  );
  expect(screen.getByText("Codex cooldown / exhaustion")).toBeInTheDocument();
  expect(screen.queryByText(/5h:/)).not.toBeInTheDocument();
  expect(screen.getByText(/7d\s+53%/)).toBeInTheDocument();
});
