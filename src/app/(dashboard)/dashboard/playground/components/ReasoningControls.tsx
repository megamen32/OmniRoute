"use client";

// src/app/(dashboard)/dashboard/playground/components/ReasoningControls.tsx
//
// #6241: effort selector + thinking toggle for the Playground. Rendered only when the selected
// model supports thinking (spec.show); the effort options come from the model's `effort_tiers`
// (fallback to the canonical vocabulary), resolved by `resolveReasoningControls`.

import type { PlaygroundParams } from "./ParamSliders";
import type { ReasoningControlSpec } from "./reasoningControlUtils";
import { useLocale, useTranslations } from "next-intl";
import Select from "@/shared/components/Select";
import Toggle from "@/shared/components/Toggle";
import { effortLabel } from "./reasoningControlUtils";

interface ReasoningControlsProps {
  spec: ReasoningControlSpec;
  params: PlaygroundParams;
  setParams: (params: PlaygroundParams) => void;
}

export default function ReasoningControls({ spec, params, setParams }: ReasoningControlsProps) {
  const t = useTranslations("playground");
  const locale = useLocale();
  if (!spec.show) return null;

  function update<K extends keyof PlaygroundParams>(key: K, value: PlaygroundParams[K]) {
    setParams({ ...params, [key]: value });
  }

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
        {t("reasoningLabel")}
      </span>

      {/* Thinking toggle */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-muted font-medium">{t("thinking")}</span>
        <Toggle
          size="sm"
          checked={params.thinking}
          ariaLabel={t("thinking")}
          onChange={() => update("thinking", !params.thinking)}
        />
      </div>

      {/* Effort selector (native kit select: the "" default option stays a real choice) */}
      <Select
        label={t("effort")}
        value={params.effort}
        onChange={(e) => update("effort", e.target.value)}
        selectClassName="text-xs"
      >
        <option value="">{t("effortDefault")}</option>
        {spec.effortOptions.map((opt) => (
          <option key={opt} value={opt}>
            {effortLabel(opt, locale)}
          </option>
        ))}
      </Select>
    </div>
  );
}
