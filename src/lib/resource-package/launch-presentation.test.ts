import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildAdaptedLaunchPages, writeClassroomPresentation } from './launch-presentation';
import { emptyResourcePackageDraft } from './types';
import { readPresentationEvidence } from './compatibility';

async function sourcePages(pages: string[][]) {
  const zip = new JSZip();
  pages.forEach((lines, i) => zip.file(`ppt/slides/slide${i + 1}.xml`, `<p:sld>${lines.map((text) => `<a:t>${text}</a:t>`).join('')}</p:sld>`));
  zip.file('ppt/slides/_rels/slide3.xml.rels', '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org/lesson?a=1&amp;b=2" TargetMode="External"/></Relationships>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('authorized launch lecture copy', () => {
  it('preserves source page order, concrete project requirements and reference links', async () => {
    const source = await sourcePages([['原始标题'], ['小组项目：做什么', '项目任务', '设计一堂面向特定年级的AI体验课', '成果形式', '10页PPT演示文稿', '必要要求', '包含动手实践环节', '组队建议', '建议每组约5人'], ['相关资源', '学习理论资料', '用于查阅公开资料', '打开资源 ↗']]);
    const draft = { ...emptyResourcePackageDraft(), courseName: '已确认标题', drivingQuestion: '怎样设计适合学习者的活动？', expectedOutcome: '提交个人终稿' };
    const pages = buildAdaptedLaunchPages(draft, source);
    expect(pages.map((page) => page.title)).toEqual(['已确认标题', '个人项目：做什么', '相关资源']);
    expect(pages[1].items.map((item) => item.text)).toEqual(expect.arrayContaining(['设计一堂面向特定年级的AI体验课', '10页PPT演示文稿', '包含动手实践环节']));
    expect(JSON.stringify(pages)).not.toContain('每组约5人');
    expect(pages[2].items[0].url).toBe('https://example.org/lesson?a=1&b=2');
    const output = await writeClassroomPresentation(pages, draft.courseName);
    expect(readPresentationEvidence(output)).toHaveLength(3);
    const zip = await JSZip.loadAsync(output);
    expect(await zip.file('ppt/slides/_rels/slide3.xml.rels')!.async('string')).toContain('https://example.org/lesson');
    expect(readPresentationEvidence(source)[0].quote).toBe('原始标题');
  });
  it('uses the actual source scenario instead of inserting a canned subject-specific explanation', async () => {
    const source = await sourcePages([['标题'], ['情境导入', '观察校园节能数据，说明证据支持哪种改进。', '人工智能教育导论']]);
    const pages = buildAdaptedLaunchPages(emptyResourcePackageDraft(), source);
    expect(pages[1].items[0].text).toBe('观察校园节能数据，说明证据支持哪种改进。');
    expect(pages[1].items[0].text).not.toContain('认知负荷');
  });
});
