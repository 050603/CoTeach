import { describe, expect, it } from 'vitest';
import { formatCourseVisualStyle, resolveCourseVisualStyle } from './course-visual-style';

describe('course visual style', () => {
  it('is stable for every page generated from the same course request', () => {
    expect(resolveCourseVisualStyle('高中物理：动量守恒'))
      .toEqual(resolveCourseVisualStyle('高中物理：动量守恒'));
  });

  it('uses the OpenMAIC baseline theme for generated course slides', () => {
    const style = resolveCourseVisualStyle('初中生物生态系统课程');
    expect(style.id).toBe('openmaic-baseline');
    expect(style.theme).toMatchObject({
      backgroundColor: '#FFFFFF',
      fontColor: '#333333',
      fontName: 'Microsoft YaHei',
      themeColors: ['#5B9BD5', '#ED7D31', '#A5A5A5', '#FFC000', '#4472C4'],
    });
    expect(formatCourseVisualStyle(style)).toContain('OpenMAIC baseline');
    expect(formatCourseVisualStyle(style)).toContain('one clear visual focal point');
  });
});
