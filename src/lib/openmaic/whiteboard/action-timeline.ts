import { isWhiteboardAction, type Action, type SpeechAction } from '@openmaic/lib/types/action';
import { findSpeechCueAnchorRange, resolveAlignedSpeechCueAnchor } from '../generation/speech-cue-boundaries';

export interface ActionExecutionEntry {
  action: Action;
  /** Position in the persisted action array; normalization keeps this order. */
  actionIndex: number;
  speechId?: string;
  /** Zero-based narration ordinal, rather than an action-array position. */
  speechIndex?: number;
  speechActionIndex?: number;
  /** Exact text position, useful for authoring before audio alignment exists. */
  charOffset?: number;
  /** Verified anchor timing, or an explicitly authored media offset. */
  speechOffsetMs?: number;
  /** False for a missing owner/anchor or a verified gap in aligned speech. */
  speechBindingValid?: boolean;
}

function finiteOffset(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Project bound commands into their narration without moving persisted actions.
 * Text positions order authored steps while audio is pending; they are never
 * converted into guessed milliseconds. Equal positions retain authored order. */
export function orderedActionExecutionEntries(actions: readonly Action[]): ActionExecutionEntry[] {
  const speechById = new Map<string, { speech: SpeechAction; speechIndex: number; actionIndex: number }>();
  let speechIndex = 0;
  actions.forEach((action, actionIndex) => {
    if (action.type !== 'speech') return;
    speechById.set(action.id, { speech: action, speechIndex, actionIndex });
    speechIndex += 1;
  });
  const entries = actions.map((action, actionIndex): ActionExecutionEntry => {
    const entry: ActionExecutionEntry = { action, actionIndex };
    if ((!isWhiteboardAction(action) && action.type !== 'spotlight' && action.type !== 'laser') || !action.speechId) return entry;
    const owner = speechById.get(action.speechId);
    if (!owner) return { ...entry, speechId: action.speechId, speechBindingValid: false };
    const occurrence = action.speechAnchor?.occurrence ?? 0;
    const anchorRange = action.speechAnchor && Number.isInteger(occurrence) && occurrence >= 0
      ? findSpeechCueAnchorRange(owner.speech.text, action.speechAnchor)
      : null;
    const aligned = action.speechAnchor && anchorRange && owner.speech.speechAlignment?.status === 'aligned'
      ? resolveAlignedSpeechCueAnchor(owner.speech.text, owner.speech.speechAlignment.spans, action.speechAnchor)
      : null;
    const offset = finiteOffset(action.speechOffsetMs ?? 0);
    return {
      ...entry,
      speechId: action.speechId,
      speechIndex: owner.speechIndex,
      speechActionIndex: owner.actionIndex,
      speechBindingValid: action.speechAnchor
        ? Boolean(anchorRange && (owner.speech.speechAlignment?.status !== 'aligned' || aligned))
        : offset !== undefined && (owner.speech.audioDurationSec === undefined || offset <= owner.speech.audioDurationSec * 1000),
      ...(anchorRange ? { charOffset: anchorRange.start } : {}),
      ...(!action.speechAnchor || aligned
        ? { speechOffsetMs: aligned?.startMs ?? offset }
        : {}),
    };
  });
  return entries.sort((left, right) => {
    const leftPosition = left.speechActionIndex ?? left.actionIndex;
    const rightPosition = right.speechActionIndex ?? right.actionIndex;
    if (leftPosition !== rightPosition) return leftPosition - rightPosition;
    // A speech starts before the commands owned by its media clock.
    if (left.speechActionIndex === undefined || right.speechActionIndex === undefined) {
      return Number(left.speechActionIndex !== undefined) - Number(right.speechActionIndex !== undefined)
        || left.actionIndex - right.actionIndex;
    }
    if (left.speechOffsetMs !== undefined && right.speechOffsetMs !== undefined) {
      return left.speechOffsetMs - right.speechOffsetMs || left.actionIndex - right.actionIndex;
    }
    const leftTextPosition = left.charOffset ?? (left.speechOffsetMs === 0 ? 0 : undefined);
    const rightTextPosition = right.charOffset ?? (right.speechOffsetMs === 0 ? 0 : undefined);
    if (leftTextPosition !== undefined && rightTextPosition !== undefined) {
      return leftTextPosition - rightTextPosition || left.actionIndex - right.actionIndex;
    }
    return left.actionIndex - right.actionIndex;
  });
}
