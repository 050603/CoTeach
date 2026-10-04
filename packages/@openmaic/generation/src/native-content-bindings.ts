import type { PPTElement, SlideContentBinding, VisualTargetSelector } from '@openmaic/dsl';
import type { AuthoringContentItem } from './authoring-content.js';
import type { GeneratedSlideData } from './pipeline-types.js';
import type { DiagramPlan } from './outline-types.js';
import { diagramOutputIds } from './diagram-compiler.js';

type Slot = Record<string, unknown>;
type PendingBinding = Omit<SlideContentBinding, 'elementId'>;

function record(value: unknown): value is Slot {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Capture real display slots before the reference resolver removes their refs.
 * Stable owner IDs survive rich-component migration, measurement and compilation.
 * Final IDs and table selectors are verified against the rendered elements later. */
export class NativeContentBindings {
  private readonly byOwner = new Map<string, PendingBinding[]>();
  private readonly catalog: Set<string>;

  constructor(items: readonly AuthoringContentItem[] = []) {
    this.catalog = new Set((Array.isArray(items) ? items : []).flatMap((item) => record(item)
      && typeof item.id === 'string' ? [item.id] : []));
  }

  private add(ownerId: string, slot: unknown, selector?: VisualTargetSelector): void {
    if (!record(slot)) return;
    const refs = [slot.contentRef, ...(Array.isArray(slot.paragraphRefs) ? slot.paragraphRefs : [])];
    for (const ref of refs) if (typeof ref === 'string' && this.catalog.has(ref)) {
      this.semantic(ownerId, ref, selector);
    }
  }

  private semantic(ownerId: string, sourceContentId: string, selector?: VisualTargetSelector): void {
    const binding = { sourceContentId, ...(selector ? { selector } : {}) };
    const existing = this.byOwner.get(ownerId) ?? [];
    if (!existing.some((item) => item.sourceContentId === sourceContentId
      && JSON.stringify(item.selector) === JSON.stringify(selector))) {
      this.byOwner.set(ownerId, [...existing, binding]);
    }
  }

  capture(data: GeneratedSlideData, outlineId: string, plannedDiagram?: DiagramPlan): void {
    const native = Array.isArray(data.elements) ? data.elements : [];
    const reserved = new Set(native.flatMap((element) => record(element)
      && typeof element.id === 'string' && element.id.trim() ? [element.id] : []));
    const used = new Set<string>();
    const allocate = (preferred: string, fallback: string): string => {
      let id = preferred;
      if (used.has(id)) {
        id = fallback;
        for (let suffix = 2; reserved.has(id) || used.has(id); suffix += 1) id = `${fallback}-${suffix}`;
      }
      used.add(id);
      return id;
    };
    for (const [index, element] of native.entries()) if (record(element)) {
      const fallback = `${outlineId}-element-${index}`;
      element.id = allocate(typeof element.id === 'string' && element.id.trim() ? element.id : fallback, fallback);
      this.element(element, element.id as string);
    }
    for (const [index, component] of (Array.isArray(data.components) ? data.components : []).entries()) if (record(component)) {
      // Components historically receive host-owned IDs. Assign them before
      // textBox emphasis can migrate a component into the native array.
      const preferred = `${outlineId}-component-${index}`;
      let candidate = preferred;
      for (let suffix = 2; this.outputIds(component, candidate, plannedDiagram).some((id) => used.has(id)); suffix += 1) {
        candidate = `${preferred}-${suffix}`;
      }
      component.id = allocate(candidate, preferred);
      for (const id of this.outputIds(component, component.id as string, plannedDiagram)) used.add(id);
      this.component(component, component.id as string);
    }
  }

  private outputIds(component: Slot, id: string, plannedDiagram?: DiagramPlan): string[] {
    if (component.kind === 'labelGrid' && Array.isArray(component.rows)) {
      const headers = component.rows.some((row) => record(row) && row.header !== undefined);
      return [id, ...component.rows.flatMap((row, rowIndex) => record(row) && Array.isArray(row.cells)
        ? Array.from({ length: row.cells.length + (headers ? 1 : 0) }, (_, column) =>
          [`${id}-${rowIndex}-${column}-shape`, `${id}-${rowIndex}-${column}-text`]).flat() : [])];
    }
    if (component.kind === 'diagram' || component.type === 'diagram') {
      try { return diagramOutputIds({ ...component, ...plannedDiagram } as unknown as DiagramPlan, id); }
      catch { /* The strict compiler reports malformed plans; capture does not validate them. */ }
      const nodes = plannedDiagram?.nodes ?? (Array.isArray(component.nodes) ? component.nodes.filter(record) : []);
      return [id, `${id}-annotation`, ...nodes.flatMap((node) => typeof node.id === 'string' ? [`${id}-node-${node.id}`] : [])];
    }
    return [id];
  }

  private element(element: Slot, id: string): void {
    if (element.type === 'text') this.add(id, element);
    else if (element.type === 'shape') this.add(id, element.text);
    else if (element.type === 'table' && Array.isArray(element.data)) {
      const cellIds = new Set<string>();
      const reserved = new Set(element.data.flatMap((row) => Array.isArray(row)
        ? row.flatMap((cell) => record(cell) && typeof cell.id === 'string' && cell.id.trim() ? [cell.id] : []) : []));
      for (const [rowIndex, row] of element.data.entries()) if (Array.isArray(row)) {
        for (const [columnIndex, cell] of row.entries()) if (record(cell)) {
          const fallback = `${id}-cell-${rowIndex}-${columnIndex}`;
          let cellId = typeof cell.id === 'string' && cell.id.trim() ? cell.id : fallback;
          if (cellIds.has(cellId)) {
            cellId = fallback;
            for (let suffix = 2; reserved.has(cellId) || cellIds.has(cellId); suffix += 1) cellId = `${fallback}-${suffix}`;
          }
          cell.id = cellId;
          cellIds.add(cellId);
          this.add(id, cell, { cellId });
        }
      }
    }
  }

  private component(component: Slot, id: string): void {
    if (component.kind === 'textBox') this.add(id, component);
    else if (component.kind === 'labelGrid' && Array.isArray(component.rows)) {
      const headers = component.rows.some((row) => record(row) && row.header !== undefined);
      for (const [rowIndex, row] of component.rows.entries()) if (record(row)) {
        if (headers) this.add(`${id}-${rowIndex}-0-text`, row.header);
        if (Array.isArray(row.cells)) for (const [columnIndex, cell] of row.cells.entries()) {
          this.add(`${id}-${rowIndex}-${columnIndex + (headers ? 1 : 0)}-text`, cell);
        }
      }
    }
  }

  /** The teaching plan owns node identities; the compiler owns their native IDs. */
  diagram(id: string, diagram: { nodes: Array<{ id: string }>; annotation?: string; presentation?: 'cards' | 'steps' }): void {
    for (const node of diagram.nodes) {
      this.semantic(`${id}-node-${node.id}`, `diagram-node:${node.id}`);
      // Numbered steps may display an existing ordinal in the adjacent circle.
      // Both actual native elements retain the same canonical node identity.
      if (diagram.presentation === 'steps') this.semantic(`${id}-number-${node.id}`, `diagram-node:${node.id}`);
    }
    if (diagram.annotation) this.semantic(`${id}-annotation`, 'diagram-annotation');
  }

  /** Bind only targets which survived normalization; never claim metadata alone
   * was displayed. Called once per final page so continuation targets stay local. */
  resolve(elements: readonly PPTElement[], finalIds: ReadonlyMap<string, string>): SlideContentBinding[] {
    const bindings: SlideContentBinding[] = [];
    const byId = new Map(elements.map((element) => [element.id, element]));
    for (const [ownerId, pending] of this.byOwner) {
      const elementId = finalIds.get(ownerId) ?? ownerId;
      const element = byId.get(elementId);
      if (!element) continue;
      for (const binding of pending) {
        const cellId = binding.selector && 'cellId' in binding.selector ? binding.selector.cellId : undefined;
        if (cellId && (element.type !== 'table'
          || !element.data.some((row) => row.some((cell) => cell.id === cellId)))) continue;
        bindings.push({ ...binding, elementId });
      }
    }
    return bindings;
  }
}
