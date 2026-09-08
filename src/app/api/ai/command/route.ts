import type { NextRequest } from 'next/server';

import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { createSlateEditor, nanoid, NodeApi } from 'platejs';

import type { ChatMessage, ToolName } from '@/components/editor/use-chat';
import { BaseEditorKit } from '@/components/editor/editor-base-kit';
import {
  appendAiInteractionEvents,
} from '@/lib/ai-collaboration/audit-store';
import {
  evaluateAiWorkPolicy,
  type DocumentCollaborationIntent,
} from '@/lib/ai-collaboration/document-policy';
import { isAuthConfigured, readAuthFromRequest } from '@/lib/auth/session';
import { canAccessLegacyCourse } from '@/lib/platform/access';
import { callLLMStream } from '@/lib/llm/client';
import { getCourse } from '@/lib/session/server-store';

import { getEditPrompt, getGeneratePrompt } from './prompt';
import { getLastUserInstruction } from './utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type CommandBody = {
  courseId?: unknown;
  studentId?: unknown;
  stageKey?: unknown;
  currentTask?: unknown;
  projectGoal?: unknown;
  ctx?: {
    children?: unknown;
    selection?: unknown;
    toolName?: ToolName;
  };
  messages?: ChatMessage[];
};

const bounded = (value: unknown, max: number) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

export async function POST(request: NextRequest) {
  let body: CommandBody;
  try {
    body = (await request.json()) as CommandBody;
  } catch {
    return Response.json({ error: 'INVALID_JSON' }, { status: 400 });
  }

  const courseId = bounded(body.courseId, 120);
  const studentId = bounded(body.studentId, 120);
  const stageKey = bounded(body.stageKey, 80);
  if (!courseId || !studentId || !['proposal', 'make'].includes(stageKey)) {
    return Response.json({ error: 'INVALID_COLLABORATION_SCOPE' }, { status: 400 });
  }

  const claims = await readAuthFromRequest(request, 'student');
  if (isAuthConfigured() && !claims) {
    return Response.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }
  if (claims && (claims.courseId !== courseId || claims.studentId !== studentId)) {
    return Response.json({ error: 'STUDENT_SCOPE_MISMATCH' }, { status: 403 });
  }
  if (claims && !(await canAccessLegacyCourse(claims, courseId, 'write'))) {
    return Response.json({ error: 'COURSE_LOCKED' }, { status: 403 });
  }

  const course = await getCourse(courseId);
  const student = course?.students.find((item) => item.id === studentId);
  if (!course || !student) {
    return Response.json({ error: 'STUDENT_NOT_IN_COURSE' }, { status: 403 });
  }

  const ctx = body.ctx;
  if (!ctx?.children || !Array.isArray(ctx.children)) {
    return Response.json({ error: 'INVALID_EDITOR_CONTEXT' }, { status: 400 });
  }

  const editor = createSlateEditor({
    plugins: BaseEditorKit,
    selection: (ctx.selection ?? null) as never,
    value: ctx.children as never,
  });
  const messages = Array.isArray(body.messages) ? body.messages.slice(-8) : [];
  const isSelecting = editor.api.isExpanded();
  const toolName: ToolName = ctx.toolName ?? (isSelecting ? 'edit' : 'generate');
  const requestId = request.headers.get('x-request-id') ?? nanoid();
  const userInstruction = bounded(getLastUserInstruction(messages), 1_200);
  const artifactText = (editor.children as never[])
    .map((node) => NodeApi.string(node))
    .join('\n')
    .trim();
  const policyIntent: DocumentCollaborationIntent = toolName === 'edit' ? 'edit' : 'organize';
  const policy = evaluateAiWorkPolicy({
    intent: policyIntent,
    request: userInstruction || `${toolName === 'edit' ? '局部修改' : '局部辅助'}请求`,
    scope: isSelecting ? 'selection' : 'document',
    hasStudentArtifact: Boolean(artifactText),
    selectedText: isSelecting ? editor.api.string(editor.selection!) : '',
  });

  async function recordAudit(
    eventType: 'request' | 'response' | 'policy' | 'error',
    actorRole: 'student' | 'ai' | 'system',
    content: string,
    payload: Record<string, unknown> = {},
  ) {
    try {
      await appendAiInteractionEvents([{
        courseId,
        studentId,
        stageKey,
        source: 'selection',
        eventType,
        actorRole,
        actorId: actorRole === 'student' ? studentId : undefined,
        content: content.slice(0, 120_000),
        payload: { toolName, ...payload },
        requestId,
      }]);
    } catch (error) {
      console.error('[ai/command] audit event write failed', error);
    }
  }

  await recordAudit('request', 'student', userInstruction || `${toolName} 请求`, {
    selected: isSelecting,
    documentLength: artifactText.length,
  });
  await recordAudit('policy', 'system', policy.reason, policy as unknown as Record<string, unknown>);

  if (!isSelecting || policy.outcome !== 'local_suggestion') {
    const message = !isSelecting
      ? '划字后的 AI 调用只处理局部段落，请先选中文档中的文字；需要整理整篇辅助内容时请在侧边 AI 组员对话框中布置。'
      : policy.reason;
    await recordAudit('error', 'system', message, { code: 'AI_SELECTION_REQUIRED' });
    return Response.json({
      error: 'AI_SELECTION_REQUIRED',
      message,
      policy,
    }, { status: 422 });
  }

  if (toolName === 'comment') {
    await recordAudit('error', 'system', '当前编辑器不支持 AI 直接添加批注。', {
      code: 'AI_COMMENT_NOT_ENABLED',
    });
    return Response.json({ error: 'AI_COMMENT_NOT_ENABLED' }, { status: 422 });
  }

  const promptInstruction = toolName === 'edit'
    ? getEditPrompt(editor, { isSelecting, messages })[0]
    : getGeneratePrompt(editor, { isSelecting, messages });
  const system = [
    '你是项目式学习小组中的辅助型 AI 成员。',
    `项目：${bounded(body.projectGoal, 500) || course.name}`,
    `当前任务：${bounded(body.currentTask, 500) || course.stages[course.currentStageIndex]?.label || stageKey}`,
    '学生始终主导项目。不得代替学生定义核心问题、作出关键方案决策、形成核心结论或完成最终提交。',
    '可以检查、解释、整理和提出局部修改建议。修改必须保持为建议，等待学生在编辑器中接受或拒绝。',
    '严格遵循用户要求的输出格式；不要声称已经替学生完成或提交项目。',
  ].join('\n');

  const stream = createUIMessageStream<ChatMessage>({
    execute: async ({ writer }) => {
      const textId = nanoid();
      writer.write({ data: toolName, type: 'data-toolName' });
      writer.write({ id: textId, type: 'text-start' });
      try {
        let generated = '';
        for await (const delta of callLLMStream(
          [
            { role: 'system', content: system },
            { role: 'user', content: promptInstruction },
          ],
          { abortSignal: request.signal },
        )) {
          generated += delta;
          writer.write({ delta, id: textId, type: 'text-delta' });
        }
        await recordAudit('response', 'ai', generated, {
          resultLength: generated.length,
          mode: toolName === 'edit' ? 'local-replace' : 'local-context',
        });
      } catch (error) {
        await recordAudit('error', 'system', error instanceof Error ? error.message : 'AI 生成失败', {
          code: 'AI_GENERATION_FAILED',
        });
        throw error;
      } finally {
        writer.write({ id: textId, type: 'text-end' });
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
