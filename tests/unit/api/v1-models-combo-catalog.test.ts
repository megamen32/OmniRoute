import { test } from "node:test";
import assert from "node:assert/strict";

import { createCombo, getCombos } from "@/lib/localDb";
import { getUnifiedModelsResponse } from "@/app/api/v1/models/catalog";

type ModelCatalogEntry = { id?: unknown; owned_by?: unknown };

test("/v1/models advertises active DB combos without hard-coded combo names", async () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const visibleComboName = `catalog-visible-${suffix}`;
  const hiddenComboName = `catalog-hidden-${suffix}`;

  await createCombo({
    name: visibleComboName,
    models: [],
    strategy: "round-robin",
    isActive: true,
    isHidden: false,
  });
  await createCombo({
    name: hiddenComboName,
    models: [],
    strategy: "round-robin",
    isActive: true,
    isHidden: true,
  });

  const expectedComboIds = (await getCombos())
    .filter((combo) => combo.isActive !== false)
    .filter((combo) => combo.isHidden !== true)
    .map((combo) => (typeof combo.name === "string" ? combo.name.trim() : ""))
    .filter((name): name is string => name.length > 0);

  assert.ok(
    expectedComboIds.includes(visibleComboName),
    "test fixture combo must be discovered from the DB, not from a hard-coded list"
  );

  const response = await getUnifiedModelsResponse(new Request("http://localhost/v1/models"));
  assert.equal(response.status, 200);

  const payload = (await response.json()) as { data?: ModelCatalogEntry[] };
  const catalogIds = new Set(
    (payload.data ?? [])
      .map((model) => (typeof model.id === "string" ? model.id : ""))
      .filter(Boolean)
  );

  const missingComboIds = expectedComboIds.filter((comboId) => !catalogIds.has(comboId));
  assert.deepEqual(missingComboIds, [], "every active non-hidden DB combo must be listed");
  assert.equal(catalogIds.has(hiddenComboName), false, "hidden combos must stay hidden");
});
