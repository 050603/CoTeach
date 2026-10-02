import { describe, expect, it } from 'vitest';
import { canonicalClassroomOutlines } from './classroom-editor-outlines';
import { classroomEditOutlinesFixture } from '@openmaic/lib/server/classroom-edit-outlines-fixture';
import { resolveSceneOutline } from '@openmaic/lib/agent/client/resolve-scene-outline';

describe('canonical teaching outline hydration', () => {
  it('matches exact legacy scene IDs while retaining canonical prose and projecting current UI metadata', () => {
    const { scene, outline } = classroomEditOutlinesFixture();
    delete scene.outlineId;
    scene.id = outline.id;
    scene.title = '教师修改的标题';
    scene.order = 10;
    const hydrated = canonicalClassroomOutlines([outline], [scene]);
    expect(hydrated).toEqual([outline]);
    expect(resolveSceneOutline(scene, hydrated)).toMatchObject({ title: scene.title, order: 10,
      teachingBrief: outline.teachingBrief, description: outline.description });
  });

  it('does not borrow a missing page responsibility from the same numerical order', () => {
    const { scene, outline } = classroomEditOutlinesFixture();
    scene.outlineId = 'missing';
    expect(canonicalClassroomOutlines([outline], [scene])).toEqual([]);
    expect(canonicalClassroomOutlines(undefined, [scene])).toEqual([]);
  });
});
