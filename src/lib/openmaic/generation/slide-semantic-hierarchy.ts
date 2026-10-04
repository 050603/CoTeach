import type { PPTElement, PPTShapeElement, SlideContentBinding } from '@openmaic/dsl';

export interface SlideSemanticGroup {
  id: string;
  label: string;
  sourceContentIds: string[];
  members: Array<{ id: string; label: string; sourceContentIds: string[] }>;
}

export interface SlideSemanticItem {
  id: string;
  text: string;
  label?: string;
  sourceContentIds: readonly string[];
  semanticBindings?: unknown;
}

type Binding = { groupId: string; role: 'overview' | 'member' | 'context'; memberId?: string };
type Rect = { left: number; top: number; width: number; height: number };
type NativeContent = {
  elements: readonly PPTElement[];
  displayItems?: readonly SlideSemanticItem[];
  contentBindings?: readonly SlideContentBinding[];
};

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const countPattern = '(?:[1-9]\\d?|[一二两三四五六七八九十]{1,3})';
const setNoun = '(?:组成部分|组成要素|要素|元素|类型|类别|条件|方面|步骤|阶段|原则|特征|特点|指标|环节|策略|部分|维度|途径|方法)';

function countOf(value: string): number | undefined {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  if (/^[一二三]?十[一二三四五六七八九]?$/u.test(value)) {
    const [tens, ones] = value.split('十');
    return (tens ? digits[tens]! : 1) * 10 + (ones ? digits[ones]! : 0);
  }
  return digits[value];
}

function countedHeading(label: string): { count: number; scope: string } | undefined {
  const named = new RegExp(`^(.*?)(${countPattern})(?:大)?(${setNoun})$`, 'u').exec(label);
  const classified = new RegExp(`^(.*?)(${countPattern})(?:类|种|个|项)([^:：]{1,30})$`, 'u').exec(label);
  const match = named ?? classified;
  const count = match && countOf(match[2]!);
  return count ? { count, scope: `${match![1]}${match![3]}`.replace(/\s/gu, '') } : undefined;
}

function declaredSet(sentence: string): { label: string; members: string[] } | undefined {
  const text = sentence.trim().replace(/[。.!！?？]$/u, '').trim();
  const colon = text.search(/[:：]/u);
  if (colon < 0 || colon !== text.lastIndexOf(text[colon]!)) return;
  const label = text.slice(0, colon).trim();
  if (!label || label.length > 80 || /[，,；;()（）\n]/u.test(label)
    || /至少|至多|最多|不少于|不超过|约|其中|部分|任选|例如|比如|假设|如果|前\d|后\d/u.test(label)) return;
  const count = countedHeading(label)?.count;
  if (!count || count < 2 || count > 32) return;
  const payload = text.slice(colon + 1).trim();
  if (!payload || /[:：；;()（）\n]/u.test(payload) || /(?:等(?:等|类型|类别|要素|材料|情况|内容)?|其他|其它)$/u.test(payload)) return;
  let members = payload.split(/[、，,]/u).map((part) => part.trim());
  if (members.length === count - 1) {
    const last = members.at(-1)!;
    const conjunction = last.includes('以及') ? '以及' : last.includes('和') ? '和' : last.includes('及') ? '及' : undefined;
    if (conjunction && last.split(conjunction).length === 2) members = [...members.slice(0, -1), ...last.split(conjunction)];
  }
  members = members.map((part) => part.trim().replace(/^[“「『"]|[”」』"]$/gu, '').trim());
  if (members.length !== count || new Set(members).size !== count
    || members.some((member) => !member || member.length > 32 || /[。！？!?]/u.test(member))) return;
  return { label, members };
}

/** Only complete counted declarations already adopted by this page create a
 * group. Available textbook paragraphs and incidental quantities are not scope. */
export function buildSlideSemanticGroups(sources: readonly { id: string; text: string }[]): SlideSemanticGroup[] {
  const groups: SlideSemanticGroup[] = [];
  for (const source of sources) {
    let declarationIndex = 0;
    for (const sentence of source.text.split(/(?<=[。！？!?])/u)) {
      const declaration = declaredSet(sentence);
      if (!declaration) continue;
      declarationIndex += 1;
      const id = `semantic-group:${source.id}:${declarationIndex}`;
      groups.push({ id, label: declaration.label, sourceContentIds: [source.id],
        members: declaration.members.map((label, index) => ({ id: `${id}:member:${index + 1}`, label,
          sourceContentIds: [...new Set([source.id, ...sources.filter((candidate) =>
            new RegExp(`^\\s*${escape(label)}\\s*[:：]`, 'u').test(candidate.text)).map((candidate) => candidate.id)])] })) });
    }
  }
  return groups;
}

function bindings(item: SlideSemanticItem): Binding[] {
  return (Array.isArray(item.semanticBindings) ? item.semanticBindings : []).filter((value): value is Binding => record(value)
    && typeof value.groupId === 'string' && ['overview', 'member', 'context'].includes(String(value.role))
    && (value.memberId === undefined || typeof value.memberId === 'string'));
}

const hasLabel = (item: Pick<SlideSemanticItem, 'text' | 'label'>, label: string) => {
  if (item.label === label) return true;
  const text = `${item.label ?? ''}\n${item.text}`;
  return [...label].length > 1 ? text.includes(label) : new RegExp(`(?:^|[\\s、，,:：;；。()（）])${escape(label)}(?=$|[\\s、，,:：;；。()（）])`, 'u').test(text);
};
const overviewComplete = (item: SlideSemanticItem, group: SlideSemanticGroup) => group.members.every((member) => hasLabel(item, member.label));
const overviewNamesGroup = (item: SlideSemanticItem, group: SlideSemanticGroup) => {
  const expected = countedHeading(group.label);
  if (hasLabel(item, group.label) || expected && hasLabel(item, expected.scope)) return true;
  return [item.label, item.text.split(/[:：]/u)[0]?.trim()].some((heading) => {
    const declared = heading && countedHeading(heading);
    return expected && declared && expected.scope.endsWith(declared.scope) && declared.count === group.members.length;
  });
};
const memberSupported = (item: SlideSemanticItem, group: SlideSemanticGroup, member: SlideSemanticGroup['members'][number]) =>
  item.sourceContentIds.some((id) => member.sourceContentIds.includes(id)) && (hasLabel(item, member.label)
    || item.sourceContentIds.some((id) => member.sourceContentIds.includes(id) && !group.sourceContentIds.includes(id)));

/** Semantic errors are quality diagnoses. They never erase native content or
 * turn a valid first response into a technical failure or a new model call. */
export function nativeSemanticBindingIssues(items: readonly SlideSemanticItem[], groups: readonly SlideSemanticGroup[]): string[] {
  if (!items.length && !groups.length) return [];
  const issues: string[] = [];
  for (const item of items) {
    if (item.semanticBindings !== undefined && !Array.isArray(item.semanticBindings)) issues.push(`Invalid semantic bindings for ${item.id}`);
    for (const raw of Array.isArray(item.semanticBindings) ? item.semanticBindings : []) {
      if (!record(raw) || typeof raw.groupId !== 'string' || !['overview', 'member', 'context'].includes(String(raw.role))) {
        issues.push(`Invalid semantic role or group binding for ${item.id}`); continue;
      }
      const group = groups.find((candidate) => candidate.id === raw.groupId);
      if (!group) { issues.push(`Unknown semantic group ${raw.groupId} for ${item.id}`); continue; }
      if (raw.role === 'member') {
        const member = group.members.find((candidate) => candidate.id === raw.memberId);
        if (!member) issues.push(`Unknown semantic member ${String(raw.memberId)} in ${group.id} for ${item.id}`);
        else if (!memberSupported(item, group, member)) issues.push(`Unsupported semantic member ${member.label} for ${item.id}`);
      } else if (raw.memberId !== undefined) issues.push(`Semantic ${String(raw.role)} cannot claim a member for ${item.id}`);
      if (raw.role === 'overview' && !item.sourceContentIds.some((id) => group.sourceContentIds.includes(id))) {
        issues.push(`Semantic overview ${item.id} lacks its declared group source ${group.id}`);
      }
      if (raw.role === 'overview') {
        const expected = countedHeading(group.label);
        const headings = [item.label, ...item.text.split(/(?<=[。！？!?])/u)
          .filter((sentence) => /[:：]/u.test(sentence)).map((sentence) => sentence.split(/[:：]/u)[0]!.trim())];
        if (expected && headings.some((heading) => {
          const declared = heading && countedHeading(heading.trim());
          return declared && (declared.scope === expected.scope || expected.scope.endsWith(declared.scope))
            && declared.count !== group.members.length;
        })) issues.push(`Changed declared member count in semantic overview ${item.id} for ${group.label}`);
      }
    }
    const applicable = bindings(item).filter((binding) => {
      const group = groups.find((candidate) => candidate.id === binding.groupId);
      if (!group) return false;
      if (binding.role === 'context') return binding.memberId === undefined;
      if (binding.role === 'overview') return binding.memberId === undefined && item.sourceContentIds.some((id) => group.sourceContentIds.includes(id));
      const member = group.members.find((candidate) => candidate.id === binding.memberId);
      return Boolean(member && memberSupported(item, group, member));
    });
    if (groups.length && !applicable.length) issues.push(`Unclassified semantic hierarchy for item ${item.id}`);
    const explainedMembers = groups.flatMap((group) => group.members.filter((member) => item.sourceContentIds.some((id) =>
      member.sourceContentIds.includes(id) && !group.sourceContentIds.includes(id))).map((member) => ({ group, member })));
    if (explainedMembers.length && !applicable.some((binding) => binding.role === 'member'
      || binding.role === 'overview' && overviewComplete(item, groups.find((group) => group.id === binding.groupId)!))) {
      issues.push(`Member explanation ${item.id} lacks its actual member classification`);
    }
  }
  for (const group of groups) {
    const overviews = items.filter((item) => bindings(item).some((binding) => binding.groupId === group.id && binding.role === 'overview')
      && item.sourceContentIds.some((id) => group.sourceContentIds.includes(id)));
    if (!overviews.length) issues.push(`Missing semantic overview for ${group.label}`);
    const aggregateComplete = group.members.every((member) => overviews.some((item) => hasLabel(item, member.label))
      || items.some((item) => bindings(item).some((binding) => binding.groupId === group.id && binding.role === 'member' && binding.memberId === member.id)
        && memberSupported(item, group, member) && hasLabel(item, member.label)));
    if (overviews.length && (!aggregateComplete || !overviews.some((item) => overviewComplete(item, group) || overviewNamesGroup(item, group)))) {
      issues.push(`Incomplete semantic overview for ${group.label}`);
    }
    for (const member of group.members) {
      if (overviews.some((item) => overviewComplete(item, group)) || items.some((item) => bindings(item).some((binding) =>
        binding.groupId === group.id && binding.role === 'member' && binding.memberId === member.id) && memberSupported(item, group, member))) continue;
      issues.push(`Missing readable semantic member ${member.label} in ${group.label}`);
    }
  }
  return [...new Set(issues)];
}

function visibleText(html: string): string {
  if (/(?:display\s*:\s*none|visibility\s*:\s*hidden|(?:opacity|font-size)\s*:\s*0(?:px|[;"\s])|color\s*:\s*transparent)/iu.test(html)) return '';
  return html.replace(/<\s*br\s*\/?\s*>|<\/(?:p|div|li|h[1-6])\s*>/giu, '\n').replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;/gu, ' ').replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').trim();
}
function boundText(element: PPTElement, binding: SlideContentBinding): string {
  if (element.type === 'text') return visibleText(element.content);
  if (element.type === 'shape') return visibleText(element.text?.content ?? '');
  if (element.type !== 'table') return '';
  const selector = binding.selector;
  if (selector && 'cellId' in selector) return visibleText(element.data.flat().find((cell) => cell.id === selector.cellId)?.text ?? '');
  if (selector && 'rowIndex' in selector) return (element.data[selector.rowIndex] ?? []).map((cell) => visibleText(cell.text)).join(' ');
  return element.data.flat().map((cell) => visibleText(cell.text)).join(' ');
}
const contains = (outer: Rect, inner: Rect) => outer.left <= inner.left + 1 && outer.top <= inner.top + 1
  && outer.left + outer.width >= inner.left + inner.width - 1 && outer.top + outer.height >= inner.top + inner.height - 1;
const region = (rects: readonly Rect[]): Rect => ({ left: Math.min(...rects.map((rect) => rect.left)), top: Math.min(...rects.map((rect) => rect.top)),
  width: Math.max(...rects.map((rect) => rect.left + rect.width)) - Math.min(...rects.map((rect) => rect.left)),
  height: Math.max(...rects.map((rect) => rect.top + rect.height)) - Math.min(...rects.map((rect) => rect.top)) });

/** Compare actual leading-label typography, not later inline emphasis or text
 * length. Restrict this check to ordinary text with a visibly emphasized lead. */
function plainSectionStyle(element: PPTElement): string | undefined {
  if (element.type !== 'text') return;
  const opening = element.content.match(/^\s*(?:<[^>]+>\s*)+/u)?.[0];
  if (!opening) return;
  const tags = [...opening.matchAll(/<([a-z][\w-]*)\b[^>]*>/giu)];
  const property = (tag: string, name: string) => tag.match(new RegExp(`(?:[;"'])\\s*${name}\\s*:\\s*([^;"']+)`, 'iu'))?.[1]?.trim().toLowerCase();
  const body = tags[0]?.[0] ?? '';
  const size = property(body, 'font-size');
  const color = property(body, 'color') ?? element.defaultColor?.toLowerCase();
  if (!size || !color) return;
  const family = property(body, 'font-family') ?? element.defaultFontName?.toLowerCase();
  let leadSize = size, leadColor = color, leadWeight = property(body, 'font-weight') ?? '400';
  let leadFamily = family;
  for (const tag of tags) {
    leadSize = property(tag[0], 'font-size') ?? leadSize;
    leadColor = property(tag[0], 'color') ?? leadColor;
    leadWeight = property(tag[0], 'font-weight') ?? (/^(?:strong|b)$/iu.test(tag[1]!) ? '700' : leadWeight);
    leadFamily = property(tag[0], 'font-family') ?? leadFamily;
  }
  if (leadColor === color && Number(leadWeight) < 600 && leadWeight !== 'bold') return;
  const weight = (value: string) => value === 'bold' ? '700' : value === 'normal' ? '400' : value;
  return JSON.stringify([size, color, family, weight(property(body, 'font-weight') ?? '400'), leadSize, leadColor, weight(leadWeight), leadFamily]);
}

/** Verify real slots, then diagnose only demonstrably equal peer panels whose
 * members and supporting context lack a separate group heading/container. */
export function nativeSemanticVisualIssues(content: NativeContent, groups: readonly SlideSemanticGroup[]): string[] {
  if (!groups.length) return [];
  const items = content.displayItems ?? [];
  const elements = new Map(content.elements.map((element) => [element.id, element]));
  const slots = (item: SlideSemanticItem) => (content.contentBindings ?? []).flatMap((binding) => {
    if (binding.sourceContentId !== item.id && !binding.sourceContentId.startsWith(`${item.id}:`)) return [];
    const element = elements.get(binding.elementId);
    if (!element || !('height' in element) || element.width <= 0 || element.height <= 0 || 'opacity' in element && element.opacity === 0
      || element.left < 0 || element.top < 0 || element.left + element.width > 1000.5 || element.top + element.height > 563) return [];
    const text = boundText(element, binding);
    const regionId = element.type === 'table' && binding.selector ? `${element.id}:${JSON.stringify(binding.selector)}` : element.id;
    return text ? [{ element, text, regionId, rect: { left: element.left, top: element.top, width: element.width, height: element.height } }] : [];
  });
  const panels = content.elements.filter((element): element is PPTShapeElement => element.type === 'shape'
    && Boolean(element.fill && element.fill !== 'transparent' && element.fill !== 'none') && element.opacity !== 0 && element.width >= 80 && element.height >= 40);
  const ownPanel = (item: SlideSemanticItem) => {
    const occupied = slots(item);
    if (!occupied.length) return;
    return panels.filter((panel) => occupied.every((slot) => contains(panel, slot.rect)))
      .sort((left, right) => left.width * left.height - right.width * right.height)[0];
  };
  const issues: string[] = [];
  for (const group of groups) {
    const overviews = items.filter((item) => bindings(item).some((binding) => binding.groupId === group.id && binding.role === 'overview'));
    const overviewSlots = overviews.flatMap(slots);
    const overviewText = overviewSlots.map((slot) => slot.text).join(' ');
    const overviewRegionIds = new Set(overviewSlots.map((slot) => slot.regionId));
    const expandedByMember = group.members.map((member) => ({ member, slots: items.filter((item) => bindings(item).some((binding) => binding.groupId === group.id
      && binding.role === 'member' && binding.memberId === member.id) && memberSupported(item, group, member))
      .flatMap(slots).filter((slot) => !overviewRegionIds.has(slot.regionId)) }));
    if (expandedByMember.some((entry) => entry.slots.length > 0)) {
      for (const { member, slots: expanded } of expandedByMember) {
        if (!hasLabel({ text: expanded.map((slot) => slot.text).join(' ') }, member.label)) {
          issues.push(`Expanded member region omits ${member.label} in ${group.label}; complete overview names cannot replace expanded membership`);
        }
      }
    }
    for (const member of group.members) {
      const memberItems = items.filter((item) => bindings(item).some((binding) => binding.groupId === group.id
        && binding.role === 'member' && binding.memberId === member.id) && memberSupported(item, group, member));
      const text = [overviewText, ...memberItems.flatMap(slots).map((slot) => slot.text)].join(' ');
      if (!text.includes(member.label)) issues.push(`Declared member ${member.label} is not visible in actual native slots for ${group.label}`);
    }
    const members = items.filter((item) => bindings(item).some((binding) => binding.groupId === group.id && binding.role === 'member'));
    const contexts = items.filter((item) => bindings(item).some((binding) => binding.groupId === group.id && binding.role === 'context'));
    // Unclassified source-backed support must not silently pass merely because
    // it omitted metadata. Exact member explanation sources stay members, and
    // another real group's members/overview are never borrowed as this context.
    const plainContexts = items.filter((item) => contexts.includes(item) || item.sourceContentIds.length > 0
      && !bindings(item).some((binding) => binding.role === 'member' || binding.role === 'overview')
      && !item.sourceContentIds.some((id) => group.members.some((member) => member.sourceContentIds.includes(id))));
    const plainMembers = members.flatMap((item) => slots(item).map((slot) => ({ ...slot, item, style: plainSectionStyle(slot.element) })))
      .filter((slot) => slot.style);
    const memberElementIds = new Set(plainMembers.map((slot) => slot.element.id));
    for (const context of plainContexts.flatMap(slots)) {
      if (memberElementIds.has(context.element.id)) continue; // One explicitly combined native paragraph is not separate peer sections.
      const style = plainSectionStyle(context.element);
      if (!style) continue;
      const peers = plainMembers.filter((member) => member.style === style
        && Math.abs(member.rect.width - context.rect.width) <= Math.max(member.rect.width, context.rect.width) * 0.1);
      if (new Set(peers.map((peer) => peer.item.id)).size < 2) continue;
      const area = region(peers.map((peer) => peer.rect));
      const center = { x: context.rect.left + context.rect.width / 2, y: context.rect.top + context.rect.height / 2 };
      // Only diagnose interleaving in a genuine multi-column, multi-row member
      // region. Independent sidebars and supporting paragraphs below it pass.
      if (Math.max(...peers.map((peer) => peer.rect.left)) - Math.min(...peers.map((peer) => peer.rect.left)) < context.rect.width * 0.5
        || Math.max(...peers.map((peer) => peer.rect.top)) - Math.min(...peers.map((peer) => peer.rect.top)) < 20
        || center.x < area.left || center.x > area.left + area.width || center.y < area.top || center.y > area.top + area.height) continue;
      const adjacent = peers.some((peer) => {
        const gapX = Math.max(0, peer.rect.left - context.rect.left - context.rect.width, context.rect.left - peer.rect.left - peer.rect.width);
        const gapY = Math.max(0, peer.rect.top - context.rect.top - context.rect.height, context.rect.top - peer.rect.top - peer.rect.height);
        return gapX <= context.rect.width * 0.15 && gapY <= 40;
      });
      if (!adjacent) continue;
      const clearContainer = panels.some((panel) => peers.every((peer) => contains(panel, peer.rect)) && !contains(panel, context.rect));
      const clearHeading = overviewSlots.some((slot) => {
        const owned = region([slot.rect, area]);
        return slot.rect.top + slot.rect.height <= area.top + 2 && area.top - slot.rect.top - slot.rect.height <= 40
          && !contains(owned, context.rect);
      });
      if (!clearContainer && !clearHeading) issues.push(`Flattened semantic hierarchy for ${group.label}: context is interleaved with equally styled member text sections without exclusive group ownership`);
    }
    const memberPanels = [...new Map(members.flatMap((item) => { const panel = ownPanel(item); return panel ? [[panel.id, panel] as const] : []; })).values()];
    const contextPanels = [...new Map(contexts.flatMap((item) => { const panel = ownPanel(item); return panel ? [[panel.id, panel] as const] : []; })).values()];
    if (memberPanels.length < 2 || !contextPanels.length) continue;
    const equalPeer = (a: PPTShapeElement, b: PPTShapeElement) => a.id !== b.id && String(a.fill).toLowerCase() === String(b.fill).toLowerCase()
      && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2 && !contains(a, b) && !contains(b, a);
    if (!contextPanels.some((context) => memberPanels.filter((member) => equalPeer(member, context)).length >= 2)) continue;
    const memberArea = region(memberPanels);
    const contextSlots = contexts.flatMap(slots);
    const clearContainer = panels.some((panel) => memberPanels.every((member) => contains(panel, member))
      && contextSlots.every((slot) => !contains(panel, slot.rect)));
    const clearHeading = overviewSlots.some((slot) => {
      const area = { left: Math.min(slot.rect.left, memberArea.left), top: slot.rect.top,
        width: Math.max(slot.rect.left + slot.rect.width, memberArea.left + memberArea.width) - Math.min(slot.rect.left, memberArea.left),
        height: memberArea.top + memberArea.height - slot.rect.top };
      return slot.rect.top + slot.rect.height <= memberArea.top + 2 && memberArea.top - slot.rect.top - slot.rect.height <= 40
        && contextSlots.every((context) => !contains(area, context.rect));
    });
    if (!clearContainer && !clearHeading) issues.push(`Flattened semantic hierarchy for ${group.label}: declared members and context occupy equal peer panels without a shared group container or exclusive heading`);
  }
  return [...new Set(issues)];
}
