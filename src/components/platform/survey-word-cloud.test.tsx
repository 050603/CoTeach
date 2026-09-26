import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SurveyWordCloud } from './survey-word-cloud';
const mocks = vi.hoisted(() => ({ layout: vi.fn() }));

vi.mock('@visx/wordcloud', () => ({
  useWordcloud: mocks.layout,
}));
beforeEach(() => { mocks.layout.mockReset(); mocks.layout.mockReturnValue([]); });

const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
  else Reflect.deleteProperty(document, 'fonts');
});

function measure(width = 1000, height = 500) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {} });
}

it('renders every term supplied by the analytics API', () => {
  measure();
  mocks.layout.mockImplementation(({ words }) => words);
  const terms = Array.from({ length: 20 }, (_, index) => ({ label: `词条${index}`, value: 20 - index }));
  render(<SurveyWordCloud terms={terms} onSelect={vi.fn()} />);
  expect(screen.getAllByRole('button', { name: /人提及/ })).toHaveLength(20);
  expect(screen.getByRole('button', { name: '词条0，20 人提及' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '词条12，8 人提及' })).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: '查找关键词' })).not.toBeInTheDocument();
});

it('exposes complete readable labels if collision layout keeps dropping words', async () => {
  measure(300, 180);
  mocks.layout.mockImplementation(({ words }) => words.slice(0, 1));
  const onSelect = vi.fn();
  render(<SurveyWordCloud terms={[{ label: '机器学习', value: 1 }, { label: '教育公平', value: 1 }]} onSelect={onSelect} />);
  expect(await screen.findByLabelText('完整关键词列表')).toBeInTheDocument();
  const missing = screen.getByRole('button', { name: '教育公平，1 人提及' });
  expect(Number.parseFloat(missing.style.fontSize)).toBeGreaterThanOrEqual(12);
  fireEvent.click(missing);
  expect(onSelect).toHaveBeenCalledWith({ label: '教育公平', value: 1 });
});

it.each([
  ['processing', '正在提取回答关键词'],
  ['unavailable', '关键词分析暂时不可用'],
  ['ready', '暂无可提取的关键词'],
] as const)('distinguishes %s analysis from missing student answers', (status, message) => {
  render(<SurveyWordCloud terms={[]} status={status} hasResponses onSelect={vi.fn()} />);
  expect(screen.getByText(message)).toBeInTheDocument();
  expect(screen.queryByText('等待学生写下更多想法')).not.toBeInTheDocument();
});

it('keeps existing keywords without rendering a cloud-top status message', () => {
  render(<SurveyWordCloud terms={[{ label: '人工智能', value: 2 }]} status="processing" analyzedCount={2} responseCount={3} hasResponses onSelect={vi.fn()} />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.queryByText(/正在分析新增回答|已分析|字号表示|个关键词/)).not.toBeInTheDocument();
});

it('does not render any cloud-top hint for normal or all-singleton terms', () => {
  const { rerender } = render(<SurveyWordCloud terms={[{ label: '团队协作', value: 3 }, { label: '实践', value: 1 }]} status="ready" onSelect={vi.fn()} />);
  expect(screen.queryByText('字号代表不同学生的提及人数')).not.toBeInTheDocument();
  rerender(<SurveyWordCloud terms={[{ label: '团队协作', value: 1 }, { label: '实践', value: 1 }]} status="ready" onSelect={vi.fn()} />);
  expect(screen.queryByText('当前观点较分散 · 各词条均为 1 人提及')).not.toBeInTheDocument();
});

it('renders verified fallback evidence as a stable usable cloud', () => {
  render(<SurveyWordCloud terms={[{ label: '机器人', value: 1 }, { label: '编程', value: 2 }]} status="ready" onSelect={vi.fn()} />);
  expect(screen.queryByText('AI 同义归并暂未完成 · 当前展示已验证原词')).not.toBeInTheDocument();
  expect(screen.queryByText('关键词分析暂时不可用')).not.toBeInTheDocument();
});

it('animates the cloud surface and reveals words with a capped stagger', () => {
  measure();
  mocks.layout.mockImplementation(({ words }) => words);
  const terms = Array.from({ length: 25 }, (_, index) => ({ label: `概念${index}`, value: 25 - index }));
  const { container } = render(<SurveyWordCloud terms={terms} onSelect={vi.fn()} />);
  expect(container.querySelector('.survey-word-cloud')).toHaveClass('survey-word-cloud-enter');
  const animatedWords = [...container.querySelectorAll<SVGGElement>('.survey-cloud-word-enter')];
  expect(animatedWords).toHaveLength(25);
  expect(animatedWords[0].style.getPropertyValue('--survey-word-delay')).toBe('0ms');
  expect(animatedWords[1].style.getPropertyValue('--survey-word-delay')).toBe('28ms');
  expect(animatedWords[11].style.getPropertyValue('--survey-word-delay')).toBe('308ms');
  expect(animatedWords[24].style.getPropertyValue('--survey-word-delay')).toBe('620ms');
});

it('skips collision layout and uses the complete readable list when the cloud would be too dense', () => {
  measure(320, 180);
  const terms = Array.from({ length: 200 }, (_, index) => ({ label: `密集词条${index}`, value: 1 }));
  render(<SurveyWordCloud terms={terms} onSelect={vi.fn()} />);
  expect(screen.getByLabelText('完整关键词列表')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /人提及/ })).toHaveLength(200);
  expect(mocks.layout).toHaveBeenCalledWith(expect.objectContaining({ words: [] }));
});

it('fits the measured container when a short projection window is resized', () => {
  let width = 240;
  let height = 179;
  let resized: () => void = () => {};
  const disconnect = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {} }));
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const { unmount } = render(<SurveyWordCloud terms={[{ label: '团队合作', value: 3 }]} onSelect={vi.fn()} large />);
  expect(screen.getByLabelText('词云画布')).toHaveAttribute('width', '240');
  expect(screen.getByLabelText('词云画布')).toHaveAttribute('height', '179');
  act(() => { width = 640; height = 400; resized(); });
  expect(screen.getByLabelText('词云画布')).toHaveAttribute('width', '640');
  expect(screen.getByLabelText('词云画布')).toHaveAttribute('height', '400');
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});

it('keeps every keyword selectable while a font request is stalled, then renders the cloud', async () => {
  measure();
  let resolveFont!: () => void;
  const fonts = { load: vi.fn(() => new Promise<void>((resolve) => { resolveFont = resolve; })) };
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  mocks.layout.mockImplementation(({ words }) => words);
  const onSelect = vi.fn();
  render(<SurveyWordCloud terms={[{ label: '字体尚未加载', value: 3 }]} onSelect={onSelect} />);
  expect(screen.getByLabelText('完整关键词列表')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '字体尚未加载，3 人提及' }));
  expect(onSelect).toHaveBeenCalledWith({ label: '字体尚未加载', value: 3 });
  await act(async () => resolveFont());
  expect(screen.getByLabelText('词云画布')).toBeInTheDocument();
  expect(screen.queryByLabelText('完整关键词列表')).not.toBeInTheDocument();
});
