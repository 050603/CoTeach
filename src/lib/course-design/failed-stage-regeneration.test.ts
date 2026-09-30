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
});
