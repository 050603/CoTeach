'use client';

import { Presentation } from 'lucide-react';
import { makeAssistantToolUI } from '@assistant-ui/react';
import { useI18n } from '@openmaic/lib/hooks/use-i18n';
import { ToolCard, isStoppedResult, type ToolStatus } from './tool-card';
import { RestoreButton } from './restore-button';

interface WhiteboardResult {
  content?: { type: string; text?: string }[];
  details?: { sceneId?: string; error?: string; whiteboardPatch?: { boardId?: string; steps?: { type?: string }[] } | null };
}

function WhiteboardToolCard({ running, stopped, failed, result, sceneId, toolCallId }: {
  running: boolean; stopped: boolean; failed: boolean; result?: WhiteboardResult;
  sceneId?: string; toolCallId: string;
}) {
  const { t } = useI18n();
  const status: ToolStatus = running ? 'running' : stopped ? 'stopped' : failed ? 'failed' : 'done';
  const error = result?.details?.error || result?.content?.find((part) => part.type === 'text')?.text;
  const label = running ? '正在编辑白板' : stopped ? t('edit.agent.stopped') : failed ? error || '白板修改没有应用' : '白板已更新';
  return <ToolCard title="编辑白板" icon={Presentation} sceneId={sceneId} status={status} statusLabel={label}
    barAction={!running && !failed && !stopped ? <RestoreButton toolCallId={toolCallId} /> : undefined} />;
}

export const EditWhiteboardUI = makeAssistantToolUI<{ sceneId?: string; boardId?: string }, WhiteboardResult>({
  toolName: 'edit_whiteboard',
  render: ({ args, status, result, isError, toolCallId }) => {
    const running = status.type === 'running' || status.type === 'requires-action';
    const stopped = !running && isStoppedResult(result);
    const failed = !running && !stopped && Boolean(isError || result?.details?.error || result?.details?.whiteboardPatch === null || (!result?.details?.whiteboardPatch && status.type === 'incomplete'));
    return <WhiteboardToolCard running={running} stopped={stopped} failed={failed} result={result}
      sceneId={args?.sceneId ?? result?.details?.sceneId} toolCallId={toolCallId} />;
  },
});
