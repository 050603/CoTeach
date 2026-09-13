'use client';

import { useState } from 'react';
import { Button, toast } from '@/components/ui';
import { useSession } from '@/lib/session/store';
import type { Course, ProjectGroup, RubricScore } from '@/lib/session/types';
import { confirmedCourseRubric, weightedDimensionScore } from '@/lib/evaluation/course-rubric';
import { generateLiveEvaluation, type LiveEvaluationResult } from '@/lib/teaching-ai/client-api';

export function CourseRubricAssessment({ course, studentId }: { course: Course; studentId: string }) {
  const rubric = confirmedCourseRubric(course);
  const group = course.groups?.find((item) => item.members.some((member) => member.studentId === studentId));
  if (!rubric) return null;
  if (!group) return <p className="rounded-lg border border-stone-200 bg-white p-4 text-sm text-stone-600">该学生尚未建立个人项目空间，进入项目实践后可按课程量规评分。</p>;
  const scores = (course.rubricScores ?? []).filter((score) => score.groupId === group.id && score.stageKey === 'showcase');
  const current = [...scores].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).find((score) => score.rubricSnapshot?.id === rubric.id && score.rubricSnapshot.version === rubric.version);
  return <RubricAssessmentForm key={`${course.id}:${studentId}:${rubric.id}:${rubric.version}:${current?.id ?? 'new'}`}
    course={course} group={group} rubric={rubric} initial={current} history={scores.filter((score) => score.id !== current?.id)} />;
}

function RubricAssessmentForm({ course, group, rubric, initial, history }: {
  course: Course; group: ProjectGroup; rubric: NonNullable<ReturnType<typeof confirmedCourseRubric>>; initial?: RubricScore; history: RubricScore[];
}) {
  const session = useSession();
  const [scores, setScores] = useState<Record<string, number>>(initial?.dimensionScores ?? {});
  const [comment, setComment] = useState(initial?.comment ?? '');
  const [ai, setAi] = useState<LiveEvaluationResult | null>(null);
  const [aiScores, setAiScores] = useState<Record<string, number>>(initial?.aiDimensionScores ?? {});
  const [aiConfirmed, setAiConfirmed] = useState(Boolean(initial?.aiDimensionScores));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const teacherTotal = weightedDimensionScore(rubric.dimensions, scores);
  const aiTotal = aiConfirmed ? weightedDimensionScore(rubric.dimensions, aiScores) : undefined;
  const complete = (rubric.sourceWeights.teacher === 0 || teacherTotal !== undefined) && (rubric.sourceWeights.ai === 0 || aiTotal !== undefined);
  const total = complete ? Math.round((teacherTotal ?? 0) * rubric.sourceWeights.teacher + (aiTotal ?? 0) * rubric.sourceWeights.ai) / 100 : undefined;

  async function requestAi() {
    setLoading(true); setError('');
    try {
      const result = await generateLiveEvaluation({ course, group, teacherNotes: comment });
      const values = Object.fromEntries(result.dimensions.filter((dimension) => rubric.dimensions.some((entry) => entry.id === dimension.dimensionId)
        && Number.isFinite(dimension.suggestedScore) && dimension.suggestedScore >= 0 && dimension.suggestedScore <= 100).map((dimension) => [dimension.dimensionId, dimension.suggestedScore]));
      setAi(result); setAiScores(values); setAiConfirmed(false);
      if (weightedDimensionScore(rubric.dimensions, values) === undefined) setError('AI 建议未覆盖全部评价维度，请补充证据后重试，或核对并补齐各维建议分。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'AI 评分建议暂时不可用。'); }
    finally { setLoading(false); }
  }

  function save(status: 'draft' | 'submitted') {
    try {
      if (status === 'submitted' && !complete) throw new Error('请完成各维度评分，并核对需要计入总分的 AI 建议。');
      session.upsertRubricScore({ ...(initial?.id ? { id: initial.id } : {}), courseId: course.id, groupId: group.id, stageKey: 'showcase',
        dimensionScores: scores, ...(aiConfirmed ? { aiDimensionScores: aiScores } : {}), rubricSnapshot: rubric,
        teacherTotal, aiTotal: aiTotal ?? null, finalTotal: total, scoringMode: 'hybrid', total: total ?? teacherTotal ?? 0,
        status, comment, aiProcessSummary: ai?.overallComment ?? initial?.aiProcessSummary });
      toast.success(status === 'draft' ? '评分草稿已保存' : '已提交课程量规评分');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '评分保存失败。'); }
  }

  return <section className="rounded-xl border border-stone-200 bg-white p-5" aria-label="课程量规评分">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-bold">按课程量规评价个人成果</h3>
      <p className="mt-1 text-sm text-stone-600">量规版本 {rubric.version} · 教师 {rubric.sourceWeights.teacher}% · AI {rubric.sourceWeights.ai}%</p></div>
      {rubric.sourceWeights.ai > 0 && <Button loading={loading} onClick={() => void requestAi()}>生成 AI 评分建议</Button>}
    </div>
    <div className="mt-4 space-y-3">
      {rubric.dimensions.map((dimension) => <fieldset key={dimension.id} className="rounded-lg border border-stone-200 p-3">
        <legend className="px-1 text-sm font-semibold">{dimension.name} · {dimension.weight}%</legend>
        <p className="text-sm leading-6 text-stone-600">{dimension.description}</p>
        <div className="mt-2 flex flex-wrap gap-4">
          {rubric.sourceWeights.teacher > 0 && <label className="flex items-center gap-2 text-sm">教师评分
            <input aria-label={`${dimension.name}教师评分`} type="number" min={0} max={100} step={1} value={scores[dimension.id] ?? ''}
              className="w-24 rounded-md border border-stone-300 p-2" onChange={(event) => setScores((current) => { const next = { ...current }; if (event.target.value === '') delete next[dimension.id]; else next[dimension.id] = Number(event.target.value); return next; })} /><span>/ 100</span>
          </label>}
          {rubric.sourceWeights.ai > 0 && <label className="flex items-center gap-2 text-sm">AI 建议分
            <input aria-label={`${dimension.name}AI建议评分`} type="number" min={0} max={100} step={1} value={aiScores[dimension.id] ?? ''}
              className="w-24 rounded-md border border-stone-300 p-2" onChange={(event) => { setAiConfirmed(false); setAiScores((current) => { const next = { ...current }; if (event.target.value === '') delete next[dimension.id]; else next[dimension.id] = Number(event.target.value); return next; }); }} /><span>/ 100</span>
          </label>}
        </div>
        {ai?.dimensions.find((item) => item.dimensionId === dimension.id)?.rationale && <p className="mt-2 text-sm leading-6 text-stone-600">建议依据：{ai.dimensions.find((item) => item.dimensionId === dimension.id)?.rationale}</p>}
      </fieldset>)}
    </div>
    {rubric.sourceWeights.ai > 0 && <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={aiConfirmed}
      disabled={weightedDimensionScore(rubric.dimensions, aiScores) === undefined} onChange={(event) => setAiConfirmed(event.target.checked)} className="mt-1" />
      <span>已逐项核对 AI 建议及证据，确认这些分数可以计入总评</span></label>}
    <label className="mt-4 block text-sm font-medium">教师点评<textarea className="mt-2 min-h-24 w-full rounded-lg border border-stone-300 p-3 font-normal" value={comment} onChange={(event) => setComment(event.target.value)} /></label>
    {error && <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p>}
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p className="text-sm">总评：<strong>{total === undefined ? '待完成评分' : `${total.toFixed(2)} / 100`}</strong></p>
      <div className="flex gap-2"><Button onClick={() => save('draft')}>保存草稿</Button><Button disabled={!complete} onClick={() => save('submitted')}>确认并提交评分</Button></div>
    </div>
    {history.length > 0 && <details className="mt-4 border-t border-stone-200 pt-3 text-sm"><summary className="cursor-pointer font-semibold">历史评分（保留原量规及分数）</summary>
      <ul className="mt-2 space-y-2">{history.map((score) => <li key={score.id}>量规 {score.rubricSnapshot?.version ?? '旧版'} · {score.status === 'draft' ? '草稿' : '已提交'} · {score.finalTotal ?? score.total} 分 · {score.comment}</li>)}</ul>
    </details>}
  </section>;
}
