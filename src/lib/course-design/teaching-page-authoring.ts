type RecordValue = Record<string, unknown>;

/** Shared authoring instruction; source ownership does not create a display quota. */
export const PAGE_PRESENTATION_AUTHORING_GUIDANCE = '根据本页完整认识独立提炼学生需要查看的核心展示命题，组织 presentationItems 与必要图文，不按内容角色重新切页。完整讲授的 explanationNodes 不是逐项上屏目录；一个节点可支持多个展示项，多个节点也可共同支持一项完整认识，节点还可以只负责口头解释，不必为每个节点制作展示项。heading 定位学习对象或分组，key-point 提炼核心认识，comparison 说明共同维度下的对应事实，process-label 保留必要名称与真实关系，case-observation 指出要看的事实与差异。并列要素保留必要名称和作用，比较保留对象、共同维度及对应事实；根据实际关系自然组合展示文案，不强制逐项成框、逐事实拆项或预先绑定表头和单元格。展示项数量不决定页面、文本框或栏目数量。完整流程节点与真实连接写入 visualRelationship.diagram，已由图示呈现的名称不用再复制成文字清单。role 不能只是给完整解释段落换一个名字，也不能把三段定义改成三个卡片便视为提炼。展示需要内容取舍、关系组织和关键词层级，让学生在听讲时能迅速定位核心认识；完整定义、推理、详细案例和展开条件落实在原节点与实际讲稿。所选展示命题仍须准确，保留它的主体、数量、否定关系、程度和适用条件；不能用无意义词条、空泛口号或改变边界的短句替代核心认识。';

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

function id(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.map(id).filter(Boolean) : [];
}

/** The first author writes explanations where they are taught. Compile that
 * actual ordered ownership into the existing blueprint; never schedule, edit
 * or repair a saved explanation or borrow one from a future page. */
export function compilePageOwnedTeachingNodes(value: unknown,
  options: { enforceTeachingOrder?: boolean } = {}): { value: unknown; issues: string[] } {
  const envelope = record(value);
  if (envelope?.authoringContract !== 'blueprint-v4' && envelope?.authoringContract !== 'blueprint-v5') {
    return { value, issues: [] };
  }
  const issues: string[] = [];
  const enforceTeachingOrder = options.enforceTeachingOrder !== false;
  const allNodes = new Map<string, { sectionIndex: number; unitId: string }>();
  if (!enforceTeachingOrder) for (const [sectionIndex, rawSection] of (Array.isArray(envelope.sections) ? envelope.sections : []).entries()) {
    const section = record(rawSection);
    for (const rawPage of Array.isArray(section?.pages) ? section.pages : []) {
      const page = record(rawPage);
      for (const rawNode of Array.isArray(page?.explanationNodes) ? page.explanationNodes : []) {
        const node = record(rawNode);
        allNodes.set(id(node?.id), { sectionIndex, unitId: id(node?.unitId) });
      }
    }
  }
  const seenNodes = new Map<string, { sectionIndex: number; pageIndex: number; unitId: string }>();
  const sections = (Array.isArray(envelope.sections) ? envelope.sections : []).map((rawSection, sectionIndex) => {
    const section = record(rawSection);
    if (!section) { issues.push(`第 ${sectionIndex + 1} 节缺少有效结构`); return rawSection; }
    const units: Array<RecordValue & { explanationNodes: RecordValue[] }> = (Array.isArray(section.units) ? section.units : []).map((rawUnit) => {
      const unit = record(rawUnit) ?? {};
      if (Array.isArray(unit.explanationNodes) && unit.explanationNodes.length) {
        issues.push(`第 ${sectionIndex + 1} 节 units 不能再次复写页面正文`);
      }
      return { ...unit, explanationNodes: [] as RecordValue[] };
    });
    const unitById = new Map(units.map((unit) => [id(unit.id), unit]));
    if (unitById.size !== units.length || unitById.has('')) {
      issues.push(`第 ${sectionIndex + 1} 节的 unit id 缺失或重复，不能确定实际页面正文归属`);
    }
    const pages = (Array.isArray(section.pages) ? section.pages : []).map((rawPage, pageIndex) => {
      const page = record(rawPage) ?? {};
      const location = `第 ${sectionIndex + 1} 节第 ${pageIndex + 1} 页`;
      const introduced: string[] = [];
      const unitIds = new Set<string>();
      const priorIds = new Set<string>();
      const readIds = (value: unknown, field: string): string[] => {
        if (value !== undefined && (!Array.isArray(value) || value.some((entry) => !id(entry)))) {
          issues.push(`${location}的 ${field} 缺少有效节点编号`);
        }
        return ids(value);
      };
      const deepens = readIds(page.deepensNodeIds, 'deepensNodeIds');
      for (const nodeId of deepens) {
        const prior = seenNodes.get(nodeId) ?? (!enforceTeachingOrder ? allNodes.get(nodeId) : undefined);
        if (!prior || prior.sectionIndex !== sectionIndex
          || enforceTeachingOrder && (seenNodes.get(nodeId)?.pageIndex ?? pageIndex) >= pageIndex) {
          issues.push(`${location}的 deepensNodeIds 尚未在此前页面实际讲授`);
        } else unitIds.add(prior.unitId);
      }
      if (!Array.isArray(page.explanationNodes)) issues.push(`${location}缺少实际落页的 explanationNodes`);
      for (const rawNode of Array.isArray(page.explanationNodes) ? page.explanationNodes : []) {
        const authored = record(rawNode) ?? {};
        const nodeId = id(authored.id);
        const ownerId = id(authored.unitId);
        const unit = unitById.get(ownerId);
        if (!unit || !nodeId || seenNodes.has(nodeId)) {
          issues.push(`${location}的 explanationNode 缺少唯一 id 或已有 unitId，不能确定正文归属`);
          continue;
        }
        for (const prerequisiteId of readIds(authored.prerequisiteNodeIds, `${nodeId}.prerequisiteNodeIds`)) {
          if (!seenNodes.has(prerequisiteId) && (enforceTeachingOrder || !allNodes.has(prerequisiteId))) {
            issues.push(`${location}的节点 ${nodeId} 先备引用 ${prerequisiteId} 尚未在此前页或本页更早正文中实际讲授`);
          }
          priorIds.add(prerequisiteId);
        }
        // The tag selects an existing unit, not another copy of its prose.
        const { unitId: _ownerTag, ...node } = authored;
        void _ownerTag;
        unit.explanationNodes.push(node);
        introduced.push(nodeId);
        unitIds.add(ownerId);
        seenNodes.set(nodeId, { sectionIndex, pageIndex, unitId: ownerId });
      }
      for (const ref of Array.isArray(page.keyPointRefs) ? page.keyPointRefs : []) {
        const nodeId = id(record(ref)?.nodeId);
        if (nodeId) priorIds.add(nodeId);
      }
      for (const item of Array.isArray(page.presentationItems) ? page.presentationItems : []) {
        readIds(record(item)?.nodeIds, 'presentationItems.nodeIds').forEach((nodeId) => priorIds.add(nodeId));
      }
      readIds(page.referencesNodeIds, 'referencesNodeIds').forEach((nodeId) => priorIds.add(nodeId));
      const references = [...priorIds].filter((nodeId) => !introduced.includes(nodeId) && !deepens.includes(nodeId));
      for (const nodeId of references) {
        const prior = seenNodes.get(nodeId);
        if (enforceTeachingOrder && (!prior || prior.sectionIndex === sectionIndex && prior.pageIndex >= pageIndex)) {
          issues.push(`${location}引用 ${nodeId} 尚未在此前页面实际讲授`);
        }
      }
      if (page.introducesNodeIds !== undefined && JSON.stringify(ids(page.introducesNodeIds)) !== JSON.stringify(introduced)) {
        issues.push(`${location}重复声明的首次讲授归属与实际正文不一致`);
      }
      if (page.unitIds !== undefined && (ids(page.unitIds).length !== unitIds.size
        || [...unitIds].some((unitId) => !ids(page.unitIds).includes(unitId)))) {
        issues.push(`${location}重复声明的单元归属与实际正文不一致`);
      }
      const { explanationNodes: _authoredNodes, ...metadata } = page;
      void _authoredNodes;
      return { ...metadata, unitIds: [...unitIds], introducesNodeIds: introduced,
        deepensNodeIds: deepens, referencesNodeIds: references };
    });
    return { ...section, units, pages };
  });
  return { value: { ...envelope, sections }, issues };
}
