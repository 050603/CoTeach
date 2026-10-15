'use client';

import { Children, useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { ArrowUp, BookOpen, ChevronDown, Loader2, Play, X } from 'lucide-react';
import { Popover } from 'radix-ui';
import { Streamdown } from 'streamdown';
import type { EngineMode } from '@openmaic/lib/playback';
import { dispatchPlaybackModalBlock } from '@openmaic/lib/playback/activity-events';
import { renderQuizMathText } from '@openmaic/lib/quiz/math-text';
import { useStageStore } from '@openmaic/lib/store';
import type {
  LectureChatCitation,
  LectureChatHistory,
  LectureChatInput,
  LectureChatMessage,
  LectureChatPage,
  LectureChatPosition,
  LectureChatStreamEvent,
  LectureChatThread,
} from '@/lib/courses/lecture-chat-types';
import { resolveLectureChatPage, useLectureChatScope } from './lecture-chat-context';
import { browserRandomUUID } from '@/lib/browser/random-uuid';
import styles from '@/components/openmaic/roundtable/lecture-subtitle-dock.module.css';

type LectureChatSlots = {
  entry: ReactNode;
  transcript: ReactNode;
  expanded: boolean;
  active: boolean;
  hasContext: boolean;
  onPlayPause: (() => void) | undefined;
};

type LectureChatProps = {
  activeActionIndex: number;
  mediaTimeMs?: number | null;
  knowledgeLabel?: string;
  engineMode: EngineMode;
  onPlayPause?: () => void;
  children: (slots: LectureChatSlots) => ReactNode;
};

type PendingQuestion = { input: LectureChatInput; terminal: boolean };
type SavedQuestion = { draft: string; position?: LectureChatPosition; pending?: PendingQuestion };
type AnswerReadingPosition = { requestId: string; positioned: boolean; complete: boolean; manual: boolean; scrollTop?: number };

const MAX_QUESTION_LENGTH = 1000;
const RECOVERY_TIMEOUT_MS = 180_000;
const SAVE_FAILED = 'LECTURE_CHAT_SAVE_FAILED';
const TERMINAL_REQUEST_ERRORS = new Set([
  'REQUEST_INTERRUPTED', 'IDEMPOTENCY_CONFLICT', 'INVALID_POSITION', 'INVALID_LECTURE_CHAT_INPUT',
  'LECTURE_CHAT_CONTEXT_CHANGED', 'LECTURE_CHAT_REQUEST_EXPIRED', 'LECTURE_CHAT_REQUEST_FAILED',
  'LECTURE_CHAT_TIMEOUT', 'LECTURE_CHAT_GENERATION_FAILED', 'LECTURE_CHAT_INCOMPLETE_OUTPUT', 'LECTURE_CHAT_EMPTY_OUTPUT',
]);

function requestFailureMessage(code?: string): string {
  if (code === SAVE_FAILED) return '答复保存失败，请重试以恢复已经生成的回答。';
  return code && !/^[A-Z_]+$/.test(code) ? code : '这次答复未完成，可以重新提问。';
}

function storageKey(studentId: string, courseId: string, page: LectureChatPage): string {
  return `openpbl:lecture-chat:${encodeURIComponent(studentId)}:${encodeURIComponent(courseId)}:${encodeURIComponent(page.classroomId)}:${encodeURIComponent(page.sceneId)}`;
}

function readSavedQuestion(key: string): SavedQuestion {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return { draft: '' };
    const value = JSON.parse(raw) as SavedQuestion;
    return {
      draft: typeof value.draft === 'string' ? value.draft.slice(0, MAX_QUESTION_LENGTH) : '',
      position: value.position,
      pending: value.pending?.input?.requestId ? value.pending : undefined,
    };
  } catch {
    return { draft: '' };
  }
}

function saveQuestion(key: string, question: SavedQuestion): void {
  try {
    if (!question.draft && !question.pending) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(question));
  } catch {
    // Private browsing/storage limits must not prevent a question from being sent.
  }
}

function getPosition(actionIndex: number, mediaTimeMs?: number | null): LectureChatPosition {
  return {
    actionIndex: Math.max(0, Number.isFinite(actionIndex) ? Math.floor(actionIndex) : 0),
    ...(typeof mediaTimeMs === 'number' && Number.isFinite(mediaTimeMs)
      ? { mediaTimeMs: Math.max(0, Math.round(mediaTimeMs)) }
      : {}),
  };
}

async function responseFailure(response: Response): Promise<{ message: string; code?: string }> {
  try {
    const data = await response.json() as { message?: string; error?: string; code?: string };
    const code = data.code || data.error;
    if (data.message || data.error) return { message: data.message || requestFailureMessage(data.error), code };
  } catch { /* The HTTP status still identifies a non-JSON failure. */ }
  return { message: response.status === 403 ? '当前课堂暂不可提问。' : '暂时无法读取答疑，请重试。' };
}

async function pollDelay(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 1500);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/** Adds only the student-side control surface; the server resolves all teaching evidence. */
export function LectureChat(props: LectureChatProps) {
  const scope = useLectureChatScope();
  const scene = useStageStore((state) => state.getCurrentScene());
  const page = scope ? resolveLectureChatPage(scene, scope.classroomId) : null;
  if (!scope || !page) {
    return props.children({ entry: null, transcript: null, expanded: false, active: false, hasContext: false, onPlayPause: props.onPlayPause });
  }
  return <PageLectureChat {...props} courseId={scope.courseId} studentId={scope.studentId} page={page}
    key={storageKey(scope.studentId, scope.courseId, page)} pageTitle={scene?.title || '当前讲解'} />;
}

function PageLectureChat({
  courseId, studentId, page, pageTitle, activeActionIndex, mediaTimeMs, knowledgeLabel, engineMode, onPlayPause, children,
}: LectureChatProps & { courseId: string; studentId: string; page: LectureChatPage; pageTitle: string }) {
  const key = storageKey(studentId, courseId, page);
  const [saved, setSaved] = useState<SavedQuestion>(() => readSavedQuestion(key));
  const [thread, setThread] = useState<LectureChatThread | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [streamText, setStreamText] = useState('');
  const [writable, setWritable] = useState(true);
  const controllerRef = useRef<AbortController | null>(null);
  const blockedRef = useRef(false);
  const composingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const readingPositionRef = useRef<AnswerReadingPosition | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endpoint = `/api/courses/${encodeURIComponent(courseId)}/lecture-chat`;
  const historyUrl = `${endpoint}?${new URLSearchParams(page).toString()}`;

  const blockPlayback = useCallback(() => {
    if (!blockedRef.current) {
      blockedRef.current = true;
      dispatchPlaybackModalBlock({ blocked: true, source: 'lecture-chat', restorePlayback: false });
    }
    setInterrupted(true);
  }, []);

  const releasePlayback = useCallback(() => {
    if (blockedRef.current) {
      blockedRef.current = false;
      dispatchPlaybackModalBlock({ blocked: false, source: 'lecture-chat', restorePlayback: false });
    }
  }, []);

  const readHistory = useCallback(async (signal: AbortSignal): Promise<LectureChatHistory> => {
    const response = await fetch(historyUrl, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error((await responseFailure(response)).message);
    const history = await response.json() as LectureChatHistory;
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    setThread(history.thread);
    setWritable(history.writable);
    return history;
  }, [historyUrl]);

  const reconcile = useCallback((history: LectureChatHistory, question: PendingQuestion) => {
    const request = history.requests.find((item) => item.requestId === question.input.requestId);
    if (request?.status === 'COMPLETED') {
      setSaved((previous) => ({ ...previous, pending: undefined }));
      setStreamText('');
      setBusy(false);
      setStatus('');
      setError('');
      return 'complete';
    }
    if (request?.status === 'FAILED' || request?.status === 'CANCELLED') {
      setSaved((previous) => ({ ...previous, pending: { ...question, terminal: request.error !== SAVE_FAILED } }));
      setBusy(false);
      setStatus('');
      setError(requestFailureMessage(request.error));
      return 'failed';
    }
    return request?.status === 'RUNNING' ? 'running' : 'unknown';
  }, []);

  const recover = useCallback(async (question: PendingQuestion, signal: AbortSignal) => {
    const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
    setBusy(true);
    setStatus('正在恢复答复…');
    while (!signal.aborted && Date.now() < deadline) {
      const history = await readHistory(signal);
      const result = reconcile(history, question);
      if (result === 'complete' || result === 'failed') return;
      if (result === 'unknown') throw new Error('这次提问尚未确认，点击重试恢复提问。');
      await pollDelay(signal);
    }
    if (!signal.aborted) throw new Error('答复仍未完成，点击重试查看处理结果。');
  }, [readHistory, reconcile]);

  useEffect(() => {
    saveQuestion(key, saved);
  }, [key, saved]);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    const stored = readSavedQuestion(key);
    void (async () => {
      const history = await readHistory(controller.signal);
      const running = history.requests.find((request) => request.status === 'RUNNING');
      const student = running && history.thread.messages.find((message) => message.role === 'student'
        && message.requestId === running.requestId);
      const pending = stored.pending ?? (student ? {
        input: { classroomId: page.classroomId, sceneId: page.sceneId, ...student.position,
          message: student.content, requestId: student.requestId },
        terminal: false,
      } : undefined);
      if (!pending) return;
      setSaved((previous) => ({ ...previous, pending }));
      const result = reconcile(history, pending);
      if (result === 'running') await recover(pending, controller.signal);
      else if (result === 'unknown') setError('这次提问尚未确认，点击重试恢复提问。');
    })().catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      setBusy(false);
      setStatus('');
      setError(failure instanceof Error ? failure.message : '暂时无法读取答疑，请重试。');
    });
    return () => {
      controller.abort();
      controllerRef.current?.abort();
      releasePlayback();
    };
  }, [key, page.classroomId, page.sceneId, readHistory, reconcile, recover, releasePlayback]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    const reading = readingPositionRef.current;
    if (!expanded || !container || !reading) return;
    const answer = [...container.querySelectorAll<HTMLElement>('[data-lecture-chat-answer]')]
      .find(element => element.dataset.requestId === reading.requestId);
    if (!answer) return;
    const complete = answer.dataset.answerComplete === 'true';
    // Anchor once at the first text and once when the saved answer replaces it.
    // Growing text must never move the student's reading position.
    if ((!reading.positioned || (complete && !reading.complete)) && !reading.manual) {
      container.scrollTop += answer.getBoundingClientRect().top - container.getBoundingClientRect().top;
      reading.scrollTop = container.scrollTop;
    }
    reading.positioned = true;
    reading.complete = complete;
  }, [expanded, thread, streamText, busy]);

  const continueLearning = () => {
    setExpanded(false);
    setInterrupted(false);
    releasePlayback();
    if (engineMode !== 'playing') onPlayPause?.();
    inputRef.current?.blur();
  };

  const closeChat = () => {
    setExpanded(false);
    releasePlayback();
  };

  const submitQuestion = async (question: PendingQuestion) => {
    const replay = saved.pending?.input.requestId === question.input.requestId;
    if (busy || (!writable && !replay)) return;
    blockPlayback();
    setExpanded(true);
    readingPositionRef.current = { requestId: question.input.requestId, positioned: false, complete: false, manual: false };
    setError('');
    setStreamText('');
    setBusy(true);
    setStatus('正在组织回答…');
    const pending = { ...question, terminal: false };
    const nextSaved = { draft: '', position: getPosition(question.input.actionIndex, question.input.mediaTimeMs), pending };
    setSaved(nextSaved);
    // Persist before the request, including the id, so a refresh can safely retry it.
    saveQuestion(key, nextSaved);
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(RECOVERY_TIMEOUT_MS)]);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(question.input),
        signal: requestSignal,
      });
      if (controller.signal.aborted) return;
      if (response.status === 202) {
        await recover(pending, requestSignal);
        return;
      }
      if (!response.ok) {
        const failure = await responseFailure(response);
        if (failure.code && TERMINAL_REQUEST_ERRORS.has(failure.code)) {
          setSaved((previous) => ({ ...previous, pending: { ...pending, terminal: true } }));
          throw new Error(failure.message);
        }
        if (response.status === 409) {
          const history = await readHistory(requestSignal);
          const result = reconcile(history, pending);
          if (result === 'complete' || result === 'failed') return;
          if (result === 'running') {
            await recover(pending, requestSignal);
            return;
          }
        }
        throw new Error(failure.message);
      }
      if (!response.body) throw new Error('答复连接未建立，点击重试恢复提问。');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      const consume = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line) as LectureChatStreamEvent;
        if (event.type === 'status') setStatus(event.message);
        else if (event.type === 'delta') setStreamText((previous) => previous + event.text);
        else if (event.type === 'done') {
          finished = true;
          setThread(event.thread);
          setSaved((previous) => ({ ...previous, pending: undefined }));
          setStreamText('');
          setBusy(false);
          setStatus('');
          setError('');
        } else if (event.type === 'error') {
          finished = true;
          setSaved((previous) => ({ ...previous, pending: { ...pending, terminal: event.error !== SAVE_FAILED } }));
          setBusy(false);
          setStatus('');
          setError(event.message);
        }
      };
      try {
        while (!controller.signal.aborted) {
          const part = await reader.read();
          if (controller.signal.aborted) return;
          buffer += decoder.decode(part.value, { stream: !part.done });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          lines.forEach(consume);
          if (part.done) {
            consume(buffer);
            break;
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      if (!finished && !controller.signal.aborted) throw new Error('答复连接已中断，点击重试查看或恢复这次提问。');
    } catch (failure) {
      if (controller.signal.aborted) return;
      setBusy(false);
      setStatus('');
      setError(requestSignal.aborted ? '等待答复超时，点击重试查看或恢复这次提问。'
        : failure instanceof Error ? failure.message : '暂时无法答复，点击重试恢复提问。');
    }
  };

  const sendDraft = () => {
    const message = saved.draft.trim();
    if (!message || busy || (saved.pending && !saved.pending.terminal) || !writable) return;
    void submitQuestion({
      input: { ...page, ...(saved.position ?? getPosition(activeActionIndex, mediaTimeMs)),
        message, requestId: browserRandomUUID() },
      terminal: false,
    });
  };

  const retry = () => {
    if (busy) return;
    if (saved.pending && (writable || !saved.pending.terminal)) {
      const input = saved.pending.terminal
        ? { ...saved.pending.input, ...getPosition(activeActionIndex, mediaTimeMs), requestId: browserRandomUUID() }
        : saved.pending.input;
      void submitQuestion({ input, terminal: false });
    } else {
      setError('');
      const controller = new AbortController();
      controllerRef.current?.abort();
      controllerRef.current = controller;
      void readHistory(controller.signal).then((history) => {
        if (saved.pending) reconcile(history, saved.pending);
      }).catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '暂时无法读取答疑，请重试。');
      });
    }
  };

  const messages = thread?.messages ?? [];
  const pendingInput = saved.pending?.input;
  const visibleMessages: LectureChatMessage[] = pendingInput
    && !messages.some((message) => message.role === 'student' && message.requestId === pendingInput.requestId)
    ? [...messages, { id: `pending:${pendingInput.requestId}`, role: 'student', content: pendingInput.message,
      requestId: pendingInput.requestId, position: pendingInput, createdAt: '' }]
    : messages;
  const hasSavedAnswer = pendingInput && messages.some((message) => message.role === 'assistant'
    && message.requestId === pendingInput.requestId);
  const questionCount = visibleMessages.filter((message) => message.role === 'student').length;
  const label = knowledgeLabel || thread?.pageTitle || pageTitle;
  const hasContext = Boolean(saved.draft || interrupted || expanded);
  const transcript = expanded ? <section aria-label="本页随课问答" className={styles.chatPanel}
    onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
    <div className="flex shrink-0 items-center justify-between gap-2 pb-2">
      <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-200">本页随课问答</h4>
      <button type="button" onClick={closeChat}
        className="inline-flex min-h-11 items-center gap-1 rounded-md px-1.5 text-[11px] text-slate-400 hover:text-teal-700 dark:hover:text-teal-300">
        收起答疑 <ChevronDown size={13} />
      </button>
    </div>
    <div aria-live="polite" aria-relevant="additions" className={styles.chatMessages} role="log" ref={scrollRef}
      onScroll={(event) => {
        const reading = readingPositionRef.current;
        if (reading?.positioned && (reading.scrollTop === undefined || Math.abs(event.currentTarget.scrollTop - reading.scrollTop) > 2)) {
          reading.manual = true;
        }
      }} onWheel={(event) => {
        if (readingPositionRef.current) readingPositionRef.current.manual = true;
        event.stopPropagation();
      }} onPointerDown={() => { if (readingPositionRef.current) readingPositionRef.current.manual = true; }}
      onKeyDown={(event) => {
        if (readingPositionRef.current && ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) {
          readingPositionRef.current.manual = true;
        }
        event.stopPropagation();
      }}
      onKeyUp={(event) => event.stopPropagation()} tabIndex={0}>
      {visibleMessages.map((message) => <article key={message.id}
        data-lecture-chat-answer={message.role === 'assistant' ? 'true' : undefined}
        data-request-id={message.requestId} data-answer-complete={message.role === 'assistant' ? 'true' : undefined}
        className={message.role === 'student' ? styles.chatQuestion : styles.chatAnswer}>
        <p className="mb-1 text-[10px] font-medium text-slate-400">{message.role === 'student' ? '我的问题' : '随课答疑'}</p>
        {message.role === 'student' ? <p className="whitespace-pre-wrap text-[13px] leading-5 [overflow-wrap:anywhere]">{message.content}</p>
          : <LectureChatMarkdown content={message.content} />}
        {message.citations?.length ? <CitationList citations={message.citations} /> : null}
      </article>)}
      {pendingInput && streamText && !hasSavedAnswer ? <article className={styles.chatAnswer} data-incomplete-answer
        data-lecture-chat-answer="true" data-request-id={pendingInput.requestId} data-answer-complete="false">
        <p className="mb-1 text-[10px] font-medium text-slate-400">随课答疑 · {busy ? '正在回答' : '答复尚未完成'}</p>
        <LectureChatMarkdown content={streamText} />
      </article> : null}
      {busy ? <p className="flex items-center gap-2 pb-2 text-xs text-teal-700 dark:text-teal-300" role="status">
        <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={13} />{status || '正在回答…'}
      </p> : null}
    </div>
  </section> : null;
  const entry = <div className={styles.chatEntry} data-lecture-chat-entry
    onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
    {hasContext || questionCount > 0 ? <div className="mb-1 flex min-h-11 min-w-0 items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
      {hasContext ? <p className="min-w-0 truncate text-[11px] text-slate-400" title={`关于：${label}`}>关于：{label}</p> : null}
      {questionCount > 0 && !expanded ? <button type="button" className="min-h-11 shrink-0 text-left text-[11px] text-slate-400 hover:text-teal-700 dark:hover:text-teal-300"
          onClick={() => {
            const latest = thread?.messages.findLast(message => message.role === 'assistant');
            const requestId = saved.pending && !saved.pending.terminal ? saved.pending.input.requestId : latest?.requestId;
            readingPositionRef.current = requestId ? { requestId, positioned: false, complete: false, manual: false } : null;
            blockPlayback(); setExpanded(true);
          }}>
          本页问答 · {questionCount}
        </button> : null}
      </div>
      {interrupted || expanded ? <button type="button" className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-1 text-[11px] font-medium text-teal-700 hover:text-teal-900 dark:text-teal-300"
        onClick={continueLearning}><Play size={11} fill="currentColor" aria-hidden="true" />继续学习</button> : null}
    </div> : null}
    {error ? <div className="mb-1 flex items-start gap-2 text-[11px] leading-4 text-amber-700 dark:text-amber-300" role="alert">
      <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{error}</p>
      <button className="min-h-11 shrink-0 underline underline-offset-2 disabled:opacity-40" disabled={busy}
        onClick={retry} type="button">重试</button>
    </div> : null}
    {!writable ? <p className="mb-1 text-[11px] text-slate-400">当前课堂暂不可提问，已有问答仍可回看。</p> : null}
    <form className={styles.chatComposer} onSubmit={(event) => { event.preventDefault(); sendDraft(); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing
          && !composingRef.current && event.keyCode !== 229) {
          event.preventDefault();
          sendDraft();
        }
      }} onKeyUp={(event) => event.stopPropagation()}>
      <label className="sr-only" htmlFor={`lecture-question-${encodeURIComponent(key)}`}>随课提问</label>
      <textarea className={styles.chatInput} id={`lecture-question-${encodeURIComponent(key)}`} rows={1}
        maxLength={MAX_QUESTION_LENGTH} placeholder={busy ? '正在组织回答…' : '这里没听懂？问一下'}
        ref={inputRef} value={saved.draft} disabled={busy || !writable}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onChange={(event) => {
          const draft = event.currentTarget.value;
          const position = saved.draft ? saved.position ?? getPosition(activeActionIndex, mediaTimeMs)
            : getPosition(activeActionIndex, mediaTimeMs);
          setSaved((previous) => ({ ...previous, draft, position }));
          if (draft.trim()) blockPlayback();
          else if (!expanded) releasePlayback();
        }} />
      <button type="submit" aria-label="发送问题" disabled={!saved.draft.trim() || busy || Boolean(saved.pending && !saved.pending.terminal) || !writable}
        className={styles.chatSend}>
        <ArrowUp aria-hidden="true" size={17} strokeWidth={1.8} />
      </button>
    </form>
  </div>;
  // Slots contain DOM refs and callbacks, but the render function only places the slots in the dock.
  // eslint-disable-next-line react-hooks/refs
  return children({ entry, transcript, expanded, active: Boolean(expanded || (interrupted && saved.draft)), hasContext,
    onPlayPause: engineMode === 'playing' ? onPlayPause : continueLearning });
}

function MathChildren({ children }: { children?: ReactNode }) {
  return Children.map(children, (child) => typeof child === 'string'
    ? renderQuizMathText(child).map((segment, index) => segment.type === 'text' ? segment.value
      : <span key={index} className={segment.displayMode ? styles.chatDisplayMath : styles.chatInlineMath}
        aria-label={segment.value} dangerouslySetInnerHTML={{ __html: segment.html }} />)
    : child);
}

const markdownComponents = {
  p: ({ children }: { children?: ReactNode }) => <p><MathChildren>{children}</MathChildren></p>,
  li: ({ children }: { children?: ReactNode }) => <li><MathChildren>{children}</MathChildren></li>,
  strong: ({ children }: { children?: ReactNode }) => <strong><MathChildren>{children}</MathChildren></strong>,
  em: ({ children }: { children?: ReactNode }) => <em><MathChildren>{children}</MathChildren></em>,
  td: ({ children }: { children?: ReactNode }) => <td><MathChildren>{children}</MathChildren></td>,
  th: ({ children }: { children?: ReactNode }) => <th><MathChildren>{children}</MathChildren></th>,
  img: () => null,
};

function LectureChatMarkdown({ content }: { content: string }) {
  return <Streamdown className={styles.chatMarkdown} components={markdownComponents} controls={false}
    mode="static" skipHtml>{content}</Streamdown>;
}

function CitationList({ citations }: { citations: LectureChatCitation[] }) {
  const books = new Map<string, LectureChatCitation[]>();
  for (const citation of citations) {
    const group = books.get(citation.revisionId) ?? [];
    group.push(citation);
    books.set(citation.revisionId, group);
  }
  return <div className={styles.chatSources} role="group" aria-label="教材出处">
    {[...books.entries()].map(([revisionId, sources], index) => <CitationBook key={revisionId} citations={sources}
      index={books.size > 1 ? index + 1 : undefined} />)}
  </div>;
}

function CitationBook({ citations, index }: { citations: LectureChatCitation[]; index?: number }) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(false);
  const restoreFocusRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearClose = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  useEffect(() => () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current); }, []);
  const changeOpen = (next: boolean) => {
    clearClose();
    if (!next) pinnedRef.current = false;
    setOpen(next);
  };
  const hover = (event: PointerEvent) => {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    clearClose();
    setOpen(true);
  };
  const leave = () => {
    clearClose();
    if (!pinnedRef.current) closeTimerRef.current = setTimeout(() => {
      if (!pinnedRef.current) setOpen(false);
    }, 180);
  };
  const pin = () => { pinnedRef.current = true; restoreFocusRef.current = true; clearClose(); };
  return <Popover.Root open={open} onOpenChange={changeOpen}>
    <Popover.Trigger asChild>
      <button type="button" aria-label={`查看教材来源：${citations[0].textbookTitle}`} className={styles.chatSourceButton}
        onPointerEnter={hover} onPointerLeave={leave} onClick={(event) => {
          event.preventDefault();
          if (pinnedRef.current) changeOpen(false);
          else {
            pin(); setOpen(true);
            if (open && event.detail === 0) contentRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
          }
        }}>
        <BookOpen size={15} aria-hidden="true" strokeWidth={1.7} />
        {index ? <span aria-hidden="true" className={styles.chatSourceIndex}>{index}</span> : null}
      </button>
    </Popover.Trigger>
    <Popover.Portal container={open && typeof document !== 'undefined' ? document.fullscreenElement : undefined}>
      <Popover.Content ref={contentRef} aria-label="教材来源" className={styles.chatSourcePopover} side="top" align="end"
        sideOffset={6} collisionPadding={12} onPointerEnter={hover} onPointerLeave={leave}
        onPointerDown={pin} onKeyDown={(event) => { if (event.key !== 'Escape') pin(); event.stopPropagation(); }}
        onKeyUp={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}
        onOpenAutoFocus={(event) => { if (!pinnedRef.current) event.preventDefault(); }} onCloseAutoFocus={(event) => {
          if (!restoreFocusRef.current) event.preventDefault();
          restoreFocusRef.current = false;
        }}>
        <div className={styles.chatSourceHeader}>
          <h5>{citations[0].textbookTitle}</h5>
          <button type="button" aria-label="关闭教材来源" className={styles.chatSourceClose} onClick={() => changeOpen(false)}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        {citations.map(citation => <section key={citation.id} className={styles.chatSourceSection}>
          <p className={styles.chatSourcePath}>{citation.sectionPath.join(' › ') || '教材原文'}</p>
          <details className={styles.chatCitation}>
            <summary>查看原文 <ChevronDown size={12} aria-hidden="true" /></summary>
            <blockquote><MathChildren>{citation.quote}</MathChildren></blockquote>
          </details>
        </section>)}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
