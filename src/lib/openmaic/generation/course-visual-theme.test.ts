import { describe, expect, it } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { Scene } from '@openmaic/lib/types/stage';
import {
  auditCourseVisualConsistency,
  formatOpenMaicWebsiteReferenceProfile,
  normalizeCourseVisualTheme,
  OPENMAIC_BLUE_COURSE_THEME,
} from './course-visual-theme';

const outline: SceneOutline = {
  id: 'page-1',
  type: 'slide',
  title: '核心关系',
  description: '解释概念之间的映射关系。',
  keyPoints: ['事实一', '事实二'],
  order: 0,
  generationPurpose: 'knowledge-teaching',
};

const text = (
  id: string,
  content: string,
  top: number,
  color: string,
  height = 50,
): PPTElement => ({
  id,
  type: 'text',
  left: 70,
  top,
  width: 860,
  height,
  rotate: 0,
  content: `<p style="font-size:20px;color:${color}">${content}</p>`,
  defaultFontName: 'Microsoft YaHei',
  defaultColor: color,
});

function scene(id: string, background: string, elements: PPTElement[]): Scene {
  return {
    id,
    stageId: 'stage',
    outlineId: id,
    type: 'slide',
    title: id,
    order: 0,
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${id}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements,
        background: { type: 'solid', color: background },
      },
    },
    actions: [],
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Scene;
}

function referenceElements(): PPTElement[] {
  return [
    text('title', '核心关系', 50, '#1E3A8A', 55),
    text('subtitle', '从概念定义到实际映射', 115, '#64748B', 35),
    text('claim', '事实一说明概念的定义与适用条件，事实二解释两个概念如何建立映射。', 180, '#334155', 95),
    {
      id: 'connector', type: 'line', left: 190, top: 315, width: 620,
      start: [0, 0], end: [620, 0], points: ['', ''], style: 'solid', color: '#1E40AF',
    },
    text('case', '案例把已有条件、关系方向、判断依据和结论逐一对应，学生可以沿着连线检查每一步。', 350, '#334155', 95),
    text('conclusion', '结论：映射成立必须同时满足定义边界与证据条件。', 470, '#1E3A8A', 50),
  ];
}

describe('OpenMAIC visual reference audit', () => {
  it('uses the measured v1.0.2 navy/slate reference roles', () => {
    expect(normalizeCourseVisualTheme({ background: '#FFF0E0' }, 'course'))
      .toEqual(OPENMAIC_BLUE_COURSE_THEME);
    expect(OPENMAIC_BLUE_COURSE_THEME).toMatchObject({
      primary: '#1E3A8A',
      secondary: '#1E40AF',
      surface: '#F1F5F9',
      text: '#334155',
      mutedText: '#64748B',
    });
  });

  it('describes a shared visual system without turning every page into a table template', () => {
    const profile = formatOpenMaicWebsiteReferenceProfile();
    expect(profile).toContain('#1E3A8A/#1E40AF');
    expect(profile).toContain('#EFF6FF');
    expect(profile).toContain('distinct explanatory subtitle when it adds useful orientation');
    expect(profile).toContain('semantic-fit check');
    expect(profile).toContain('Do not pad the page to a character or element quota');
    expect(profile).toContain('goal-action-result relations spatially explicit');
    expect(profile).toContain('native-table cell must render at 16px or larger');
    expect(profile).toContain('Never solve fit by shrinking teaching text below 16px');
    expect(profile).toContain('emit it as a separate 18-20px slate text element');
    expect(profile).toContain('native tables only for a genuine two-dimensional comparison');
    expect(profile).toContain('Vary the semantic composition across pages');
    expect(profile).not.toContain('160-230');
    expect(profile).not.toContain('at least eight editable elements');
    expect(profile).not.toContain('every page must use a table');
  });

  it('accepts white or light gray-blue canvases with navy titles, subtitles and semantic structure', () => {
    const result = auditCourseVisualConsistency(
      [outline],
      [scene('page-1', '#F8FAFC', referenceElements())],
    );
    expect(result).toMatchObject({
      expectedBackground: 'white-or-light-gray-blue',
      slideCount: 1,
      matchingBackgroundCount: 1,
      deepBlueTitleCount: 1,
      subtitleCount: 1,
      semanticStructureRequiredCount: 1,
      semanticStructurePageCount: 1,
      paletteDeviationCount: 0,
      passed: true,
    });
  });

  it('reports the retired blue palette instead of rewriting a generated page', () => {
    const legacy = referenceElements().map((element) => ({ ...element })) as PPTElement[];
    legacy[0] = text('title', '核心关系', 50, '#4472C4', 55);
    const generated = scene('page-1', '#FFF5E6', legacy);
    const result = auditCourseVisualConsistency([outline], [generated]);

    expect(generated.content.type === 'slide' && generated.content.canvas.background)
      .toEqual({ type: 'solid', color: '#FFF5E6' });
    expect(result).toMatchObject({
      matchingBackgroundCount: 0,
      deepBlueTitleCount: 0,
      passed: false,
    });
    expect(result.paletteDeviationCount).toBeGreaterThan(0);
  });

  it('detects excessive cross-page layout repetition', () => {
    const outlines = Array.from({ length: 4 }, (_, index) => ({
      ...outline,
      id: `page-${index + 1}`,
      order: index,
    }));
    const scenes = outlines.map((item) => scene(item.id, '#FFFFFF', referenceElements()));
    const result = auditCourseVisualConsistency(outlines, scenes);
    expect(result.repeatedLayoutPageCount).toBe(2);
    expect(result.passed).toBe(false);
  });
});
