import { describe, expect, it } from 'vitest';
import { failedCourseDesignAuthoringSteps } from './failed-stage-regeneration';

describe('explicit replacement of failed design authoring', () => {
  it.each(['rejected', 'invalid-output', 'response-complete'])('replaces a %s blueprint while retaining accepted upstream results and requests', (status) => {
    const saved = {
      knowledgeStructure: { status: 'validated', rawResponse: 'knowledge' },
      knowledgeStructureAttempt: { attemptsStarted: 1 },
      aiDuration: { status: 'validated', rawResponse: 'duration' },
      aiDurationAttempt: { attemptsStarted: 1 },
      teachingBlueprint: { status, rawResponse: 'first blueprint' },
      teachingBlueprintAttempt: { attemptsStarted: 1 },
    };
    expect(failedCourseDesignAuthoringSteps(saved, [])).toEqual([
      'teaching-blueprint', 'course-design-attempt:teaching-blueprint', 'design-authoring:teachingBlueprint', 'design-page-capacity',
    ]);
    expect(saved.teachingBlueprint.rawResponse).toBe('first blueprint');
  });

  it('opens a replacement for a spent request whose output could not be persisted', () => {
    expect(failedCourseDesignAuthoringSteps({ knowledgeStructureAttempt: { attemptsStarted: 1 } }, [])).toEqual([
      'course-design:knowledge-structure', 'course-design-attempt:knowledge-structure', 'design-authoring:knowledgePoints',
    ]);
  });

  it('keeps validated metadata and legacy outlines with their raw responses', () => {
    expect(failedCourseDesignAuthoringSteps({
      courseSeed: { status: 'response-complete', rawResponse: 'metadata' }, courseSeedAttempt: { attemptsStarted: 1 },
      classicOutline: { status: 'response-complete', rawResponse: 'outline' }, classicOutlineAttempt: { attemptsStarted: 1 },
    }, [{ step: 'base', status: 'completed' }, { step: 'lessonOutline', status: 'warning' }])).toEqual([]);
  });

  it('does not reset stages that failed before a provider request', () => {
    expect(failedCourseDesignAuthoringSteps({ aiDurationAttempt: { attemptsStarted: 0 } }, [])).toEqual([]);
  });

  it('replaces only the last failed spoken section and preserves earlier legacy raw responses', () => {
    const saved = { spokenSections: [
      { step: 'design-authoring:spoken-section:1', state: { complete: true, rawResponse: 'accepted first section' } },
      { step: 'course-design-attempt:spoken-section:1', state: { attemptsStarted: 1 } },
      { step: 'design-authoring:spoken-section:2', state: { complete: true, rawResponse: 'failed second section' } },
      { step: 'course-design-attempt:spoken-section:2', state: { attemptsStarted: 1 } },
    ] };
    const original = structuredClone(saved);
    expect(failedCourseDesignAuthoringSteps(saved, [])).toEqual([
      'design-authoring:spoken-section:2', 'course-design-attempt:spoken-section:2', 'course-design:spoken-section:2',
    ]);
    expect(saved).toEqual(original);
  });

  it('preserves every compiled spoken section when a later stage fails', () => {
    const saved = { spokenSections: [
      { step: 'design-authoring:spoken-section:1', state: { rawResponse: 'accepted' } },
      { step: 'course-design:spoken-section:1', state: { status: 'validated' } },
    ] };
    expect(failedCourseDesignAuthoringSteps(saved, [])).toEqual([]);
    expect(failedCourseDesignAuthoringSteps({ ...saved, teachingBlueprint: { status: 'validated' } }, [])).toEqual([]);
  });

  it('replaces the interrupted section attempt while retaining earlier compiled receipts', () => {
    expect(failedCourseDesignAuthoringSteps({ spokenSections: [
      { step: 'design-authoring:spoken-section:1', state: { rawResponse: 'accepted' } },
      { step: 'course-design:spoken-section:1', state: { status: 'validated' } },
      { step: 'course-design-attempt:spoken-section:2', state: { attemptsStarted: 1 } },
      { step: 'course-design-attempt:spoken-section:3', state: { attemptsStarted: 0 } },
    ] }, [])).toEqual([
      'design-authoring:spoken-section:2', 'course-design-attempt:spoken-section:2', 'course-design:spoken-section:2',
    ]);
  });
});
