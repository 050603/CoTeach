'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Crosshair, Play, Plus, Trash2, X } from 'lucide-react';
import type { LaserAction } from '@openmaic/lib/types/action';
import type { Scene } from '@openmaic/lib/types/stage';
import { useI18n } from '@openmaic/lib/hooks/use-i18n';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@openmaic/components/ui/dialog';
import { clearCuePreview, previewCueEffect } from './cue-preview';
import { elementLabel } from './cue-meta';
import { laserPathDraft, validateLaserPathDraft, type LaserPathDraft, type LaserStopDraft } from './laser-path';
import { whiteboardBlocks } from './whiteboard-edit';

type SlideElement = { id: string; type: string; name?: string; content?: string };

export function laserElementName(element: SlideElement | undefined, index: number, t: (key: string) => string): string {
  if (!element) return '未选择元素';
  const label = element.name?.trim() || elementLabel(element, t);
  return `${String(index + 1).padStart(2, '0')} · ${label}`;
}

export function LaserPathEditor({
  action,
  scene,
  onClose,
  onSave,
}: {
  action: LaserAction;
  scene: Scene;
  onClose: () => void;
  onSave: (draft: LaserPathDraft) => void;
}) {
  const { t } = useI18n();
  const elements: SlideElement[] = scene.content.type === 'slide' ? scene.content.canvas.elements : [];
  const boards = whiteboardBlocks(scene.actions ?? []);
  const speeches = (scene.actions ?? []).flatMap((item, index) =>
    item.type === 'speech' && !boards.some((board) => index >= board.start && index <= board.end)
      ? [{ id: item.id, text: item.text }]
      : [],
  );
  const [draft, setDraft] = useState(() => laserPathDraft(action));
  const selectedSpeechText = speeches.find((speech) => speech.id === draft.speechId)?.text ?? '';
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const stopPreview = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    clearCuePreview();
  };
  useEffect(() => () => {
    timers.current.forEach(clearTimeout);
    clearCuePreview();
  }, []);

  const changeStop = (index: number, patch: Partial<LaserStopDraft>) => {
    setError(null);
    setDraft((current) => ({
      ...current,
      stops: current.stops.map((stop, at) => at === index ? { ...stop, ...patch } : stop),
    }));
  };
  const moveStop = (index: number, direction: -1 | 1) => {
    setError(null);
    setDraft((current) => {
      const stops = current.stops.slice();
      [stops[index], stops[index + direction]] = [stops[index + direction], stops[index]];
      return { ...current, stops };
    });
  };
  const addStop = () => {
    const previousId = draft.stops[draft.stops.length - 1]?.elementId;
    const element = elements.find((candidate) => !draft.stops.some((stop) => stop.elementId === candidate.id))
      ?? elements.find((candidate) => candidate.id !== previousId)
      ?? elements[0];
    if (!element || draft.stops.length >= 5) return;
    const last = draft.stops[draft.stops.length - 1];
    const latestTimed = [...draft.stops].reverse().find((stop) => stop.mode === 'time');
    setDraft((current) => ({
      ...current,
      speechId: current.speechId || speeches[0]?.id || '',
      stops: [...current.stops, {
        elementId: element.id,
        mode: last?.mode ?? 'time',
        offsetMs: last?.mode === 'time' ? last.offsetMs + 1200 : (latestTimed?.offsetMs ?? 0) + 1200,
        quote: '',
      }],
    }));
    setError(null);
  };
  const preview = () => {
    stopPreview();
    draft.stops.forEach((stop, index) => {
      if (!stop.elementId) return;
      timers.current.push(setTimeout(() => previewCueEffect('laser', stop.elementId, stop.selector), index * 750));
    });
    timers.current.push(setTimeout(clearCuePreview, draft.stops.length * 750 + 500));
  };
  const apply = () => {
    const reason = validateLaserPathDraft(draft, elements.map((element) => element.id), speeches);
    if (reason) {
      setError(reason);
      return;
    }
    stopPreview();
    onSave(draft);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[min(760px,calc(100dvh-32px))] max-w-[760px] gap-0 overflow-hidden rounded-[14px] border border-[#D8D6D0] bg-[#FCFBF8] p-0 text-[#1F2933] shadow-2xl" showCloseButton={false}>
        <div className="flex items-start gap-4 border-b border-[#D8D6D0] px-6 py-5">
          <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-[#FCE9E7] text-[#A43B38]"><Crosshair size={20} /></span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-lg font-semibold">编辑激光路径</DialogTitle>
            <DialogDescription className="mt-1 text-sm text-[#5F6B76]">按讲解顺序设置起点和途经元素，播放时激光会依次移动。</DialogDescription>
          </div>
          <button type="button" aria-label="关闭激光路径编辑" onClick={onClose} className="grid size-10 shrink-0 place-items-center rounded-[8px] text-[#5F6B76] hover:bg-[#F0EEE8] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#344A6A]"><X size={18} /></button>
        </div>

        <div className="min-h-0 overflow-y-auto px-6 py-5">
          <div className="mb-5 flex flex-wrap items-center gap-2" aria-label="激光滑动顺序">
            {draft.stops.map((stop, index) => (
              <div className="flex items-center gap-2" key={`${index}-${stop.elementId}`}>
                {index > 0 && <ArrowRight size={16} className="text-[#9EA8AD]" aria-hidden="true" />}
                <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-[8px] border border-[#E5C7C4] bg-[#FFF5F3] px-2.5 py-1.5 text-xs font-medium text-[#803B38]">
                  <span className="font-mono">{index + 1}</span>
                  <span className="truncate">{laserElementName(elements.find((item) => item.id === stop.elementId), elements.findIndex((item) => item.id === stop.elementId), t)}</span>
                </span>
              </div>
            ))}
          </div>

          <label className="mb-5 block text-sm font-medium">
            绑定讲稿
            <select
              value={draft.speechId}
              onChange={(event) => { setDraft((current) => ({ ...current, speechId: event.target.value })); setError(null); }}
              className="mt-2 block min-h-11 w-full rounded-[8px] border border-[#C9CED0] bg-white px-3 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#344A6A]"
            >
              <option value="">{draft.stops.length === 1 ? '不绑定（定点激光）' : '请选择讲稿'}</option>
              {speeches.map((speech, index) => <option key={speech.id} value={speech.id}>{index + 1}. {speech.text.trim() || '空讲稿'}</option>)}
            </select>
            <span className="mt-1 block text-xs font-normal text-[#5F6B76]">滑动路径需要绑定一段讲稿；每个目标可按讲解词或秒数触发。</span>
          </label>

          <div className="space-y-2">
            {draft.stops.map((stop, index) => (
              <div key={index} className="rounded-[10px] border border-[#D8D6D0] bg-white p-3">
                <div className="flex items-center gap-2">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#FCE9E7] font-mono text-xs font-semibold text-[#A43B38]">{index + 1}</span>
                  <span className="text-sm font-semibold">{index === 0 ? '激光起点' : `滑动至第 ${index + 1} 个目标`}</span>
                  <div className="ml-auto flex gap-1">
                    <button type="button" aria-label={`上移第 ${index + 1} 个目标`} disabled={index === 0} onClick={() => moveStop(index, -1)} className="grid size-11 place-items-center rounded-[8px] text-[#5F6B76] hover:bg-[#F0EEE8] disabled:opacity-30"><ArrowUp size={16} /></button>
                    <button type="button" aria-label={`下移第 ${index + 1} 个目标`} disabled={index === draft.stops.length - 1} onClick={() => moveStop(index, 1)} className="grid size-11 place-items-center rounded-[8px] text-[#5F6B76] hover:bg-[#F0EEE8] disabled:opacity-30"><ArrowDown size={16} /></button>
                    {index > 0 && <button type="button" aria-label={`删除第 ${index + 1} 个目标`} onClick={() => { setDraft((current) => ({ ...current, stops: current.stops.filter((_, at) => at !== index) })); setError(null); }} className="grid size-11 place-items-center rounded-[8px] text-[#A43B38] hover:bg-[#FCE9E7]"><Trash2 size={16} /></button>}
                  </div>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px_minmax(0,1fr)]">
                  <label className="text-xs font-medium text-[#5F6B76]">指向元素
                    <select value={stop.elementId} onChange={(event) => changeStop(index, { elementId: event.target.value, selector: undefined })} className="mt-1 block min-h-11 w-full rounded-[8px] border border-[#C9CED0] bg-white px-2.5 text-sm text-[#1F2933] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#344A6A]">
                      <option value="">请选择元素</option>
                      {elements.map((element, elementIndex) => <option key={element.id} value={element.id}>{laserElementName(element, elementIndex, t)}</option>)}
                    </select>
                  </label>
                  <label className="text-xs font-medium text-[#5F6B76]">触发方式
                    <select value={stop.mode} onChange={(event) => changeStop(index, { mode: event.target.value as LaserStopDraft['mode'] })} className="mt-1 block min-h-11 w-full rounded-[8px] border border-[#C9CED0] bg-white px-2.5 text-sm text-[#1F2933] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#344A6A]">
                      <option value="time">讲解开始后</option>
                      <option value="phrase">说到讲解词</option>
                    </select>
                  </label>
                  {stop.mode === 'time' ? (
                    <label className="text-xs font-medium text-[#5F6B76]">时间（秒）
                      <input type="number" min="0" step="0.1" value={stop.offsetMs / 1000} onChange={(event) => changeStop(index, { offsetMs: Number(event.target.value) * 1000 })} className="mt-1 block min-h-11 w-full rounded-[8px] border border-[#C9CED0] bg-white px-2.5 text-sm text-[#1F2933] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#344A6A]" />
                    </label>
                  ) : (
                    <div>
                      <label className="text-xs font-medium text-[#5F6B76]">讲稿原文
                        <input type="text" value={stop.quote} onChange={(event) => changeStop(index, { quote: event.target.value, occurrence: undefined })} placeholder="填写讲稿中出现的词句" className="mt-1 block min-h-11 w-full rounded-[8px] border border-[#C9CED0] bg-white px-2.5 text-sm text-[#1F2933] placeholder:text-[#9AA4AA] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#344A6A]" />
                      </label>
                      {stop.quote.trim() && selectedSpeechText.split(stop.quote.trim()).length > 2 && (
                        <label className="mt-2 block text-xs font-medium text-[#5F6B76]">对应第几次出现
                          <select value={stop.occurrence ?? 0} onChange={(event) => changeStop(index, { occurrence: Number(event.target.value) })} className="mt-1 block min-h-11 w-full rounded-[8px] border border-[#C9CED0] bg-white px-2.5 text-sm text-[#1F2933] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#344A6A]">
                            {Array.from({ length: selectedSpeechText.split(stop.quote.trim()).length - 1 }, (_, occurrence) => <option key={occurrence} value={occurrence}>第 {occurrence + 1} 次</option>)}
                          </select>
                        </label>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <button type="button" onClick={addStop} disabled={draft.stops.length >= 5 || elements.length === 0 || speeches.length === 0} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-[8px] border border-dashed border-[#A9B5BB] px-3 text-sm font-medium text-[#344A6A] hover:border-[#344A6A] hover:bg-[#F0F3F4] disabled:opacity-40"><Plus size={16} />添加途经元素</button>
          {speeches.length === 0 && <p className="mt-2 text-xs text-[#8A6422]">请先在讲解流程中添加讲稿，再设置滑动路径。</p>}
          {error && <p role="alert" className="mt-4 rounded-[8px] bg-[#FFF1E5] px-3 py-2 text-sm text-[#8A6422]">{error}</p>}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[#D8D6D0] bg-white px-6 py-4">
          <button type="button" onClick={preview} className="inline-flex min-h-11 items-center gap-2 rounded-[8px] px-3 text-sm font-medium text-[#344A6A] hover:bg-[#F0F3F4]"><Play size={16} />预览路径</button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="min-h-11 rounded-[8px] border border-[#D8D6D0] px-4 text-sm font-medium hover:bg-[#F0EEE8]">取消</button>
            <button type="button" onClick={apply} className="min-h-11 rounded-[8px] bg-[#344A6A] px-4 text-sm font-semibold text-white hover:bg-[#263B58]">应用路径</button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
