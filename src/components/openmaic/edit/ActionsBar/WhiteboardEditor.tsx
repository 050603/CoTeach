'use client';

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ImagePlus,
  Pause,
  Play,
  Plus,
  Redo2,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Action } from '@openmaic/lib/types/action';
import { useStageStore } from '@openmaic/lib/store/stage';
import { cn } from '@openmaic/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@openmaic/components/ui/dialog';
import { clientUUID } from '@/lib/uuid';
import { auditWhiteboardLayout } from '@openmaic/lib/whiteboard/layout';
import { auditWhiteboardContent } from '@openmaic/lib/whiteboard/quality';
import { normalizeWhiteboardActionLayout } from '@openmaic/lib/generation/whiteboard-layout';
import { WhiteboardPreview } from './WhiteboardPreview';
import { createWhiteboardTemplate, whiteboardTemplates, type WhiteboardTemplate } from './whiteboard-templates';
import {
  boardChartTypes,
  boardStepLabel,
  boardStepSummary,
  chartTypeIssue,
  deleteBoardStep,
  editBoardStep,
  hasEditableChartData,
  makeBoardStep,
  placeBoardStep,
  replaceWhiteboardSteps,
  resizeBoardChartData,
  visibleBoardDraws,
  whiteboardAIPrompt,
  whiteboardBlocks,
  type BoardStepType,
  type BoardChart,
} from './whiteboard-edit';

const button =
  'inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-[10px] px-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet-500 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100';
const input =
  'min-h-11 w-full rounded-[10px] border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 transition-colors placeholder:text-zinc-400 focus-visible:border-violet-400 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus-visible:border-violet-500';
const stepTypes: Array<[BoardStepType, string]> = [
  ['speech', 'AI 讲解'],
  ['wb_draw_text', '板书文字'],
  ['wb_draw_table', '表格'],
  ['wb_draw_image', '图片'],
  ['wb_draw_shape', '图形'],
  ['wb_draw_chart', '图表'],
  ['wb_draw_line', '连线与箭头'],
  ['wb_draw_latex', '公式'],
  ['wb_draw_code', '代码'],
  ['wb_clear', '清空白板'],
];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
      <span>{label}</span>
      {children}
    </label>
  );
}

function ChartValueInput({ value, onValue, ...props }: Omit<ComponentProps<'input'>, 'value' | 'onChange'> & { value: number; onValue: (value: number) => void }) {
  const [draft, setDraft] = useState({ source: value, text: String(value) });
  if (draft.source !== value) setDraft({ source: value, text: String(value) });
  return <input {...props} type="number" step="any" value={draft.text} onChange={(event) => {
    setDraft({ source: value, text: event.target.value });
    if (Number.isFinite(event.target.valueAsNumber)) onValue(event.target.valueAsNumber);
  }} onBlur={() => setDraft({ source: value, text: String(value) })} />;
}

function ChartFields({ action, patch }: { action: BoardChart; patch: (values: Record<string, unknown>) => void }) {
  const { data } = action;
  const scatter = action.chartType === 'scatter';
  const singleSeries = action.chartType === 'pie' || action.chartType === 'ring';
  if (!hasEditableChartData(action)) return (
    <div className="space-y-2 text-xs leading-5 text-zinc-600 dark:text-zinc-400">
      <p>图表数据的行列不完整。修复会补齐名称与缺少的数值，无法识别的数值以 0 填充，可撤销后继续修改。</p>
      <button className={button} onClick={() => patch({ data: resizeBoardChartData({ ...action, chartType: 'column' },
        Math.max(1, data?.labels?.length ?? 0, ...(Array.isArray(data?.series) ? data.series.map((values) => Array.isArray(values) ? values.length : 0) : [])),
        Math.max(1, data?.legends?.length ?? 0, data?.series?.length ?? 0)),
      })}>修复图表行列</button>
    </div>
  );
  return (
    <div className="space-y-3">
      <Field label="图表类型">
        <select className={input} value={action.chartType} onChange={(event) => {
          const type = event.target.value as BoardChart['chartType'];
          const issue = chartTypeIssue(action, type);
          if (issue) toast.info(issue);
          else patch({ chartType: type });
        }}>
          {boardChartTypes.map(([type, label]) => (
            <option key={type} value={type} disabled={Boolean(chartTypeIssue(action, type))}>{label}</option>
          ))}
        </select>
      </Field>
      <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
        {scatter ? '每行是一个点；第一列数值为 X，第二列为 Y，名称用于标识点。'
          : singleSeries ? '饼图和环形图显示一个系列；数值不能为负，至少保留一个正数。'
            : '修改下方数据会同步更新图表。饼图和环形图需要一个系列，散点图需要两个系列，雷达图至少需要三项。'}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">图表数据</caption>
          <thead>
            <tr>
              <th className="p-0.5 font-medium">{scatter ? '点名称' : '数据项'}</th>
              {data.legends.map((legend, series) => (
                <th key={series} className="p-0.5 font-medium">
                  {scatter && <span className="mb-1 block">{series === 0 ? 'X 数值' : 'Y 数值'}</span>}
                  <input className={`${input} min-w-24`} aria-label={`系列 ${series + 1} 名称`} value={legend}
                    onChange={(event) => patch({ data: { ...data, legends: data.legends.map((value, index) => index === series ? event.target.value : value) } })} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.labels.map((label, row) => (
              <tr key={row}>
                <td className="p-0.5">
                  <input className={`${input} min-w-24`} aria-label={`数据项 ${row + 1} 名称`} value={label}
                    onChange={(event) => patch({ data: { ...data, labels: data.labels.map((value, index) => index === row ? event.target.value : value) } })} />
                </td>
                {data.series.map((values, series) => (
                  <td key={series} className="p-0.5">
                    <ChartValueInput className={`${input} min-w-24`} min={singleSeries ? 0 : undefined}
                      aria-label={`数据项 ${row + 1}，${scatter ? series === 0 ? 'X' : 'Y' : `系列 ${series + 1}`} 数值`}
                      value={values[row] ?? 0}
                      onValue={(value) => {
                        if (!Number.isFinite(value) || (singleSeries && value < 0)) return;
                        const next = { ...data, series: data.series.map((items, index) => index === series ? items.map((item, itemRow) => itemRow === row ? value : item) : items) };
                        if (singleSeries && !next.series[0].some((item) => item > 0)) return;
                        patch({ data: next });
                      }} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-1">
        <button className={button} disabled={data.labels.length >= 16} onClick={() => patch({ data: resizeBoardChartData(action, data.labels.length + 1, data.series.length) })}>添加数据项</button>
        <button className={button} disabled={data.labels.length <= (action.chartType === 'radar' ? 3 : 1) || (singleSeries && !data.series[0].slice(0, -1).some((value) => value > 0))} onClick={() => patch({ data: resizeBoardChartData(action, data.labels.length - 1, data.series.length) })}>删除末项</button>
        <button className={button} disabled={scatter || singleSeries || data.series.length >= 6} onClick={() => patch({ data: resizeBoardChartData(action, data.labels.length, data.series.length + 1) })}>添加系列</button>
        <button className={button} disabled={scatter || singleSeries || data.series.length <= 1} onClick={() => patch({ data: resizeBoardChartData(action, data.labels.length, data.series.length - 1) })}>删除末系列</button>
      </div>
    </div>
  );
}

function LineFields({ action, actions, patch }: { action: Extract<Action, { type: 'wb_draw_line' }>; actions: readonly Action[]; patch: (values: Record<string, unknown>) => void }) {
  const targets = visibleBoardDraws(actions).filter((item) => 'x' in item && 'y' in item);
  return (
    <div className="space-y-3">
      <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">绑定后连线跟随内容移动。未绑定或目标缺失时，使用下方坐标。</p>
      {(['start', 'end'] as const).map((endpoint) => {
        const anchor = action[`${endpoint}Anchor`];
        const label = endpoint === 'start' ? '起点' : '终点';
        return (
          <fieldset key={endpoint} className="space-y-2">
            <legend className="text-xs font-medium">{label}</legend>
            <Field label={`${label}绑定`}>
              <select className={input} value={anchor?.elementId ?? ''} onChange={(event) => patch({ [`${endpoint}Anchor`]: event.target.value ? { elementId: event.target.value, side: anchor?.side ?? (endpoint === 'start' ? 'right' : 'left') } : undefined })}>
                <option value="">使用坐标</option>
                {anchor && !targets.some((item) => ('elementId' in item && item.elementId || item.id) === anchor.elementId) && <option value={anchor.elementId}>已缺失的目标（使用坐标）</option>}
                {targets.map((item, index) => <option key={item.id} value={'elementId' in item && item.elementId || item.id}>{index + 1}. {boardStepLabel(item)}：{boardStepSummary(item).slice(0, 24)}</option>)}
              </select>
            </Field>
            {anchor && <Field label={`${label}连接位置`}>
              <select className={input} value={anchor.side} onChange={(event) => patch({ [`${endpoint}Anchor`]: { ...anchor, side: event.target.value } })}>
                <option value="top">上边</option><option value="right">右边</option><option value="bottom">下边</option><option value="left">左边</option><option value="center">中心</option>
              </select>
            </Field>}
            <div className="grid grid-cols-2 gap-3">
              {(['X', 'Y'] as const).map((axis) => (
                <Field key={axis} label={`${label} ${axis} %`}>
                  <input className={input} type="number" min={0} max={100} step="0.1" value={Math.round(action[`${endpoint}${axis}`] / (axis === 'X' ? 1000 : 562.5) * 1000) / 10}
                    onChange={(event) => patch({ [`${endpoint}${axis}`]: Math.max(0, Math.min(100, Number(event.target.value))) / 100 * (axis === 'X' ? 1000 : 562.5) })} />
                </Field>
              ))}
            </div>
          </fieldset>
        );
      })}
      <Field label="箭头方向">
        <select className={input} value={`${action.points?.[0] ?? ''}|${action.points?.[1] ?? ''}`} onChange={(event) => patch({ points: event.target.value.split('|') })}>
          <option value="|">无线头</option><option value="|arrow">指向终点</option><option value="arrow|">指向起点</option><option value="arrow|arrow">双向箭头</option>
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="线条样式"><select className={input} value={action.style ?? 'solid'} onChange={(event) => patch({ style: event.target.value })}><option value="solid">实线</option><option value="dashed">虚线</option></select></Field>
        <Field label="线条粗细"><input className={input} type="number" min={1} max={12} value={action.width ?? 2} onChange={(event) => patch({ width: Math.max(1, Math.min(12, Number(event.target.value))) })} /></Field>
      </div>
      <Field label="线条颜色"><input className={`${input} p-1`} type="color" value={action.color ?? '#333333'} onChange={(event) => patch({ color: event.target.value })} /></Field>
    </div>
  );
}

function StepFields({
  action,
  actions,
  onChange,
}: {
  action: Action;
  actions: readonly Action[];
  onChange: (update: (action: Action) => Action) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadVersion = useRef(0);
  const [uploading, setUploading] = useState(false);
  useEffect(
    () => () => {
      uploadVersion.current++;
    },
    [],
  );
  const patch = (values: Record<string, unknown>) =>
    onChange((current) => {
      const next = { ...current, ...values } as Action;
      if (next.type === 'speech' && current.type === 'speech' && next.text !== current.text) {
        delete next.audioId;
        delete next.audioUrl;
        delete next.speechAlignment;
        next.audioInvalidated = true;
      }
      return next;
    });
  const textField = (label: string, value: string, field: string, rows = 4) => (
    <Field label={label}>
      <textarea
        className={`${input} scroll-my-4 resize-y`}
        rows={rows}
        value={value}
        onChange={(event) => patch({ [field]: event.target.value })}
      />
    </Field>
  );

  async function upload(file: File | undefined) {
    if (!file) return;
    if (
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) ||
      file.size > 5 * 1024 * 1024
    ) {
      toast.error('请选择 5 MB 以内的 PNG、JPEG、WebP 或 GIF 图片');
      return;
    }
    const version = ++uploadVersion.current;
    setUploading(true);
    try {
      // Embedded image bytes travel with the classroom draft and survive reload/fork.
      const src = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('图片读取失败，请重新选择'));
        reader.readAsDataURL(file);
      });
      if (version === uploadVersion.current) patch({ src, title: file.name });
    } catch (error) {
      if (version === uploadVersion.current)
        toast.error(error instanceof Error ? error.message : '图片读取失败');
    } finally {
      if (version === uploadVersion.current) setUploading(false);
    }
  }

  return (
    <div className="space-y-4">
      {action.type === 'speech' && textField('AI 讲解内容', action.text, 'text')}
      {action.type === 'wb_draw_chart' && <ChartFields action={action} patch={patch} />}
      {action.type === 'wb_draw_line' && <LineFields action={action} actions={actions} patch={patch} />}
      {action.type === 'wb_draw_text' && (
        <>
          {textField('板书内容', action.content, 'content')}
          <div className="grid grid-cols-2 gap-3">
            <Field label="字号">
              <input
                className={input}
                type="number"
                min={10}
                max={96}
                value={action.fontSize ?? 18}
                onChange={(event) =>
                  patch({ fontSize: Math.max(10, Math.min(96, Number(event.target.value))) })
                }
              />
            </Field>
            <Field label="文字颜色">
              <input
                className={`${input} p-1`}
                type="color"
                value={action.color ?? '#333333'}
                onChange={(event) => patch({ color: event.target.value })}
              />
            </Field>
          </div>
        </>
      )}
      {action.type === 'wb_draw_table' && (
        <div className="space-y-2">
          <p className="text-xs text-zinc-600 dark:text-zinc-400">表格内容（首行为表头）</p>
          <div className="overflow-x-auto">
            <table className="w-full">
              <tbody>
                {action.data.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c} className="p-0.5">
                        <input
                          aria-label={`第 ${r + 1} 行第 ${c + 1} 列`}
                          className={`${input} min-w-24`}
                          value={cell}
                          onChange={(event) =>
                            patch({
                              data: action.data.map((cells, index) =>
                                index === r
                                  ? cells.map((value, col) =>
                                      col === c ? event.target.value : value,
                                    )
                                  : cells,
                              ),
                            })
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-1">
            <button
              className={button}
              onClick={() =>
                patch({ data: [...action.data, Array(action.data[0]?.length || 2).fill('')] })
              }
              disabled={action.data.length >= 12}
            >
              添加行
            </button>
            <button
              className={button}
              onClick={() => patch({ data: action.data.map((row) => [...row, '']) })}
              disabled={(action.data[0]?.length ?? 0) >= 8}
            >
              添加列
            </button>
            <button
              className={button}
              onClick={() => patch({ data: action.data.slice(0, -1) })}
              disabled={action.data.length <= 1}
            >
              删除末行
            </button>
            <button
              className={button}
              onClick={() => patch({ data: action.data.map((row) => row.slice(0, -1)) })}
              disabled={(action.data[0]?.length ?? 0) <= 1}
            >
              删除末列
            </button>
          </div>
        </div>
      )}
      {action.type === 'wb_draw_image' && (
        <>
          <Field label="图片地址">
            <input
              className={input}
              placeholder="https://… 或上传本地图片"
              value={action.src.startsWith('data:') ? '' : action.src}
              onChange={(event) => patch({ src: event.target.value })}
            />
          </Field>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept="image/png,image/jpeg,image/webp,image/gif"
            aria-label="上传白板图片"
            onChange={(event) => {
              void upload(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <button
            className={`${button} w-full border border-zinc-200 dark:border-zinc-700`}
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            <ImagePlus size={16} />
            {uploading ? '正在读取图片…' : '上传图片'}
          </button>
          {action.src.startsWith('data:') && (
            <p role="status" className="text-xs text-zinc-500 dark:text-zinc-400">
              已添加：{action.title || '本地图片'}
            </p>
          )}
        </>
      )}
      {action.type === 'wb_draw_shape' && (
        <>
          <Field label="图形">
            <select
              className={input}
              value={action.shape}
              onChange={(event) => patch({ shape: event.target.value })}
            >
              <option value="rectangle">矩形</option>
              <option value="circle">圆形</option>
              <option value="triangle">三角形</option>
            </select>
          </Field>
          <Field label="填充颜色">
            <input
              className={`${input} p-1`}
              type="color"
              value={action.fillColor ?? '#5b9bd5'}
              onChange={(event) => patch({ fillColor: event.target.value })}
            />
          </Field>
        </>
      )}
      {action.type === 'wb_draw_latex' && textField('公式（LaTeX）', action.latex, 'latex')}
      {action.type === 'wb_draw_code' && (
        <>
          {textField('代码内容', action.code, 'code', 6)}
          <Field label="代码语言">
            <input
              className={input}
              value={action.language}
              onChange={(event) => patch({ language: event.target.value })}
            />
          </Field>
        </>
      )}
      {action.type === 'wb_clear' && (
        <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          播放到这一步时清空之前的板书，接着呈现后续内容。
        </p>
      )}
      {action.type === 'wb_delete' && (
        <Field label="要擦除的内容 ID">
          <input
            className={input}
            value={action.elementId}
            onChange={(event) => patch({ elementId: event.target.value })}
          />
        </Field>
      )}
      {action.type === 'wb_edit_code' && (
        <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          可调整此步骤的顺序或删除。需要修改其内容时，在下方描述要求交给 AI。
        </p>
      )}
      {'x' in action && 'y' in action && (
        <fieldset className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <legend className="text-xs text-zinc-600 dark:text-zinc-400">位置与大小（占白板的百分比）</legend>
          <div className="grid grid-cols-2 gap-3">
            {(['x', 'y', 'width', 'height'] as const).map((field) => {
              const extent = field === 'y' || field === 'height' ? 562.5 : 1000;
              const value =
                field in action ? (action[field] ?? (field === 'width' ? 400 : 100)) : 0;
              return (
                <Field
                  key={field}
                  label={{ x: '左距 %', y: '上距 %', width: '宽度 %', height: '高度 %' }[field]}
                >
                  <input
                    className={input}
                    type="number"
                    min={field === 'width' || field === 'height' ? 1 : 0}
                    max={100}
                    value={Math.round((value / extent) * 1000) / 10}
                    onChange={(event) =>
                      patch({
                        [field]:
                          (Math.max(
                            field === 'width' || field === 'height' ? 1 : 0,
                            Math.min(100, Number(event.target.value)),
                          ) /
                            100) *
                          extent,
                      })
                    }
                  />
                </Field>
              );
            })}
          </div>
        </fieldset>
      )}
    </div>
  );
}

export function WhiteboardEditor({
  sceneId,
  boardId,
  onClose,
  onEditWithAI,
  aiRunning,
}: {
  sceneId: string;
  boardId: string;
  onClose: () => void;
  onEditWithAI?: (prompt: string) => void;
  aiRunning?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const scene = useStageStore((state) => state.scenes.find((item) => item.id === sceneId));
  const block = whiteboardBlocks(scene?.actions ?? []).find((item) => item.id === boardId);
  const [selectedId, setSelectedId] = useState(
    () => block?.steps.find((step) => step.type !== 'wb_clear')?.id,
  );
  const selected = block?.steps.find((step) => step.id === selectedId) ?? block?.steps.at(-1);
  const [request, setRequest] = useState('');
  const [playing, setPlaying] = useState(false);
  const [past, setPast] = useState<Action[][]>([]);
  const [future, setFuture] = useState<Action[][]>([]);
  const lastWritten = useRef<Action[] | undefined>(block?.steps);
  const selectedIndex = block?.steps.findIndex((step) => step.id === selected?.id) ?? -1;
  const stepCount = block?.steps.length ?? 0;
  const selectedType = selected?.type;
  const selectedText = selected?.type === 'speech' ? selected.text : '';
  const ownedSpeech = useRef<SpeechSynthesisUtterance | null>(null);
  const [notice, setNotice] = useState('');
  const issues = block ? [
    ...auditWhiteboardLayout((scene?.actions ?? []).slice(0, block.end + 1)),
    ...auditWhiteboardContent(block.steps),
  ].filter((issue) => issue.actionIds.some((id) => block.steps.some((step) => step.id === id))) : [];

  useEffect(() => {
    if (!playing) return;
    let timer: ReturnType<typeof setTimeout>;
    const advance = () => {
      const current = whiteboardBlocks(
        useStageStore.getState().getSceneById(sceneId)?.actions ?? [],
      ).find((item) => item.id === boardId);
      const next = current?.steps[selectedIndex + 1];
      if (next) setSelectedId(next.id);
      else setPlaying(false);
    };
    if (
      selectedType === 'speech' &&
      selectedText.trim() &&
      typeof window.speechSynthesis !== 'undefined'
    ) {
      const speech = new SpeechSynthesisUtterance(selectedText);
      speech.lang = 'zh-CN';
      speech.onend = advance;
      speech.onerror = advance;
      ownedSpeech.current = speech;
      window.speechSynthesis.speak(speech);
      timer = setTimeout(advance, Math.max(10000, selectedText.length * 500));
    } else timer = setTimeout(advance, 1400);
    return () => {
      clearTimeout(timer);
      if (ownedSpeech.current) {
        ownedSpeech.current.onend = null;
        ownedSpeech.current.onerror = null;
        window.speechSynthesis?.cancel();
        ownedSpeech.current = null;
      }
    };
  }, [playing, selectedIndex, selectedType, selectedText, sceneId, boardId]);

  function commit(update: (steps: Action[]) => Action[]) {
    const actions = useStageStore.getState().getSceneById(sceneId)?.actions ?? [];
    const current = whiteboardBlocks(actions).find((item) => item.id === boardId);
    if (!current) return;
    const next = update(current.steps);
    if (
      next.length === current.steps.length &&
      next.every((step, index) => step === current.steps[index])
    )
      return;
    setPast((values) => [...values.slice(-49), current.steps]);
    setFuture([]);
    lastWritten.current = next;
    useStageStore
      .getState()
      .updateScene(sceneId, { actions: replaceWhiteboardSteps(actions, boardId, next) });
  }

  function history(direction: 'undo' | 'redo') {
    const entries = direction === 'undo' ? past : future;
    const next = entries.at(-1);
    const actions = useStageStore.getState().getSceneById(sceneId)?.actions ?? [];
    const current = whiteboardBlocks(actions).find((item) => item.id === boardId);
    if (!next || !current) return;
    if (
      current.steps.length !== lastWritten.current?.length ||
      current.steps.some((step, index) => step !== lastWritten.current?.[index])
    ) {
      setPast([]);
      setFuture([]);
      toast.info('白板已由其他编辑更新，已保留最新内容');
      return;
    }
    if (direction === 'undo') {
      setPast(past.slice(0, -1));
      setFuture([...future, current.steps]);
    } else {
      setFuture(future.slice(0, -1));
      setPast([...past, current.steps]);
    }
    lastWritten.current = next;
    useStageStore
      .getState()
      .updateScene(sceneId, { actions: replaceWhiteboardSteps(actions, boardId, next) });
  }

  function add(type: BoardStepType) {
    const id = clientUUID();
    const current = whiteboardBlocks(useStageStore.getState().getSceneById(sceneId)?.actions ?? []).find((item) => item.id === boardId);
    if (!current) return;
    const placed = placeBoardStep(type, id, current.steps);
    commit((steps) => [...steps, placed.action]);
    setNotice(placed.crowded ? '当前页空间有限，已保留已有内容。可调整大小和位置、整理布局，或新建白板页。' : '');
    setSelectedId(id);
    setPlaying(false);
  }

  function newPage() {
    const step = makeBoardStep('wb_clear', clientUUID());
    commit((steps) => [...steps, step]);
    setSelectedId(step.id);
    setPlaying(false);
    setNotice('已添加新页。播放到此步骤时清空画面，之前的教学步骤仍然保留。');
  }

  function insertTemplate(kind: WhiteboardTemplate) {
    const template = createWhiteboardTemplate(kind);
    commit((steps) => [...steps, ...template]);
    setSelectedId(template.find((step) => step.type !== 'wb_clear')?.id);
    setPlaying(false);
    setNotice('已在新页插入示例。可选择每个步骤修改数据、板书与 AI 讲解。');
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        ref={dialogRef}
        onOpenAutoFocus={(event) => {
          const field = dialogRef.current?.querySelector<HTMLTextAreaElement>('textarea');
          if (field) {
            event.preventDefault();
            field.focus();
            field.select();
          }
        }}
        showCloseButton={false}
        className="flex h-[min(860px,94dvh)] w-[min(1280px,96vw)] max-w-[96vw] flex-col gap-0 overflow-hidden rounded-[14px] bg-zinc-50 p-0 text-zinc-900 ring-zinc-200/80 shadow-xl dark:bg-zinc-950 dark:text-zinc-100 dark:ring-zinc-800"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-zinc-200 bg-white/95 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900/95">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">编辑白板</DialogTitle>
            <DialogDescription className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
              {scene?.title} · 按步骤讲解与书写，完成后保存课堂
            </DialogDescription>
          </div>
          <button
            className={button}
            aria-label="撤销白板编辑"
            disabled={!past.length || playing}
            onClick={() => history('undo')}
          >
            <Undo2 size={16} />
          </button>
          <button
            className={button}
            aria-label="重做白板编辑"
            disabled={!future.length || playing}
            onClick={() => history('redo')}
          >
            <Redo2 size={16} />
          </button>
          <button className={button} aria-label="关闭白板编辑" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {!block ? (
          <div role="status" className="flex-1 p-6">
            此白板已被删除或替换。请关闭后选择最新白板。
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 scroll-py-4 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_340px] lg:overflow-hidden">
            <div className="flex min-h-0 min-w-0 flex-col p-3 sm:p-4 lg:overflow-y-auto">
              <div className="flex shrink-0 flex-wrap items-center gap-2 pb-2">
                <span className="mr-auto text-xs text-zinc-500 dark:text-zinc-400">
                  步骤预览 · {Math.max(0, selectedIndex + 1)} / {stepCount}
                </span>
                <button
                  className={button}
                  disabled={!stepCount}
                  onClick={() => {
                    if (!playing) setSelectedId(block.steps[0]?.id);
                    setPlaying(!playing);
                  }}
                >
                  {playing ? <Pause size={15} /> : <Play size={15} />}
                  {playing ? '停止预览' : '从头播放'}
                </button>
                <button
                  className={button}
                  disabled={selectedIndex <= 0}
                  onClick={() => {
                    setPlaying(false);
                    setSelectedId(block.steps[selectedIndex - 1].id);
                  }}
                >
                  上一步
                </button>
                <button
                  className={button}
                  disabled={selectedIndex >= stepCount - 1}
                  onClick={() => {
                    setPlaying(false);
                    setSelectedId(block.steps[selectedIndex + 1].id);
                  }}
                >
                  下一步
                </button>
              </div>
              <div className="grid min-h-40 flex-1 place-items-center overflow-hidden rounded-[10px] border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
                <WhiteboardPreview
                  actions={(scene?.actions ?? []).slice(0, block.start + selectedIndex + 2)}
                />
              </div>
              <p
                aria-live="polite"
                className="max-h-20 min-h-12 shrink-0 overflow-y-auto py-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400"
              >
                {selected?.type === 'speech'
                  ? `AI 讲解：${selected.text || '请填写讲解内容'}`
                  : selected
                    ? `${boardStepLabel(selected)}：${boardStepSummary(selected)}`
                    : '添加第一个教学步骤'}
              </p>
              <div className="flex max-h-48 shrink-0 flex-wrap gap-1 overflow-y-auto border-t border-zinc-200 pt-2 dark:border-zinc-800">
                {block.steps.map((step, index) => (
                  <button
                    key={step.id}
                    className={cn(
                      button,
                      'max-w-44 border',
                      step.id === selected?.id
                        ? 'border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 hover:text-violet-800 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300 dark:hover:bg-violet-500/20 dark:hover:text-violet-200'
                        : 'border-transparent',
                    )}
                    aria-label={`步骤 ${index + 1}：${boardStepLabel(step)}`}
                    aria-pressed={step.id === selected?.id}
                    onClick={() => {
                      setPlaying(false);
                      setSelectedId(step.id);
                    }}
                  >
                    <span className="text-current opacity-60">{index + 1}</span>
                    <span className="truncate">{boardStepLabel(step)}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="min-h-0 border-t border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 scroll-py-4 lg:overflow-y-auto lg:border-l lg:border-t-0">
              <div className="space-y-3 p-4">
                <Field label="添加教学步骤">
                  <select
                    className={input}
                    value=""
                    disabled={playing}
                    onChange={(event) => {
                      if (event.target.value) add(event.target.value as BoardStepType);
                    }}
                  >
                    <option value="">选择要添加的内容…</option>
                    {stepTypes.map(([type, label]) => (
                      <option key={type} value={type}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="以新页插入示例模板">
                  <select className={input} value="" disabled={playing} onChange={(event) => {
                    if (event.target.value) insertTemplate(event.target.value as WhiteboardTemplate);
                  }}>
                    <option value="">选择示例（均可修改）…</option>
                    {whiteboardTemplates.map(([kind, label]) => <option key={kind} value={kind}>{label}（示例）</option>)}
                  </select>
                </Field>
                <div className="flex flex-wrap gap-1">
                  <button className={`${button} border border-zinc-200 dark:border-zinc-700`} disabled={playing} onClick={newPage}>新建白板页</button>
                  <button className={button} disabled={playing || !block.steps.length} onClick={() => {
                    commit((steps) => normalizeWhiteboardActionLayout(steps));
                    setNotice('已整理布局，保留教学顺序和分组。可撤销；仍有提示时请分到新页或调整内容。');
                  }}>整理布局</button>
                </div>
                {notice && <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">{notice}</p>}
                {issues.length > 0 && <details className="border-t border-zinc-200 pt-2 text-xs dark:border-zinc-800">
                  <summary className="min-h-11 cursor-pointer py-3 font-medium text-amber-700 focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-amber-300">白板检查：{issues.length} 项提示</summary>
                  <ul>
                    {issues.map((issue, index) => <li key={`${issue.code}-${index}`}>
                      <button className={cn(button, 'w-full justify-start py-2 text-left font-normal')} onClick={() => {
                        const id = issue.actionIds.find((actionId) => block.steps.some((step) => step.id === actionId));
                        if (id) setSelectedId(id);
                        setPlaying(false);
                      }}>{issue.message}</button>
                    </li>)}
                  </ul>
                </details>}
              </div>
              {selected && (
                <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
                  <div className="mb-3 flex items-center gap-1">
                    <h3 className="mr-auto text-sm font-semibold">
                      {selectedIndex + 1}. {boardStepLabel(selected)}
                    </h3>
                    <button
                      className={button}
                      aria-label="步骤上移"
                      disabled={selectedIndex <= 0 || playing}
                      onClick={() =>
                        commit((steps) => {
                          const next = [...steps];
                          const i = next.findIndex((step) => step.id === selected.id);
                          if (i > 0) [next[i - 1], next[i]] = [next[i], next[i - 1]];
                          return next;
                        })
                      }
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      className={button}
                      aria-label="步骤下移"
                      disabled={selectedIndex >= stepCount - 1 || playing}
                      onClick={() =>
                        commit((steps) => {
                          const next = [...steps];
                          const i = next.findIndex((step) => step.id === selected.id);
                          if (i >= 0 && i < next.length - 1)
                            [next[i + 1], next[i]] = [next[i], next[i + 1]];
                          return next;
                        })
                      }
                    >
                      <ArrowDown size={15} />
                    </button>
                    <button
                      className={button}
                      aria-label="删除白板步骤"
                      disabled={playing}
                      onClick={() =>
                        commit((steps) => deleteBoardStep(steps, selected.id))
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <fieldset disabled={playing}>
                    <StepFields
                      key={selected.id}
                      action={selected}
                      actions={(scene?.actions ?? []).slice(0, block.start + selectedIndex + 1)}
                      onChange={(update) =>
                        commit((steps) => editBoardStep(steps, selected.id, update))
                      }
                    />
                  </fieldset>
                </div>
              )}
            </div>
          </div>
        )}
        <div className="flex shrink-0 flex-wrap items-end gap-2 border-t border-zinc-200 bg-white/95 p-3 dark:border-zinc-800 dark:bg-zinc-900/95">
          {onEditWithAI && (
            <>
              <label className="min-w-40 flex-1">
                <span className="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">与 AI 一起编辑白板</span>
                <textarea
                  className={`${input} h-11 resize-none`}
                  aria-label="白板 AI 修改要求"
                  placeholder="例如：分三步讲解，并用表格对比两个方案…"
                  value={request}
                  onChange={(event) => setRequest(event.target.value)}
                />
              </label>
              <button
                className={cn(
                  button,
                  'border border-zinc-200 text-violet-700 hover:border-violet-300 hover:bg-violet-50 hover:text-violet-800 dark:border-zinc-700 dark:text-violet-300 dark:hover:border-violet-500/50 dark:hover:bg-violet-500/10 dark:hover:text-violet-200',
                )}
                disabled={!request.trim() || !block || aiRunning || playing}
                onClick={() => {
                  if (block) {
                    onEditWithAI(whiteboardAIPrompt(sceneId, block, request.trim()));
                    onClose();
                  }
                }}
              >
                <Plus size={15} />
                {aiRunning ? 'AI 正在编辑…' : '交给 AI 修改'}
              </button>
            </>
          )}
          <button
            className={cn(
              button,
              'bg-violet-600 text-white hover:bg-violet-700 hover:text-white focus-visible:outline-white dark:bg-violet-500 dark:text-white dark:hover:bg-violet-600 dark:hover:text-white',
            )}
            onClick={onClose}
          >
            <Check size={16} />
            完成编辑
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
