"use client";

import { Loader2, RefreshCw, SlidersHorizontal } from "lucide-react";

import { getCatalogThinkingCapability } from "@openmaic/lib/ai/model-metadata";
import {
  LLM_THINKING_SCENARIOS,
  type LlmThinkingScenarioConfigs,
  type LlmThinkingScenarioId,
  type ThinkingScenarioPreset,
} from "@openmaic/lib/ai/thinking-scenarios";
import type { ThinkingCapability } from "@openmaic/lib/types/provider";

const THINKING_PRESET_LABELS: Record<ThinkingScenarioPreset, string> = {
  baseline: "Baseline",
  none: "关闭思考",
  minimal: "极简",
  low: "较低",
  medium: "中等",
  high: "较高",
  xhigh: "很高",
  max: "最深",
};

function getBaselineDescription(capability?: ThinkingCapability): string {
  if (!capability) return "由服务商决定（未声明）";

  if (capability.control === "effort" && capability.defaultEffort) {
    return `${THINKING_PRESET_LABELS[capability.defaultEffort]} / ${capability.defaultEffort}`;
  }
  if (capability.control === "level" && capability.defaultLevel) {
    return `${THINKING_PRESET_LABELS[capability.defaultLevel]} / ${capability.defaultLevel}`;
  }
  if (capability.control === "none") {
    return capability.defaultEnabled === false ? "固定关闭" : "固定开启";
  }

  const mode = capability.defaultMode
    ?? (capability.defaultEnabled === false ? "disabled" : "enabled");
  const modeLabel = mode === "enabled"
    ? "开启"
    : mode === "disabled"
      ? "关闭"
      : mode === "auto"
        ? "自动"
        : "由服务商决定";
  const budget = capability.defaultBudgetTokens;
  if (typeof budget === "number") {
    return budget === -1 ? `${modeLabel}，动态预算` : `${modeLabel}，预算 ${budget} tokens`;
  }
  return modeLabel;
}

export function ThinkingScenarioPanel({
  providerId,
  modelId,
  configs,
  restoring,
  onChange,
  onRestore,
}: {
  providerId: string;
  modelId: string;
  configs: LlmThinkingScenarioConfigs;
  restoring: boolean;
  onChange: (scenario: LlmThinkingScenarioId, preset: ThinkingScenarioPreset) => void;
  onRestore: () => void;
}) {
  const capability = modelId ? getCatalogThinkingCapability(providerId, modelId) : undefined;
  const effortOptions: ThinkingScenarioPreset[] = capability?.control === "effort"
    ? ["baseline", ...(capability.effortValues ?? [])]
    : capability && capability.control !== "none"
      ? ["baseline", ...(capability.toggleable ? ["none" as const] : []), "high"]
      : ["baseline"];
  const options = [...new Set(effortOptions)];
  const configurable = options.length > 1;
  const baselineDescription = getBaselineDescription(capability);
  const overriddenCount = LLM_THINKING_SCENARIOS.filter(
    ({ id }) => configs[id] && configs[id] !== "baseline",
  ).length;

  return (
    <section className="overflow-hidden rounded-[10px] border border-stone-200 bg-stone-50/60">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200 bg-white px-4 py-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-stone-900">
            <SlidersHorizontal size={15} className="text-[var(--pbl-teacher)]" />
            应用场景思考深度
          </div>
          <p className="mt-1 text-xs leading-5 text-stone-500">
            当前模型的 Baseline：{baselineDescription}。只对单独覆盖的场景发送思考深度参数。
          </p>
        </div>
        <button
          type="button"
          onClick={onRestore}
          disabled={restoring || overriddenCount === 0}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-700 transition hover:border-[var(--pbl-teacher)] hover:text-[var(--pbl-teacher)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {restoring ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          一键恢复 baseline
        </button>
      </div>

      {!configurable ? (
        <div className="border-b border-stone-200 bg-amber-50 px-4 py-2.5 text-xs leading-5 text-amber-800">
          当前默认模型没有可用的思考深度控制元数据，将保持 baseline。
        </div>
      ) : null}

      <div className="divide-y divide-stone-200">
        {LLM_THINKING_SCENARIOS.map((scenario) => {
          const value = configs[scenario.id] ?? "baseline";
          return (
            <div
              key={scenario.id}
              className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_190px] sm:items-center"
            >
              <label htmlFor={`thinking-${scenario.id}`} className="min-w-0">
                <span className="block text-sm font-semibold text-stone-800">{scenario.label}</span>
                <span className="mt-0.5 block text-xs leading-5 text-stone-500">
                  {scenario.description}
                </span>
              </label>
              <select
                id={`thinking-${scenario.id}`}
                value={options.includes(value) ? value : "baseline"}
                disabled={!configurable}
                onChange={(event) => onChange(
                  scenario.id,
                  event.target.value as ThinkingScenarioPreset,
                )}
                className="h-9 w-full rounded-[6px] border border-stone-300 bg-white px-3 text-sm font-medium text-stone-800 transition focus:border-[var(--pbl-teacher)] focus:outline-none focus:ring-2 focus:ring-[var(--pbl-teacher)]/20 disabled:bg-stone-100 disabled:text-stone-400"
              >
                {options.map((option) => (
                  <option key={option} value={option}>
                    {option === "baseline"
                      ? `Baseline（当前默认：${baselineDescription}）`
                      : THINKING_PRESET_LABELS[option]}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </section>
  );
}
