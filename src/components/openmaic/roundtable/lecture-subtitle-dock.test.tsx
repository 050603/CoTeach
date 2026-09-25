import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeachingKnowledgeGraphProvider } from '@/components/openmaic-bridge/knowledge-graph-context';
import {
  buildSubtitleLines,
  LectureSubtitleDock,
  mergeFragmentedLectureCues,
  resolveActiveCueIndex,
  resolveActiveSubtitleLineIndex,
  splitSubtitleText,
  scrollSubtitleIntoView,
} from './lecture-subtitle-dock';

const cues = [
  { actionIndex: 0, text: '第一句' },
  { actionIndex: 2, text: '第二句' },
  { actionIndex: 4, text: '第三句' },
];

describe('resolveActiveCueIndex', () => {
  it('uses the playback action index as the authoritative TTS cue', () => {
    expect(resolveActiveCueIndex(cues, 2, '第一句')).toBe(1);
  });

  it('falls back to exact text for an older playback callback', () => {
    expect(resolveActiveCueIndex(cues, -1, '第三句')).toBe(2);
  });

  it('starts at the first cue before playback begins', () => {
    expect(resolveActiveCueIndex(cues, -1, '')).toBe(0);
  });
});

describe('long subtitle paging', () => {
  it('groups legacy comma fragments while retaining their original audio indexes', () => {
    const merged = mergeFragmentedLectureCues([
      { actionIndex: 1, text: '计算机视觉的基本原理，' },
      { actionIndex: 2, text: '就是让计算机看懂图像或视频，' },
      { actionIndex: 3, text: '包括识别物体、场景和动作。' },
      { actionIndex: 4, text: '这是核心目标。' },
    ]);
    expect(merged).toEqual([
      {
        actionIndex: 1,
        actionIndexes: [1, 2, 3],
        text: '计算机视觉的基本原理，就是让计算机看懂图像或视频，包括识别物体、场景和动作。',
      },
      { actionIndex: 4, actionIndexes: [4], text: '这是核心目标。' },
    ]);
    expect(resolveActiveCueIndex(merged, 2, '就是让计算机看懂图像或视频，')).toBe(0);
  });

  it('scrolls only the subtitle container instead of a page ancestor', () => {
    const scrollTo = vi.fn();
    const container = { clientHeight: 120, scrollHeight: 400, scrollTo } as unknown as HTMLElement;
    const active = { offsetTop: 240, offsetHeight: 24 } as unknown as HTMLElement;

    scrollSubtitleIntoView(container, active);

    expect(scrollTo).toHaveBeenCalledWith({ top: 192, behavior: 'smooth' });
  });

  it('clamps the centered subtitle position to the scrollable range', () => {
    const scrollTo = vi.fn();
    const container = { clientHeight: 120, scrollHeight: 300, scrollTo } as unknown as HTMLElement;
    const active = { offsetTop: 280, offsetHeight: 40 } as unknown as HTMLElement;

    scrollSubtitleIntoView(container, active);

    expect(scrollTo).toHaveBeenCalledWith({ top: 180, behavior: 'smooth' });
  });

  it('keeps a complete semantic sentence intact even when it wraps visually', () => {
    const text = '这是一个较长的讲解段落，需要跟随语音自动翻阅，并让正在朗读的内容始终清楚可见。';
    const lines = splitSubtitleText(text);

    expect(lines).toEqual([text]);
    expect(lines.join('')).toBe(text);
  });

  it('starts a new display unit only after sentence-ending punctuation', () => {
    expect(splitSubtitleText('第一句很长，逗号不会拆分；分号会拆分。第二句呢？最后一句！')).toEqual([
      '第一句很长，逗号不会拆分；',
      '分号会拆分。',
      '第二句呢？',
      '最后一句！',
    ]);
    expect(splitSubtitleText('Version 1.0 remains together. Next sentence.')).toEqual([
      'Version 1.0 remains together.',
      'Next sentence.',
    ]);
  });

  it('hides contradictory period-semicolon pairs from legacy subtitles', () => {
    expect(splitSubtitleText('先观察共同特征。；再比较关键差异；。')).toEqual([
      '先观察共同特征；',
      '再比较关键差异。',
    ]);
  });

  it('maps speech progress to the matching line including the final line', () => {
    const lines = buildSubtitleLines([{
      actionIndex: 3,
      text: '这是第一部分需要理解的内容。接着进入第二部分的具体应用。最后用一个实例完成本页总结。',
    }]);

    expect(resolveActiveSubtitleLineIndex(lines, 0, 0)).toBe(0);
    expect(resolveActiveSubtitleLineIndex(lines, 0, 1)).toBe(lines.length - 1);
    expect(resolveActiveSubtitleLineIndex(lines, 0, 0.8)).toBeGreaterThan(0);
  });

  it('keeps progress scoped to the active speech cue', () => {
    const lines = buildSubtitleLines([
      { actionIndex: 0, text: '前一段。' },
      { actionIndex: 2, text: '当前段第一句，当前段第二句。' },
    ]);
    const activeIndex = resolveActiveSubtitleLineIndex(lines, 1, 0);

    expect(lines[activeIndex]?.actionIndex).toBe(2);
  });

  it('uses forced-alignment time ranges instead of character proportions', () => {
    const lines = buildSubtitleLines([{
      actionIndex: 3,
      text: '短句。第二句明显更长。',
      audioDurationMs: 5000,
      alignment: {
        status: 'aligned',
        spans: [
          { text: '短句。', startChar: 0, endChar: 3, startMs: 0, endMs: 3500 },
          { text: '第二句明显更长。', startChar: 3, endChar: 11, startMs: 3500, endMs: 5000 },
        ],
      },
    }]);

    expect(resolveActiveSubtitleLineIndex(lines, 0, 0.6)).toBe(0);
    expect(resolveActiveSubtitleLineIndex(lines, 0, 0.8)).toBe(1);
    expect(lines[1]).toMatchObject({ startMs: 3500, endMs: 5000, durationMs: 5000 });
  });

  it('keeps the preceding subtitle active through an alignment gap', () => {
    const lines = buildSubtitleLines([{
      actionIndex: 3,
      text: '第一句。第二句。',
      audioDurationMs: 5000,
      alignment: {
        status: 'aligned',
        spans: [
          { text: '第一句。', startChar: 0, endChar: 4, startMs: 0, endMs: 1800 },
          { text: '第二句。', startChar: 4, endChar: 8, startMs: 3000, endMs: 5000 },
        ],
      },
    }]);

    expect(resolveActiveSubtitleLineIndex(lines, 0, 0.5)).toBe(0);
  });
});

describe('teaching rail layout', () => {
  it('keeps the lower playback control available during automatic page advance', () => {
    const onPlayPause = vi.fn();
    const props = {
      activeActionIndex: 0,
      autoPlay: true,
      canGoNext: true,
      canGoNextCue: false,
      canGoPrevious: false,
      canGoPreviousCue: false,
      cues: [{ actionIndex: 0, text: '本页内容。' }],
      currentText: '本页内容。',
      engineMode: 'idle' as const,
      muted: false,
      onCycleSpeed: vi.fn(),
      onPlayPause,
      onToggleAutoPlay: vi.fn(),
      onToggleMute: vi.fn(),
      playbackCompleted: true,
      playbackSpeed: 1,
      sceneIndex: 0,
      scenesCount: 2,
      teacherAvatar: '/teacher.webp',
      teacherName: '知知',
    };
    const { rerender } = render(
      <TeachingKnowledgeGraphProvider graph={undefined} points={[]}>
        <LectureSubtitleDock {...props} autoAdvancePending />
      </TeachingKnowledgeGraphProvider>,
    );

    expect(screen.getByText('即将播放下一页')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续讲解' })).toBeInTheDocument();
    expect(onPlayPause).not.toHaveBeenCalled();

    rerender(
      <TeachingKnowledgeGraphProvider graph={undefined} points={[]}>
        <LectureSubtitleDock {...props} autoAdvancePending={false} engineMode="paused" playbackCompleted={false} />
      </TeachingKnowledgeGraphProvider>,
    );
    expect(screen.getByText('讲解已暂停')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续讲解' })).toBeInTheDocument();
  });

  it('moves the subtitle viewport when speech advances to the next sentence', () => {
    const sharedProps = {
      activeActionIndex: 0,
      autoPlay: true,
      canGoNext: false,
      canGoNextCue: false,
      canGoPrevious: false,
      canGoPreviousCue: false,
      cues: [{ actionIndex: 0, text: '第一句话。第二句话。第三句话。' }],
      currentText: '第一句话。第二句话。第三句话。',
      engineMode: 'playing' as const,
      muted: false,
      onCycleSpeed: vi.fn(),
      onToggleAutoPlay: vi.fn(),
      onToggleMute: vi.fn(),
      playbackSpeed: 1,
      sceneIndex: 0,
      scenesCount: 1,
      teacherAvatar: '/teacher.webp',
      teacherName: '知知',
    };
    const { rerender } = render(
      <TeachingKnowledgeGraphProvider graph={undefined} points={[]}>
        <LectureSubtitleDock {...sharedProps} speechProgress={0} />
      </TeachingKnowledgeGraphProvider>,
    );
    const viewport = screen.getByLabelText('讲解字幕，可滚动浏览或拖动查看');
    const secondLine = screen.getByRole('button', { name: '从此处重新播放：第二句话。' });
    const scrollTo = vi.fn();
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 120 },
      scrollHeight: { configurable: true, value: 400 },
      scrollTo: { configurable: true, value: scrollTo },
    });
    Object.defineProperties(secondLine, {
      offsetHeight: { configurable: true, value: 80 },
      offsetTop: { configurable: true, value: 160 },
    });

    rerender(
      <TeachingKnowledgeGraphProvider graph={undefined} points={[]}>
        <LectureSubtitleDock {...sharedProps} speechProgress={0.5} />
      </TeachingKnowledgeGraphProvider>,
    );

    expect(scrollTo).toHaveBeenCalledWith({ top: 140, behavior: 'smooth' });
  });

  it('shares the available height between subtitles and the knowledge graph by ratio', () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(
      <TeachingKnowledgeGraphProvider
        graph={{
          nodes: [{ id: 'point-1', label: '核心概念', description: '核心概念说明', level: 'core' }],
          edges: [],
        }}
        points={[]}
      >
        <LectureSubtitleDock
          activeActionIndex={0}
          autoPlay
          canGoNext
          canGoNextCue={false}
          canGoPrevious={false}
          canGoPreviousCue={false}
          cues={[{ actionIndex: 0, text: '当前字幕。' }]}
          currentText="当前字幕。"
          engineMode="paused"
          muted={false}
          onCycleSpeed={vi.fn()}
          onToggleAutoPlay={vi.fn()}
          onToggleMute={vi.fn()}
          playbackSpeed={1}
          sceneIndex={0}
          scenesCount={2}
          teacherAvatar="/teacher.webp"
          teacherName="知知"
        />
      </TeachingKnowledgeGraphProvider>,
    );

    const content = document.querySelector('[data-teaching-rail-content]') as HTMLElement;
    expect(content.className).toContain(
      'xl:grid-rows-[minmax(0,3fr)_minmax(0,2fr)]',
    );
    expect(screen.getByLabelText('课程思维导图缩略图').className).toContain('h-full');
    expect(screen.getByLabelText('课程思维导图缩略图').className).not.toContain('h-[176px]');
    const viewportFrame = document.querySelector('[data-subtitle-viewport-frame]') as HTMLElement;
    expect(viewportFrame.className).toContain('overflow-hidden');
    const subtitleViewport = screen.getByLabelText('讲解字幕，可滚动浏览或拖动查看');
    expect(subtitleViewport.className).toContain('absolute');
    expect(subtitleViewport.className).toContain('scrollbar-hide');
    expect(subtitleViewport.className).not.toContain('[scrollbar-width:thin]');
    const activeSubtitle = screen.getByRole('button', { name: '从此处重新播放：当前字幕。' });
    expect(activeSubtitle.className).not.toContain('bg-teal');
    expect(activeSubtitle.className).not.toContain('rounded-lg');
    const controls = document.querySelector('[data-subtitle-controls]') as HTMLElement;
    expect(controls.className).toContain('shrink-0');
    expect(controls.className).toContain('z-20');
    expect(controls.parentElement?.className).not.toContain('px-5');

    fireEvent.click(screen.getByRole('button', { name: '完整浏览课程思维导图' }));
    expect(screen.getByRole('dialog', { name: '课程思维导图' })).toBeInTheDocument();
  });

  it('keeps context hidden during auto-follow and reveals it for manual browsing', () => {
    render(
      <TeachingKnowledgeGraphProvider graph={undefined} points={[]}>
        <LectureSubtitleDock
          activeActionIndex={0}
          autoPlay
          canGoNext={false}
          canGoNextCue
          canGoPrevious={false}
          canGoPreviousCue={false}
          cues={[
            { actionIndex: 0, text: '当前字幕。' },
            { actionIndex: 1, text: '下一条字幕。' },
          ]}
          currentText="当前字幕。"
          engineMode="playing"
          muted={false}
          onCycleSpeed={vi.fn()}
          onToggleAutoPlay={vi.fn()}
          onToggleMute={vi.fn()}
          playbackSpeed={1}
          sceneIndex={0}
          scenesCount={1}
          teacherAvatar="/teacher.webp"
          teacherName="知知"
        />
      </TeachingKnowledgeGraphProvider>,
    );

    const viewport = screen.getByLabelText('讲解字幕，可滚动浏览或拖动查看');
    const nextLine = screen.getByRole('button', { name: '从此处重新播放：下一条字幕。' });
    expect(nextLine.className).toContain('opacity-0');
    fireEvent.wheel(viewport);
    expect(nextLine.className).toContain('opacity-60');
  });

  it('keeps a mouse click targeted at the subtitle so it can seek playback', () => {
    const onCueSelect = vi.fn().mockReturnValue(true);
    render(
      <TeachingKnowledgeGraphProvider graph={undefined} points={[]}>
        <LectureSubtitleDock
          activeActionIndex={0}
          autoPlay
          canGoNext={false}
          canGoNextCue
          canGoPrevious={false}
          canGoPreviousCue={false}
          cues={[
            { actionIndex: 0, text: '当前字幕。' },
            { actionIndex: 3, text: '下一段字幕。' },
          ]}
          currentText="当前字幕。"
          engineMode="paused"
          muted={false}
          onCueSelect={onCueSelect}
          onCycleSpeed={vi.fn()}
          onToggleAutoPlay={vi.fn()}
          onToggleMute={vi.fn()}
          playbackSpeed={1}
          sceneIndex={0}
          scenesCount={1}
          teacherAvatar="/teacher.webp"
          teacherName="知知"
        />
      </TeachingKnowledgeGraphProvider>,
    );

    const viewport = screen.getByLabelText('讲解字幕，可滚动浏览或拖动查看');
    const target = screen.getByRole('button', { name: '从此处重新播放：下一段字幕。' });
    const setPointerCapture = vi.fn();
    Object.defineProperty(viewport, 'setPointerCapture', {
      configurable: true,
      value: setPointerCapture,
    });

    fireEvent.wheel(viewport);
    fireEvent.pointerDown(target, {
      button: 0,
      clientY: 80,
      pointerId: 7,
      pointerType: 'mouse',
    });

    expect(setPointerCapture).not.toHaveBeenCalled();
    fireEvent.click(target);
    expect(onCueSelect).toHaveBeenCalledWith(3, 0);
  });

  it('seeks an aligned subtitle sentence to its audio timestamp', () => {
    const onCueSelect = vi.fn().mockReturnValue(true);
    render(
      <TeachingKnowledgeGraphProvider graph={undefined} points={[]}>
        <LectureSubtitleDock
          activeActionIndex={0}
          autoPlay
          canGoNext={false}
          canGoNextCue={false}
          canGoPrevious={false}
          canGoPreviousCue={false}
          cues={[{
            actionIndex: 0,
            text: '第一句。第二句。',
            audioDurationMs: 4000,
            alignment: {
              status: 'aligned',
              spans: [
                { text: '第一句。', startChar: 0, endChar: 4, startMs: 0, endMs: 2500 },
                { text: '第二句。', startChar: 4, endChar: 8, startMs: 2500, endMs: 4000 },
              ],
            },
          }]}
          currentText="第一句。第二句。"
          engineMode="paused"
          muted={false}
          onCueSelect={onCueSelect}
          onCycleSpeed={vi.fn()}
          onToggleAutoPlay={vi.fn()}
          onToggleMute={vi.fn()}
          playbackSpeed={1}
          sceneIndex={0}
          scenesCount={1}
          teacherAvatar="/teacher.webp"
          teacherName="知知"
        />
      </TeachingKnowledgeGraphProvider>,
    );

    fireEvent.wheel(screen.getByLabelText('讲解字幕，可滚动浏览或拖动查看'));
    fireEvent.click(screen.getByRole('button', { name: '从此处重新播放：第二句。' }));
    expect(onCueSelect).toHaveBeenCalledWith(0, 0.625);
  });
});
