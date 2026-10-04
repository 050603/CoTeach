import type { CSSProperties } from 'react';
import type { TableCell, TableCellStyle } from '@openmaic/dsl';

/**
 * Convert TableCellStyle to CSS properties
 */
export function getTextStyle(style?: TableCellStyle): CSSProperties {
  if (!style) return {};

  const css: CSSProperties = {};

  if (style.bold) css.fontWeight = 'bold';
  if (style.em) css.fontStyle = 'italic';
  if (style.underline) css.textDecoration = 'underline';
  if (style.strikethrough) {
    css.textDecoration = css.textDecoration ? `${css.textDecoration} line-through` : 'line-through';
  }
  if (style.color) css.color = style.color;
  if (style.backcolor) css.backgroundColor = style.backcolor;
  if (style.fontsize) css.fontSize = style.fontsize;
  if (style.fontname) css.fontFamily = style.fontname;
  if (style.align) css.textAlign = style.align;

  return css;
}

/**
 * Format text: convert \n to <br/> and spaces to &nbsp;
 */
export function formatText(text: string): string {
  return text.replace(/\n/g, '<br/>').replace(/ /g, '&nbsp;');
}

/** DSL rows contain real cells, not one entry per logical column. Resolve
 * their grid positions without treating a compact array index as a column.
 * Historical full-grid rows may still contain empty covered placeholders. */
export function tableCellLayout(data: TableCell[][], columnCount: number): Array<Array<{
  cell: TableCell; columnIndex: number;
}>> {
  const occupied = new Set<string>();
  return data.map((row, rowIndex) => {
    let columnIndex = 0;
    return row.flatMap((cell, dataIndex) => {
      const colspan = Math.max(1, cell.colspan ?? 1);
      const rowspan = Math.max(1, cell.rowspan ?? 1);
      // Only a rectangular legacy row can carry a placeholder at its data
      // index. Never discard an authored text cell or a compact empty cell.
      if (row.length === columnCount && occupied.has(`${rowIndex}:${dataIndex}`)
        && colspan === 1 && rowspan === 1 && !cell.text.trim()) return [];
      while (occupied.has(`${rowIndex}:${columnIndex}`)) columnIndex += 1;
      const anchor = columnIndex;
      for (let r = 0; r < rowspan; r += 1) for (let c = 0; c < colspan; c += 1) {
        occupied.add(`${rowIndex + r}:${anchor + c}`);
      }
      columnIndex += colspan;
      return [{ cell, columnIndex: anchor }];
    });
  });
}
