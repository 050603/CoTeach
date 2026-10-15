import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@openmaic/lib/types/stage';
import type { PlaybackModalBlockDetail } from '@openmaic/lib/playback/activity-events';
import type { LectureChatHistory, LectureChatInput, LectureChatStreamEvent, LectureChatThread } from '@/lib/courses/lecture-chat-types';
import { LectureChatProvider } from './lecture-chat-context';
import { LectureChat } from './lecture-chat';

const stage = vi.hoisted(() => ({ scene: undefined as Scene | undefined }));
vi.mock('@openmaic/lib/store', () => ({
  useStageStore: (select: (state: { getCurrentScene: () => Scene | undefined }) => unknown) => select({ getCurrentScene: () => stage.scene }),
}));

const page = { classroomId: 'room', sceneId: 'page-one' };
const emptyThread: LectureChatThread = { id: 'thread', page, pageTitle: '教材中的分类方法', messages: [] };
const citation = { id: 'source-one', textbookTitle: '教学方法', revisionId: 'rev-one', sectionPath: ['第一章', '分类方法'], quote: '分类须依据事物的共同特征。' };

function slide(id = 'page-one'): Scene {
  return { id, stageId: 'room', title: '分类方法', order: 0, type: 'slide', actions: [], content: {
    type: 'slide', canvas: { id: 'canvas', elements: [], viewportSize: 1000, viewportRatio: 0.5625,
      theme: { backgroundColor: '#ffffff', fontName: 'Arial', fontColor: '#000000', themeColors: [] } },
  } };
}

function history(thread = emptyThread, requests: LectureChatHistory['requests'] = []): Response {
  return Response.json({ thread, requests, writable: true } satisfies LectureChatHistory);
}

function completedThread(input: LectureChatInput, content = '可以先观察共同特征，再按特征分类。'): LectureChatThread {
  return { ...emptyThread, messages: [
    { id: 'question', role: 'student', content: input.message, requestId: input.requestId,
      createdAt: '2026-10-15T08:00:00.000Z', position: { actionIndex: input.actionIndex, mediaTimeMs: input.mediaTimeMs } },
    { id: 'answer', role: 'assistant', content, requestId: input.requestId,
      createdAt: '2026-10-15T08:00:01.000Z', position: { actionIndex: input.actionIndex }, citations: [citation] },
  ] };
}

function stream(events: LectureChatStreamEvent[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) {
    // Split across UTF-8 and NDJSON boundaries to exercise the real incremental reader.
    const data = encoder.encode(events.map((event) => JSON.stringify(event)).join('\n'));
    controller.enqueue(data.slice(0, 21));
    controller.enqueue(data.slice(21));
    controller.close();
  } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
}

function controlledStream() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
  return {
    response,
    push(event: LectureChatStreamEvent) { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); },
    close() { controller.close(); },
  };
}

function view(onPlayPause = vi.fn(), props: Partial<React.ComponentProps<typeof LectureChat>> = {}, enabled = true, studentId = 'student-one') {
  return <LectureChatProvider scope={enabled ? { courseId: 'course', classroomId: 'room', studentId } : null}>
    <LectureChat activeActionIndex={2} mediaTimeMs={1400} engineMode="paused" onPlayPause={onPlayPause} {...props}>
      {(slots) => <div>
        {slots.expanded ? slots.transcript : <p>当前讲解字幕</p>}
        {slots.entry}
        <button onClick={slots.onPlayPause} type="button">播放器继续</button>
      </div>}
    </LectureChat>
  </LectureChatProvider>;
}

function submit(message = '为什么这样分类？') {
  fireEvent.change(screen.getByRole('textbox', { name: '随课提问' }), { target: { value: message } });
  fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
}

beforeEach(() => {
  stage.scene = slide();
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('lecture questions in the teaching rail', () => {
  it('recovers a stalled connection after its deadline using the same request receipt', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const inputs: LectureChatInput[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return history();
      inputs.push(JSON.parse(init.body as string) as LectureChatInput);
      if (inputs.length > 1) return stream([{ type: 'done', thread: completedThread(inputs.at(-1)!) }]);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }));
    try {
      render(view());
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      submit();
      await waitFor(() => expect(inputs).toHaveLength(1));
      act(() => deadline.abort(new DOMException('Deadline exceeded', 'TimeoutError')));
      await screen.findByText('等待答复超时，点击重试查看或恢复这次提问。');
      timeout.mockRestore();
      fireEvent.click(screen.getByRole('button', { name: '重试' }));
      await screen.findByText('可以先观察共同特征，再按特征分类。');
      expect(inputs[1].requestId).toBe(inputs[0].requestId);
    } finally { timeout.mockRestore(); }
  });

  it('shows only the quiet input and captures the teaching position at the first character', async () => {
    let input: LectureChatInput | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return history();
      input = JSON.parse(init.body as string) as LectureChatInput;
      return stream([{ type: 'status', message: '正在查阅教材' }, { type: 'delta', text: '先观察' },
        { type: 'done', thread: completedThread(input) }]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const events: PlaybackModalBlockDetail[] = [];
    const listen = (event: Event) => events.push((event as CustomEvent<PlaybackModalBlockDetail>).detail);
    window.addEventListener('openmaic:playback-modal-block', listen);
    const onPlayPause = vi.fn();
    try {
      const result = render(view(onPlayPause));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const textbox = screen.getByRole('textbox', { name: '随课提问' });
      expect(textbox).toHaveAttribute('placeholder', '这里没听懂？问一下');
      expect(textbox).toHaveAttribute('maxlength', '1000');
      expect(screen.queryByRole('log')).toBeNull();
      expect(screen.queryByText(/关于：/)).toBeNull();
      fireEvent.focus(textbox);
      expect(events).toEqual([]);
      fireEvent.change(textbox, { target: { value: '为什么这样分类？' } });
      expect(events).toEqual([{ blocked: true, source: 'lecture-chat', restorePlayback: false }]);
      expect(screen.getByText('关于：教材中的分类方法')).toBeInTheDocument();
      expect(screen.queryByRole('log')).toBeNull();
      result.rerender(view(onPlayPause, { activeActionIndex: 5, mediaTimeMs: 8100 }));
      fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
      await screen.findByText('可以先观察共同特征，再按特征分类。');
      expect(input).toMatchObject({ ...page, actionIndex: 2, mediaTimeMs: 1400, message: '为什么这样分类？' });
      expect(Object.keys(input!)).toEqual(expect.arrayContaining(['requestId']));
      expect(input).not.toHaveProperty('textbookText');
      expect(screen.queryByText('当前讲解字幕')).toBeNull();
      const log = screen.getByRole('log');
      expect(within(log).queryByText(citation.textbookTitle)).toBeNull();
      expect(within(log).queryByText('第一章 › 分类方法')).toBeNull();
      fireEvent.click(within(log).getByRole('button', { name: `查看教材来源：${citation.textbookTitle}` }));
      const sources = screen.getByRole('dialog', { name: '教材来源' });
      expect(within(sources).getByText(citation.textbookTitle)).toBeInTheDocument();
      expect(within(sources).getByText('第一章 › 分类方法')).toBeInTheDocument();
      const original = within(sources).getByText('查看原文', { selector: 'summary' });
      expect(original.closest('details')).not.toHaveAttribute('open');
      fireEvent.click(original);
      expect(within(sources).getByText(citation.quote)).toBeVisible();
      fireEvent.click(within(sources).getByRole('button', { name: '关闭教材来源' }));
      fireEvent.click(screen.getByRole('button', { name: '继续学习' }));
      expect(onPlayPause).toHaveBeenCalledOnce();
      expect(events.at(-1)).toEqual({ blocked: false, source: 'lecture-chat', restorePlayback: false });
      expect(screen.queryByRole('log')).toBeNull();
      expect(screen.getByRole('button', { name: '本页问答 · 1' })).toBeInTheDocument();
    } finally { window.removeEventListener('openmaic:playback-modal-block', listen); }
  });

  it('loads saved history quietly and never resumes on collapse', async () => {
    const input = { ...page, message: '如何分类？', actionIndex: 0, requestId: 'old-request' };
    vi.stubGlobal('fetch', vi.fn(async () => history(completedThread(input))));
    const onPlayPause = vi.fn();
    render(view(onPlayPause, { engineMode: 'idle' }));
    await screen.findByRole('button', { name: '本页问答 · 1' });
    expect(screen.queryByRole('log')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '本页问答 · 1' }));
    expect(screen.getByRole('log')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '收起答疑' }));
    expect(screen.queryByRole('log')).toBeNull();
    expect(onPlayPause).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '本页问答 · 1' }));
    expect(screen.getByRole('log')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '播放器继续' }));
    expect(onPlayPause).toHaveBeenCalledOnce();
    expect(screen.queryByRole('log')).toBeNull();
  });

  it('groups source icons by textbook revision and leaves chapter quotes collapsed', async () => {
    const input = { ...page, message: '分类有什么依据？', actionIndex: 0, requestId: 'sources-request' };
    const groupedThread = completedThread(input);
    const secondChapter = { ...citation, id: 'source-two', sectionPath: ['第二章', '分类练习'], quote: '选择分类标准后，要保持这一标准一致。' };
    groupedThread.messages[1].citations = [citation, secondChapter,
      { ...citation, id: 'other-edition', revisionId: 'rev-two', sectionPath: ['新版导论'] },
      { ...citation, id: 'other-book', revisionId: 'rev-three', textbookTitle: '学习科学', sectionPath: ['第三章'] },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => history(groupedThread)));
    render(view());
    fireEvent.click(await screen.findByRole('button', { name: '本页问答 · 1' }));
    const log = screen.getByRole('log');
    const sourceButtons = within(log).getAllByRole('button', { name: /^查看教材来源：/ });
    expect(sourceButtons).toHaveLength(3);
    const editions = within(log).getAllByRole('button', { name: '查看教材来源：教学方法' });
    expect(editions).toHaveLength(2);
    expect(within(log).getByRole('button', { name: '查看教材来源：学习科学' })).toBeInTheDocument();
    expect(within(log).queryByText('教学方法')).toBeNull();
    expect(within(log).queryByText('学习科学')).toBeNull();
    expect(within(log).queryByText('第一章 › 分类方法')).toBeNull();
    expect(within(log).queryByText('第二章 › 分类练习')).toBeNull();
    fireEvent.click(editions[0]);
    const dialog = screen.getByRole('dialog', { name: '教材来源' });
    expect(within(dialog).getByText('教学方法')).toBeInTheDocument();
    expect(within(dialog).getByText('第一章 › 分类方法')).toBeInTheDocument();
    expect(within(dialog).getByText('第二章 › 分类练习')).toBeInTheDocument();
    expect(within(dialog).queryByText('新版导论')).toBeNull();
    const originals = within(dialog).getAllByText('查看原文', { selector: 'summary' });
    expect(originals).toHaveLength(2);
    originals.forEach((original) => expect(original.closest('details')).not.toHaveAttribute('open'));
    fireEvent.click(originals[1]);
    expect(within(dialog).getByText(secondChapter.quote)).toBeVisible();
    expect(originals[0].closest('details')).not.toHaveAttribute('open');
  });

  it('previews sources on hover and keeps the clicked preview open until Escape', async () => {
    const input = { ...page, message: '如何分类？', actionIndex: 0, requestId: 'hover-request' };
    vi.stubGlobal('fetch', vi.fn(async () => history(completedThread(input))));
    const shortcut = vi.fn();
    window.addEventListener('keydown', shortcut);
    try {
      render(view());
      fireEvent.click(await screen.findByRole('button', { name: '本页问答 · 1' }));
      const source = screen.getByRole('button', { name: '查看教材来源：教学方法' });
      expect(source.tagName).toBe('BUTTON');
      source.focus();
      fireEvent.pointerEnter(source, { pointerType: 'mouse' });
      fireEvent.mouseEnter(source);
      await screen.findByRole('dialog', { name: '教材来源' });
      fireEvent.click(source);
      fireEvent.pointerLeave(source, { pointerType: 'mouse', relatedTarget: document.body });
      fireEvent.mouseLeave(source, { relatedTarget: document.body });
      expect(screen.getByRole('dialog', { name: '教材来源' })).toBeInTheDocument();
      fireEvent.keyDown(screen.getByRole('dialog', { name: '教材来源' }), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '教材来源' })).toBeNull());
      expect(document.activeElement).toBe(source);
      expect(shortcut).not.toHaveBeenCalled();
    } finally { window.removeEventListener('keydown', shortcut); }
  });

  it('opens textbook sources by touch and closes them from outside or the close control', async () => {
    const input = { ...page, message: '如何分类？', actionIndex: 0, requestId: 'touch-request' };
    vi.stubGlobal('fetch', vi.fn(async () => history(completedThread(input))));
    render(view());
    fireEvent.click(await screen.findByRole('button', { name: '本页问答 · 1' }));
    const source = screen.getByRole('button', { name: '查看教材来源：教学方法' });
    fireEvent.pointerDown(source, { pointerType: 'touch' });
    fireEvent.pointerUp(source, { pointerType: 'touch' });
    fireEvent.click(source);
    expect(screen.getByRole('dialog', { name: '教材来源' })).toBeInTheDocument();
    // Radix installs outside-pointer listeners on the next event loop turn.
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    fireEvent.pointerDown(document.body, { pointerType: 'touch' });
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '教材来源' })).toBeNull());
    fireEvent.click(source);
    fireEvent.click(screen.getByRole('button', { name: '关闭教材来源' }));
    expect(screen.queryByRole('dialog', { name: '教材来源' })).toBeNull();
  });

  it('keeps a growing answer at its beginning and retains the request marker when it completes', async () => {
    const controlled = controlledStream();
    let input: LectureChatInput | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return history();
      input = JSON.parse(init.body as string) as LectureChatInput;
      return controlled.response;
    }));
    render(view());
    submit();
    await waitFor(() => expect(input).toBeDefined());
    await act(async () => controlled.push({ type: 'delta', text: '先观察共同特征。' }));
    const log = screen.getByRole('log');
    const current = log.querySelector('[data-lecture-chat-answer="true"]')!;
    expect(current).toHaveAttribute('data-request-id', input!.requestId);
    expect(current).toHaveAttribute('data-answer-complete', 'false');
    Object.defineProperties(log, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1000 },
    });
    log.scrollTop = 0;
    await act(async () => controlled.push({ type: 'delta', text: '然后选择一致的分类标准。' }));
    expect(log.scrollTop).toBe(0);
    await act(async () => {
      controlled.push({ type: 'done', thread: completedThread(input!, '先观察共同特征。然后选择一致的分类标准。') });
      controlled.close();
    });
    expect(log.scrollTop).toBe(0);
    const complete = log.querySelector('[data-lecture-chat-answer="true"]')!;
    expect(complete).toHaveAttribute('data-request-id', input!.requestId);
    expect(complete).toHaveAttribute('data-answer-complete', 'true');
    expect(log.querySelectorAll('[data-lecture-chat-answer="true"]')).toHaveLength(1);
  });

  it.each(['scroll', 'wheel', 'touch'] as const)('preserves the reading position after a manual %s during streaming and completion', async (gesture) => {
    const controlled = controlledStream();
    let input: LectureChatInput | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return history();
      input = JSON.parse(init.body as string) as LectureChatInput;
      return controlled.response;
    }));
    render(view());
    submit();
    await waitFor(() => expect(input).toBeDefined());
    await act(async () => controlled.push({ type: 'delta', text: '开始解释分类依据。' }));
    const log = screen.getByRole('log');
    Object.defineProperties(log, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1000 },
      // Replacement answers use jsdom's top=0, so an unwanted completion
      // re-anchor would change scrollTop by -120 instead of silently adding 0.
      getBoundingClientRect: { configurable: true, value: () => new DOMRect(20, 120, 260, 300) },
    });
    log.scrollTop = 680;
    if (gesture === 'scroll') fireEvent.scroll(log);
    else if (gesture === 'wheel') fireEvent.wheel(log, { deltaY: 40 });
    else {
      fireEvent.pointerDown(log, { pointerType: 'touch', pointerId: 1, clientY: 140 });
      fireEvent.pointerUp(log, { pointerType: 'touch', pointerId: 1, clientY: 100 });
    }
    await act(async () => controlled.push({ type: 'delta', text: '新内容继续到达。' }));
    expect(log.scrollTop).toBe(680);
    await act(async () => {
      controlled.push({ type: 'done', thread: completedThread(input!, '开始解释分类依据。新内容继续到达。') });
      controlled.close();
    });
    expect(log.scrollTop).toBe(680);
    expect(log.querySelector('[data-lecture-chat-answer="true"]')).toHaveAttribute('data-answer-complete', 'true');
  });

  it('protects Chinese composition and spaces from the playback shortcuts', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? stream([{ type: 'done', thread: completedThread(JSON.parse(init.body as string) as LectureChatInput) }]) : history());
    vi.stubGlobal('fetch', fetchMock);
    const shortcut = vi.fn();
    window.addEventListener('keydown', shortcut);
    window.addEventListener('keyup', shortcut);
    try {
      render(view());
      const textbox = screen.getByRole('textbox', { name: '随课提问' });
      fireEvent.change(textbox, { target: { value: '这里是什么意思' } });
      fireEvent.compositionStart(textbox);
      fireEvent.keyDown(textbox, { key: 'Enter', isComposing: true });
      fireEvent.keyUp(textbox, { key: 'Enter' });
      fireEvent.keyDown(textbox, { key: ' ' });
      fireEvent.keyUp(textbox, { key: ' ' });
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
      expect(shortcut).not.toHaveBeenCalled();
      fireEvent.compositionEnd(textbox);
      fireEvent.keyDown(textbox, { key: 'Enter' });
      await screen.findByText('可以先观察共同特征，再按特征分类。');
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    } finally {
      window.removeEventListener('keydown', shortcut);
      window.removeEventListener('keyup', shortcut);
    }
  });

  it('recovers an interrupted stream with the same request id and marks partial text incomplete', async () => {
    const inputs: LectureChatInput[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return history();
      inputs.push(JSON.parse(init.body as string) as LectureChatInput);
      if (inputs.length === 1) return stream([{ type: 'delta', text: '这是尚未完成的解释。' }]);
      return stream([{ type: 'done', thread: completedThread(inputs.at(-1)!) }]);
    }));
    render(view());
    submit();
    await screen.findByText('答复连接已中断，点击重试查看或恢复这次提问。');
    expect(screen.getByText('随课答疑 · 答复尚未完成')).toBeInTheDocument();
    expect(document.querySelector('[data-incomplete-answer]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('可以先观察共同特征，再按特征分类。');
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toEqual(inputs[0]);
    expect(screen.getAllByText('为什么这样分类？')).toHaveLength(1);
    expect(document.querySelector('[data-incomplete-answer]')).toBeNull();
  });

  it('uses a fresh request id only after a confirmed terminal failure', async () => {
    const inputs: LectureChatInput[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return history();
      inputs.push(JSON.parse(init.body as string) as LectureChatInput);
      return inputs.length === 1
        ? stream([{ type: 'error', error: 'MODEL_ERROR', message: '教材答疑暂时失败，请重试。' }])
        : stream([{ type: 'done', thread: completedThread(inputs.at(-1)!) }]);
    }));
    render(view());
    submit();
    await screen.findByText('教材答疑暂时失败，请重试。');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('可以先观察共同特征，再按特征分类。');
    expect(inputs[1].requestId).not.toBe(inputs[0].requestId);
    expect(inputs[1].message).toBe(inputs[0].message);
  });

  it('retries saving a completed answer with the same id even when the classroom closes', async () => {
    const input = { ...page, message: '这里是什么意思？', actionIndex: 3, requestId: 'save-request' };
    sessionStorage.setItem('openpbl:lecture-chat:student-one:course:room:page-one', JSON.stringify({
      draft: '', pending: { input, terminal: false },
    }));
    const inputs: LectureChatInput[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        inputs.push(JSON.parse(init.body as string) as LectureChatInput);
        return stream([{ type: 'done', thread: completedThread(inputs.at(-1)!) }]);
      }
      return Response.json({ thread: { ...emptyThread, messages: completedThread(input).messages.slice(0, 1) },
        requests: [{ requestId: input.requestId, status: 'FAILED', error: 'LECTURE_CHAT_SAVE_FAILED' }], writable: false });
    }));
    render(view());
    await screen.findByText('答复保存失败，请重试以恢复已经生成的回答。');
    expect(screen.getByRole('textbox', { name: '随课提问' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('可以先观察共同特征，再按特征分类。');
    expect(inputs).toEqual([input]);
  });

  it('reconciles an HTTP conflict before choosing a new request id', async () => {
    const inputs: LectureChatInput[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        inputs.push(JSON.parse(init.body as string) as LectureChatInput);
        return inputs.length === 1
          ? Response.json({ error: 'REQUEST_INTERRUPTED', message: '上次答复未完成，请重新发送问题。' }, { status: 409 })
          : stream([{ type: 'done', thread: completedThread(inputs.at(-1)!) }]);
      }
      return inputs.length
        ? history({ ...emptyThread, messages: completedThread(inputs[0]).messages.slice(0, 1) },
          [{ requestId: inputs[0].requestId, status: 'FAILED', error: 'REQUEST_INTERRUPTED' }])
        : history();
    }));
    render(view());
    submit();
    await screen.findByText('上次答复未完成，请重新发送问题。');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('可以先观察共同特征，再按特征分类。');
    expect(inputs[1].requestId).not.toBe(inputs[0].requestId);
  });

  it('retries a context conflict with a fresh id and the current teaching position', async () => {
    const inputs: LectureChatInput[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return history();
      inputs.push(JSON.parse(init.body as string) as LectureChatInput);
      return inputs.length === 1
        ? Response.json({ code: 'LECTURE_CHAT_CONTEXT_CHANGED', message: '课程内容已更新，请回到当前页面重新提问。' }, { status: 409 })
        : stream([{ type: 'done', thread: completedThread(inputs.at(-1)!) }]);
    }));
    const result = render(view());
    submit();
    await screen.findByText('课程内容已更新，请回到当前页面重新提问。');
    result.rerender(view(undefined, { activeActionIndex: 1, mediaTimeMs: 300 }));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('可以先观察共同特征，再按特征分类。');
    expect(inputs[1]).toMatchObject({ actionIndex: 1, mediaTimeMs: 300 });
    expect(inputs[1].requestId).not.toBe(inputs[0].requestId);
  });

  it('allows replacing a confirmed failed question by editing it', async () => {
    const inputs: LectureChatInput[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return history();
      inputs.push(JSON.parse(init.body as string) as LectureChatInput);
      return inputs.length === 1
        ? stream([{ type: 'error', error: 'LECTURE_CHAT_GENERATION_FAILED', message: '答复未完成，请重新发送问题。' }])
        : stream([{ type: 'done', thread: completedThread(inputs.at(-1)!) }]);
    }));
    render(view());
    submit();
    await screen.findByText('答复未完成，请重新发送问题。');
    submit('能否用教材中的例子解释？');
    await screen.findByText('可以先观察共同特征，再按特征分类。');
    expect(inputs[1].message).toBe('能否用教材中的例子解释？');
    expect(inputs[1].requestId).not.toBe(inputs[0].requestId);
  });

  it('sends a follow-up in the same page thread with a new request id', async () => {
    const inputs: LectureChatInput[] = [];
    let previous: LectureChatThread = emptyThread;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return history();
      inputs.push(JSON.parse(init.body as string) as LectureChatInput);
      const next = completedThread(inputs.at(-1)!, inputs.length === 1 ? '第一条教材解释。' : '第二条针对追问的解释。');
      next.messages = [...previous.messages, ...next.messages.map((message) => ({ ...message, id: `${message.id}-${inputs.length}` }))];
      previous = next;
      return stream([{ type: 'done', thread: next }]);
    }));
    render(view());
    submit();
    await screen.findByText('第一条教材解释。');
    submit('那为什么要这样？');
    await screen.findByText('第二条针对追问的解释。');
    expect(inputs[1].requestId).not.toBe(inputs[0].requestId);
    expect(inputs[1]).toMatchObject({ ...page, message: '那为什么要这样？' });
    expect(screen.getByText('第一条教材解释。')).toBeInTheDocument();
    expect(screen.getByText('为什么这样分类？')).toBeInTheDocument();
  });

  it('allows retrying a history failure and explains read-only history', async () => {
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      reads += 1;
      return reads === 1 ? Response.json({ message: '读取问答暂时失败。' }, { status: 503 })
        : Response.json({ thread: completedThread({ ...page, message: '旧问题', requestId: 'old-request', actionIndex: 0 }),
          requests: [], writable: false });
    }));
    render(view());
    await screen.findByText('读取问答暂时失败。');
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('当前课堂暂不可提问，已有问答仍可回看。');
    expect(screen.getByRole('textbox', { name: '随课提问' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '本页问答 · 1' }));
    expect(screen.getByText('可以先观察共同特征，再按特征分类。')).toBeInTheDocument();
  });

  it('recovers a 202 response through history without sending another model request', async () => {
    let input: LectureChatInput | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        input = JSON.parse(init.body as string) as LectureChatInput;
        return new Response(null, { status: 202 });
      }
      return input ? history(completedThread(input), [{ requestId: input.requestId, status: 'COMPLETED' }]) : history();
    });
    vi.stubGlobal('fetch', fetchMock);
    render(view());
    submit();
    await screen.findByText('可以先观察共同特征，再按特征分类。');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('restores a pending question after refresh while leaving recovered history collapsed', async () => {
    const input = { ...page, message: '这里是什么意思？', actionIndex: 3, requestId: 'pending-request' };
    sessionStorage.setItem('openpbl:lecture-chat:student-one:course:room:page-one', JSON.stringify({
      draft: '', position: { actionIndex: 3 }, pending: { input, terminal: false },
    }));
    let reads = 0;
    const fetchMock = vi.fn(async () => {
      reads += 1;
      return reads === 1
        ? history({ ...emptyThread, messages: completedThread(input).messages.slice(0, 1) }, [{ requestId: input.requestId, status: 'RUNNING' }])
        : history(completedThread(input), [{ requestId: input.requestId, status: 'COMPLETED' }]);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(view());
    await screen.findByRole('button', { name: '本页问答 · 1' });
    await waitFor(() => expect(sessionStorage.getItem('openpbl:lecture-chat:student-one:course:room:page-one')).toBeNull());
    expect(screen.queryByRole('log')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: '本页问答 · 1' }));
    expect(screen.getByText('可以先观察共同特征，再按特征分类。')).toBeInTheDocument();
  });

  it('keeps drafts and late responses on their original page', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let input: LectureChatInput | undefined;
    const encoder = new TextEncoder();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return history();
      input = JSON.parse(init.body as string) as LectureChatInput;
      return new Response(new ReadableStream({ start(value) { controller = value; } }));
    }));
    const result = render(view());
    fireEvent.change(screen.getByRole('textbox', { name: '随课提问' }), { target: { value: '第一页草稿' } });
    stage.scene = slide('page-two');
    result.rerender(view());
    expect(screen.getByRole('textbox', { name: '随课提问' })).toHaveValue('');
    stage.scene = slide();
    result.rerender(view());
    expect(screen.getByRole('textbox', { name: '随课提问' })).toHaveValue('第一页草稿');
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
    await waitFor(() => expect(controller).toBeDefined());
    stage.scene = slide('page-two');
    result.rerender(view());
    await act(async () => {
      controller!.enqueue(encoder.encode(`${JSON.stringify({ type: 'done', thread: completedThread(input!, '第一页的晚到回答') })}\n`));
      controller!.close();
    });
    expect(screen.queryByText('第一页的晚到回答')).toBeNull();
    expect(screen.queryByRole('log')).toBeNull();
    expect(screen.getByRole('textbox', { name: '随课提问' })).toHaveValue('');
  });

  it('keeps private drafts and pending requests separate when the student identity changes', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? stream([{ type: 'delta', text: '学生一尚未完成的回答' }]) : history());
    vi.stubGlobal('fetch', fetchMock);
    // Keys predating identity isolation are deliberately never migrated into a student's scope.
    sessionStorage.setItem('openpbl:lecture-chat:course:room:page-one', JSON.stringify({ draft: '未隔离的旧草稿' }));
    const result = render(view());
    expect(screen.getByRole('textbox', { name: '随课提问' })).toHaveValue('');
    fireEvent.change(screen.getByRole('textbox', { name: '随课提问' }), { target: { value: '学生一私有草稿' } });
    result.rerender(view(undefined, {}, true, 'student-two'));
    expect(screen.getByRole('textbox', { name: '随课提问' })).toHaveValue('');
    expect(screen.queryByRole('button', { name: /本页问答/ })).toBeNull();
    result.rerender(view());
    expect(screen.getByRole('textbox', { name: '随课提问' })).toHaveValue('学生一私有草稿');
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
    await screen.findByText('答复连接已中断，点击重试查看或恢复这次提问。');
    expect(sessionStorage.getItem('openpbl:lecture-chat:student-one:course:room:page-one')).toContain('requestId');
    result.rerender(view(undefined, {}, true, 'student-two'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByText('学生一私有草稿')).toBeNull();
    expect(screen.queryByText('学生一尚未完成的回答')).toBeNull();
    expect(screen.queryByRole('button', { name: /本页问答/ })).toBeNull();
    expect(screen.getByRole('textbox', { name: '随课提问' })).toHaveValue('');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('renders textbook math and rejects raw model HTML', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? stream([{ type: 'done', thread: completedThread(JSON.parse(init.body as string) as LectureChatInput,
        '**平方项**为 $x^2$。\n\n<script>alert(1)</script>\n\n<img src="https://example.invalid/pixel" />') }]) : history()));
    render(view());
    submit();
    await screen.findByText('平方项');
    expect(document.querySelector('.katex')).not.toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('normalizes the idle playback position before submission', async () => {
    let input: LectureChatInput | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return history();
      input = JSON.parse(init.body as string) as LectureChatInput;
      return stream([{ type: 'done', thread: completedThread(input) }]);
    }));
    render(view(undefined, { activeActionIndex: -1, mediaTimeMs: 125.4 }));
    submit();
    await screen.findByText('可以先观察共同特征，再按特征分类。');
    expect(input).toMatchObject({ actionIndex: 0, mediaTimeMs: 125 });
  });

  it('is absent outside the student scope and on quiz or teacher pages', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = render(view(undefined, {}, false));
    expect(screen.queryByRole('textbox')).toBeNull();
    stage.scene = { ...slide(), audience: 'teacher' };
    result.rerender(view());
    expect(screen.queryByRole('textbox')).toBeNull();
    stage.scene = { id: 'quiz', stageId: 'room', title: '小测', order: 1, type: 'quiz', content: { type: 'quiz', questions: [] } };
    result.rerender(view());
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
