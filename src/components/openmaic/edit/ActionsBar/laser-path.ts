import type { Action, LaserAction, VisualTargetSelector } from '@openmaic/lib/types/action';
import { MAX_LASER_WAYPOINTS } from '@openmaic/dsl';

export const MAX_LASER_STOPS = MAX_LASER_WAYPOINTS + 1;

export interface LaserStopDraft {
  elementId: string;
  selector?: VisualTargetSelector;
  mode: 'time' | 'phrase';
  offsetMs: number;
  quote: string;
  occurrence?: number;
}

export interface LaserPathDraft {
  speechId: string;
  stops: LaserStopDraft[];
}

function stopFromTarget(target: {
  elementId: string;
  selector?: VisualTargetSelector;
  speechAnchor?: { quote: string; occurrence?: number };
  speechOffsetMs?: number;
}): LaserStopDraft {
  return {
    elementId: target.elementId,
    selector: target.selector,
    mode: target.speechAnchor ? 'phrase' : 'time',
    offsetMs: target.speechOffsetMs ?? 0,
    quote: target.speechAnchor?.quote ?? '',
    occurrence: target.speechAnchor?.occurrence,
  };
}

export function laserPathDraft(action: LaserAction): LaserPathDraft {
  return {
    speechId: action.speechId ?? '',
    stops: [stopFromTarget(action), ...(action.waypoints ?? []).map(stopFromTarget)],
  };
}

function quoteStart(text: string, quote: string, occurrence = 0): number {
  let from = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const at = text.indexOf(quote, from);
    if (at < 0) return -1;
    if (index === occurrence) return at;
    from = at + quote.length;
  }
  return -1;
}

/** Return a teacher-facing reason before applying a route that playback cannot run. */
export function validateLaserPathDraft(
  draft: LaserPathDraft,
  elementIds: readonly string[],
  speeches: readonly { id: string; text: string }[],
): string | null {
  if (draft.stops.length < 1 || draft.stops.length > MAX_LASER_STOPS) return `激光路径需要 1 至 ${MAX_LASER_STOPS} 个目标。`;
  const validElements = new Set(elementIds);
  if (draft.stops.some((stop) => !validElements.has(stop.elementId))) return '请为每一步选择本页的元素。';
  if (draft.stops.length === 1 && !draft.speechId && draft.stops[0].mode === 'time') return null;
  const speech = speeches.find((item) => item.id === draft.speechId);
  if (!speech) return '请选择本页的一段讲稿，激光才能跟随讲解移动。';
  if (draft.stops.length > 1 && new Set(draft.stops.map((stop) => stop.mode)).size > 1) {
    return '同一路径请统一使用讲解词或秒数触发，确保播放顺序与列表一致。';
  }
  let previousTime = -1;
  let previousQuotePosition = -1;
  for (const stop of draft.stops) {
    if (stop.mode === 'time') {
      if (!Number.isFinite(stop.offsetMs) || stop.offsetMs < 0) return '触发时间必须是非负数。';
      if (stop.offsetMs <= previousTime) return '按秒触发的步骤需要按时间从早到晚排列。';
      previousTime = stop.offsetMs;
    } else {
      const quote = stop.quote.trim();
      if (!quote) return '请填写激光移动时对应的讲解词。';
      if (stop.occurrence !== undefined && (!Number.isInteger(stop.occurrence) || stop.occurrence < 0)) {
        return '讲解词出现次数无效。';
      }
      const position = quoteStart(speech.text, quote, stop.occurrence);
      if (position < 0) return `讲稿中找不到“${quote}”，请填写其中的原文。`;
      if (position <= previousQuotePosition) return '讲解词的出现顺序需要与激光路径一致。';
      previousQuotePosition = position;
    }
  }
  return null;
}

function timedTarget(stop: LaserStopDraft) {
  return {
    elementId: stop.elementId,
    ...(stop.selector ? { selector: stop.selector } : {}),
    ...(stop.mode === 'phrase'
      ? { speechAnchor: { quote: stop.quote.trim(), ...(stop.occurrence === undefined ? {} : { occurrence: stop.occurrence }) } }
      : { speechOffsetMs: Math.round(stop.offsetMs) }),
  };
}

export function applyLaserPathDraft(action: LaserAction, draft: LaserPathDraft): LaserAction {
  const [first, ...rest] = draft.stops;
  const { selector: _selector, speechAnchor: _anchor, speechOffsetMs: _offset,
    waypoints: _waypoints, speechId: _speechId, endSpeechAnchor: _endAnchor,
    endSpeechOffsetMs: _endOffset, ...base } = action;
  const firstTarget = timedTarget(first);
  const speechChanged = draft.speechId !== action.speechId;
  return {
    ...base,
    ...firstTarget,
    ...(draft.speechId ? { speechId: draft.speechId } : {}),
    ...(rest.length ? { waypoints: rest.map(timedTarget) } : {}),
    ...(!speechChanged && action.endSpeechAnchor ? { endSpeechAnchor: action.endSpeechAnchor } : {}),
    ...(!speechChanged && action.endSpeechOffsetMs !== undefined ? { endSpeechOffsetMs: action.endSpeechOffsetMs } : {}),
  };
}

export function setLaserPathById(actions: Action[], id: string, draft: LaserPathDraft): Action[] {
  const index = actions.findIndex((action) => action.id === id && action.type === 'laser');
  if (index < 0) return actions;
  const next = actions.slice();
  const updated = applyLaserPathDraft(next[index] as LaserAction, draft);
  next[index] = updated;
  // Timed cues belong immediately before the narration that drives them.
  // Leaving one after that speech would replay it as an unrelated late cue.
  if (draft.speechId) {
    const speechIndex = next.findIndex((action) => action.id === draft.speechId && action.type === 'speech');
    if (speechIndex >= 0 && index !== speechIndex - 1) {
      next.splice(index, 1);
      const destination = next.findIndex((action) => action.id === draft.speechId);
      next.splice(destination, 0, updated);
    }
  }
  return next;
}
