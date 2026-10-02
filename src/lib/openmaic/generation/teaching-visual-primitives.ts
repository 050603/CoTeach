import type { PPTShapeElement, TeachingVisualIcon } from '@openmaic/dsl';
import { TEACHING_VISUAL_THEME as T } from './teaching-visual-theme';

/** Native editable paths. Icon keys describe objects, never factual evidence. */
const ICONS: Record<TeachingVisualIcon, string> = {
  layers: 'M12 2L2 7L12 12L22 7ZM2 12L12 17L22 12M2 17L12 22L22 17',
  context: 'M4 3H20V19H4ZM4 7H20M7 5H7.1M10 5H10.1M10 11C10 9 14 9 14 11C14 12 12 12 12 14M12 16H12.1',
  book: 'M3 5C6 4 9 4 12 6C15 4 18 4 21 5V20C18 19 15 19 12 21C9 19 6 19 3 20ZM12 6V21',
  people: 'M8 9C10.2 9 12 7.2 12 5C12 2.8 10.2 1 8 1C5.8 1 4 2.8 4 5C4 7.2 5.8 9 8 9ZM1 22V17C1 13 4 11 8 11C12 11 15 13 15 17V22M17 9C19.2 9 21 7.2 21 5C21 2.8 19.2 1 17 1M18 11C21 11 23 14 23 17V22',
  checklist: 'M5 2H20V22H5ZM8 7L10 9L13 5M15 7H18M8 15L10 17L13 13M15 15H18',
  target: 'M12 2C6.5 2 2 6.5 2 12C2 17.5 6.5 22 12 22C17.5 22 22 17.5 22 12C22 6.5 17.5 2 12 2ZM12 7C9.2 7 7 9.2 7 12C7 14.8 9.2 17 12 17C14.8 17 17 14.8 17 12C17 9.2 14.8 7 12 7ZM12 11V13M11 12H13',
  search: 'M10 2C5.6 2 2 5.6 2 10C2 14.4 5.6 18 10 18C14.4 18 18 14.4 18 10C18 5.6 14.4 2 10 2ZM16 16L22 22',
  lightbulb: 'M8 16C8 13 4 12 4 8C4 3 8 1 12 1C16 1 20 3 20 8C20 12 16 13 16 16ZM8 20H16M10 23H14',
  gear: 'M9 2H15L16 5L19 4L22 9L20 12L22 15L19 20L16 19L15 22H9L8 19L5 20L2 15L4 12L2 9L5 4L8 5ZM12 8C9.8 8 8 9.8 8 12C8 14.2 9.8 16 12 16C14.2 16 16 14.2 16 12C16 9.8 14.2 8 12 8Z',
  document: 'M5 2H15L20 7V22H5ZM15 2V7H20M8 11H17M8 15H17M8 19H14',
  chart: 'M3 2V21H22M7 17V10M12 17V5M17 17V8',
  flag: 'M4 23V2M4 2H12L14 5H21V15H14L12 12H4',
  question: 'M12 2C6.5 2 2 6.5 2 12C2 17.5 6.5 22 12 22C17.5 22 22 17.5 22 12C22 6.5 17.5 2 12 2ZM9 8C9 6 15 6 15 9C15 11 12 11 12 14M12 18H12.1',
};
type Rect = { left: number; top: number; width: number; height: number };
/** A missing optional icon may use an unambiguous label's library glyph.
 * This decorates the existing object; it never supplies facts or source credit. */
export function semanticVisualIcon(label: string): TeachingVisualIcon | undefined {
  const meanings: Array<[RegExp, TeachingVisualIcon]> = [
    [/协作|合作|小组|collaborat|team|group/iu, 'people'],
    [/评价|评估|检查|核对|评审|evaluat|assess|check|verif|review/iu, 'checklist'],
    [/情境|案例|context|case|scenario/iu, 'context'],
    [/探索|阅读|探究|explor|read|investigat/iu, 'book'],
    [/支架|脚手架|框架|层级|结构|scaffold|framework|layer|structure/iu, 'layers'],
    [/目标|目的|target|goal|purpose/iu, 'target'],
    [/观察|查找|定位|inspect|search|observ/iu, 'search'],
    [/记录|资料|文档|record|document|note/iu, 'document'],
    [/数据|测量|统计|data|measure|statistic/iu, 'chart'],
    [/修复|操作|执行|fix|repair|operat|execut/iu, 'gear'],
    [/结论|启发|想法|conclu|idea|insight/iu, 'lightbulb'],
  ];
  return meanings.find(([pattern]) => pattern.test(label))?.[1];
}

export function roundedVisualPanel(id: string, rect: Rect, fill: string, radius = 12): PPTShapeElement {
  const { width: w, height: h } = rect, r = Math.min(radius, w / 2, h / 2);
  return { id, type: 'shape', ...rect, rotate: 0, fixedRatio: false, viewBox: [w, h], fill,
    path: `M${r} 0H${w - r}Q${w} 0 ${w} ${r}V${h - r}Q${w} ${h} ${w - r} ${h}H${r}Q0 ${h} 0 ${h - r}V${r}Q0 0 ${r} 0Z` };
}
export function visualCircle(id: string, left: number, top: number, diameter: number, fill: string): PPTShapeElement {
  const r = diameter / 2, k = r * 0.55228475;
  return { id, type: 'shape', left, top, width: diameter, height: diameter, rotate: 0,
    fixedRatio: true, viewBox: [diameter, diameter], fill,
    path: `M${r} 0C${r + k} 0 ${diameter} ${r - k} ${diameter} ${r}C${diameter} ${r + k} ${r + k} ${diameter} ${r} ${diameter}C${r - k} ${diameter} 0 ${r + k} 0 ${r}C0 ${r - k} ${r - k} 0 ${r} 0Z` };
}
export function visualIcon(id: string, icon: TeachingVisualIcon, left: number, top: number, size = 46, color: string = T.blue): PPTShapeElement {
  return { id, type: 'shape', left, top, width: size, height: size, rotate: 0, fixedRatio: true,
    viewBox: [24, 24], path: ICONS[icon], fill: '#00000000', outline: { color, width: 2, style: 'solid' } };
}
export function visualLearner(id: string, center: number, top: number, height = 100): PPTShapeElement[] {
  const scale = height / 120, width = 68 * scale, left = center - width / 2;
  return [visualCircle(`${id}:head`, center - 12 * scale, top, 24 * scale, T.teal),
    { id: `${id}:learner`, type: 'shape', left, top: top + 32 * scale, width, height: 88 * scale,
      rotate: 0, fixedRatio: true, viewBox: [68, 88], fill: T.teal,
      path: 'M22 0H46C59 0 65 8 65 20V48H53V21H48V88H36V52H32V88H20V21H15V48H3V20C3 8 9 0 22 0Z' }];
}
