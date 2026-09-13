import { RESOURCE_PACKAGE_STAGE_KEYS, type CourseStagePlan } from "@/lib/resource-package/types";

/** Shared by planning, publishing and generation; never treat the whole course as the lecture budget. */
export function knowledgeLectureBudgetBounds(courseHours: number, stagePlan?: CourseStagePlan) {
  if (stagePlan) {
    const stages = stagePlan.stages;
    const total = stages.reduce((sum, stage) => sum + (stage.durationMin ?? 0), 0);
    if (!Number.isInteger(stagePlan.totalMinutes) || stagePlan.totalMinutes <= 0
      || stages.length !== RESOURCE_PACKAGE_STAGE_KEYS.length
      || RESOURCE_PACKAGE_STAGE_KEYS.some((key) => stages.filter((stage) => stage.key === key).length !== 1)
      || stages.some((stage) => !Number.isInteger(stage.durationMin) || (stage.durationMin ?? 0) <= 0)
      || total !== stagePlan.totalMinutes) {
      throw new Error("资源包五阶段时长必须完整，且合计等于课程总分钟数。");
    }
    const minutes = stages.find((stage) => stage.key === "ai-learning")!.durationMin!;
    return { courseMinutes: stagePlan.totalMinutes, minMinutes: minutes, maxMinutes: minutes, source: "resource-package" as const };
  }
  if (!Number.isFinite(courseHours) || courseHours <= 0) {
    throw new Error("请先填写有效的课程总课时，再规划知识讲授时长。");
  }
  const courseMinutes = Math.round(courseHours * 60);
  const minMinutes = Math.ceil(courseMinutes * 0.2);
  const maxMinutes = Math.floor(courseMinutes * 0.4);
  if (minMinutes < 1 || maxMinutes < minMinutes) {
    throw new Error("课程总时长过短，无法在 20%–40% 范围内规划知识讲授。");
  }
  return { courseMinutes, minMinutes, maxMinutes, source: "recommended" as const };
}

export function isKnowledgeLectureBudgetInRange(minutes: number, courseHours: number, stagePlan?: CourseStagePlan): boolean {
  if (!Number.isInteger(minutes)) return false;
  try {
    const { minMinutes, maxMinutes } = knowledgeLectureBudgetBounds(courseHours, stagePlan);
    return minutes > 0 && minutes >= minMinutes && minutes <= maxMinutes;
  } catch {
    return false;
  }
}

/** Largest-remainder allocation with a per-item floor, without increasing total. */
export function allocateLectureBudget(total: number, weights: readonly number[], minimum = 1): number[] {
  if (!weights.length) return [];
  if (!Number.isInteger(total) || total < weights.length * minimum) {
    throw new Error("知识讲授页面过多，无法放入已确定的时间预算；请合并讲解页面或缩减拓展内容后重新生成。");
  }
  const safe = weights.map((weight) => Number.isFinite(weight) && weight > 0 ? weight : 1);
  const sum = safe.reduce((acc, value) => acc + value, 0);
  const exact = safe.map((weight) => total * weight / sum);
  const values = exact.map((value) => Math.max(minimum, Math.floor(value)));
  let remainder = total - values.reduce((acc, value) => acc + value, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; remainder > 0; index++, remainder--) values[order[index % order.length]!.index]++;
  while (remainder < 0) {
    const index = values.reduce((best, value, i) => value > values[best]! ? i : best, 0);
    values[index]--;
    remainder++;
  }
  return values;
}
