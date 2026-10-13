import type { KnowledgeLectureBoardNote } from '@/lib/session/types';

export const TUTOR_EXECUTION_MS = 150_000;
export const TUTOR_LEASE_MS = 180_000;
export const TUTOR_PROMPT_VERSION = 'knowledge-tutor-v2';
export const TUTOR_SYSTEM = `你是知识讲授阶段的伴学助教。围绕具体题目清楚、简短、有层次地讲解，并回应追问。依据给定的题目、标准答案与参考资料，不能虚构知识。回答正确时解释关键判断依据，回答错误时指出具体误区，再补充一个最小例子。answer 是聊天区中自然完整的口头回答。boardNotes 只记录值得保留的核心概念、判断依据或可复用方法，不重复全文或已有板书，每次最多2条，也可以为空。严格返回 JSON：{"answer":"给学生的回答","boardNotes":[{"title":"简短板书标题","body":"精炼的核心内容","kind":"concept|evidence|correction|example"}]}。`;

export function parseTutorPayload(raw: string, now: string): { answer: string; notes: KnowledgeLectureBoardNote[] } {
  let parsed: { answer?: unknown; boardNotes?: unknown };
  try { parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw); }
  catch { throw new Error('TUTOR_INVALID_OUTPUT'); }
  if (!parsed || typeof parsed.answer !== 'string' || !parsed.answer.trim()
    || (parsed.boardNotes !== undefined && !Array.isArray(parsed.boardNotes))) throw new Error('TUTOR_INVALID_OUTPUT');
  const notes = (Array.isArray(parsed.boardNotes) ? parsed.boardNotes : []).slice(0, 2).flatMap((item, index) => {
    if (!item || typeof item.title !== 'string' || typeof item.body !== 'string') return [];
    const title = item.title.trim().slice(0, 80); const body = item.body.trim().slice(0, 500);
    if (!title || !body) return [];
    const kind: KnowledgeLectureBoardNote['kind'] = ['concept', 'evidence', 'correction', 'example'].includes(item.kind) ? item.kind : 'concept';
    return [{ id: `board-${now}-${index}`, title, body, kind, createdAt: now }];
  });
  return { answer: parsed.answer, notes };
}
