import katex from 'katex';
import type { Action } from '@openmaic/lib/types/action';

export interface WhiteboardContentIssue {
  code: 'chart-data' | 'table-data' | 'formula-syntax' | 'image-source';
  message: string;
  actionIds: string[];
}

/** Validate actual renderable content without changing the teacher's data. */
export function auditWhiteboardContent(actions: readonly Action[]): WhiteboardContentIssue[] {
  const issues: WhiteboardContentIssue[] = [];
  for (const action of actions) {
    const report = (code: WhiteboardContentIssue['code'], message: string) => {
      issues.push({ code, message, actionIds: [action.id] });
    };
    if (action.type === 'wb_draw_image' && (typeof action.src !== 'string' || !action.src.trim() || action.src === '[retain supplied image source]')) {
      report('image-source', '请上传图片或填写已有图片地址。');
    }
    if (action.type === 'wb_draw_chart') {
      const { labels, legends, series } = action.data ?? {};
      if (!Array.isArray(labels) || !labels.length || !labels.every((label) => typeof label === 'string')
        || !Array.isArray(legends) || !legends.length || !legends.every((legend) => typeof legend === 'string')
        || !Array.isArray(series) || series.length !== legends.length
        || series.some((values) => !Array.isArray(values) || values.length !== labels.length || values.some((value) => !Number.isFinite(value)))) {
        report('chart-data', '图表的分类、图例和数值数量必须对应，且数值必须是有限数字。');
        continue;
      }
      if (action.chartType === 'scatter' && series.length !== 2) {
        report('chart-data', '散点图需要两列数值：第一列为 X，第二列为 Y，每行组成一个数据点。');
      }
      if (action.chartType === 'pie' || action.chartType === 'ring') {
        if (series.length !== 1) report('chart-data', '饼图和环形图只展示一组数值，请选择一组数据或改用柱状图。');
        else if (series[0].some((value) => value < 0) || !series[0].some((value) => value > 0)) {
          report('chart-data', '饼图和环形图的数据不能为负数，且至少需要一个正数。');
        }
      }
    }
    if (action.type === 'wb_draw_table') {
      const rows = action.data;
      if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0]) || !rows[0].length
        || rows.some((row) => !Array.isArray(row) || row.length !== rows[0].length || row.some((cell) => typeof cell !== 'string'))) {
        report('table-data', '表格需要完整的行列，每行列数必须一致。');
      }
    }
    if (action.type === 'wb_draw_latex') {
      try {
        if (!action.latex.trim() || /[\u0000-\u0009\u000b-\u001f]/.test(action.latex.replace(/\r\n/g, '\n'))) throw new Error('Invalid formula source');
        katex.renderToString(action.latex, { displayMode: true, throwOnError: true, trust: false, strict: 'ignore', maxExpand: 1000 });
      } catch {
        report('formula-syntax', '公式无法解析，请检查命令、括号及 JSON 中的反斜杠转义。');
      }
    }
  }
  return issues;
}
