const prefix = "COTEACH_DESIGN_V1:";

export const designLabels = ["依据", "活动", "评价"] as const;
export type DesignLabel = (typeof designLabels)[number];

export function designPromptParts(prompt: string) {
  const lines = prompt.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  const positions = designLabels.map((label) => lines.findIndex((line) => line.startsWith(`${label}：`)));
  if (positions.some((position) => position < 0) || positions[0] >= positions[1] || positions[1] >= positions[2]) return null;
  return {
    context: lines.slice(0, positions[0]),
    sections: designLabels.map((label, index) => ({ label, guidance: lines[positions[index]].slice(label.length + 1).trim() })),
  };
}

export function parseDesignAnswer(answer: string | undefined): { values: Record<DesignLabel, string>; legacy: boolean } {
  const empty = { 依据: "", 活动: "", 评价: "" };
  if (!answer) return { values: empty, legacy: false };
  if (answer.startsWith(prefix)) {
    try {
      const parsed: unknown = JSON.parse(answer.slice(prefix.length));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && designLabels.every((label) => typeof (parsed as Record<string, unknown>)[label] === "string")) {
        return { values: parsed as Record<DesignLabel, string>, legacy: false };
      }
    } catch { /* Older freeform answers remain readable. */ }
  }
  return { values: { ...empty, 依据: answer }, legacy: true };
}

export function serializeDesignAnswer(values: Record<DesignLabel, string>) {
  return `${prefix}${JSON.stringify(values)}`;
}

export function completeDesignAnswer(answer: string | undefined) {
  if (!answer) return false;
  const parsed = parseDesignAnswer(answer);
  return !parsed.legacy && designLabels.every((label) => parsed.values[label].trim().length > 0);
}

export function readableDesignAnswer(answer: string) {
  const parsed = parseDesignAnswer(answer);
  return parsed.legacy ? answer : designLabels.map((label) => `${label}：${parsed.values[label]}`).join("\n\n");
}
