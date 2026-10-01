import { describe, expect, it, vi } from 'vitest';
import { generatePBLV2ProjectSingleCall, type AICallFn } from '@openmaic/generation';
import { pblPlannerInput, validPBLResponse } from './scene-fixtures.js';

describe('re-seated PBL single-call planner', () => {
  it('hydrates and normalizes a project from a canned AICallFn response', async () => {
    const aiCall: AICallFn = vi.fn(async () => validPBLResponse());
    const project = await generatePBLV2ProjectSingleCall(pblPlannerInput(), aiCall);

    expect(project).toMatchObject({
      title: 'CSV Data Analyzer project',
      status: 'active',
      uiPhase: 'hero',
      language: 'en-US',
    });
    expect(project.roles[0]).toMatchObject({ type: 'instructor', name: 'CSV Analysis Coach' });
    expect(project.roles[0].id).toMatch(/^role_/);
    expect(project.milestones[0].status).toBe('active');
    expect(project.milestones[0].microtasks[0].status).toBe('in_progress');
    expect(project.threads[0].agentId).toBe(project.roles[0].id);
    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  it('keeps an executable first draft with missing teaching and cosmetic fields for teacher review', async () => {
    const response = JSON.parse(validPBLResponse());
    delete response.projectInfo.learningObjective;
    response.projectInfo.gains = ['Inspect a DataFrame'];
    delete response.instructorRole.description;
    delete response.milestones[0].briefing;
    delete response.milestones[0].completionCriteria;
    delete response.milestones[0].debrief;
    const aiCall: AICallFn = vi.fn(async () => JSON.stringify(response));

    const project = await generatePBLV2ProjectSingleCall(pblPlannerInput(), aiCall);
    expect(project.status).toBe('active');
    expect(project.gains).toEqual(['Inspect a DataFrame']);
    expect(project.learningObjective).toBeUndefined();
    expect(project.milestones[0].briefing).toBe('');
    expect(project.milestones[0].microtasks[0].description)
      .toBe(response.milestones[0].microtasks[0].description);
    expect(aiCall).toHaveBeenCalledOnce();
    expect(project.milestones.every((milestone) => !milestone.synthesisCheck)).toBe(true);
  });

  it('retains all authored tasks, teaching text, references and synthesis concepts', async () => {
    const response = JSON.parse(validPBLResponse());
    const sourceText = 'CSV headers: date,region,revenue. Keep missing values visible.\n'.repeat(80);
    response.milestones[0].microtasks[0].description = sourceText;
    response.milestones[0].documents = [{
      title: 'Source sample', content: sourceText, docType: 'reference',
    }];
    response.milestones.push(...structuredClone(response.milestones));
    response.milestones.forEach((milestone: { coreConcept?: string }, i: number) => {
      milestone.coreConcept = `Authored concept ${i}`;
    });
    const aiCall: AICallFn = vi.fn(async () => JSON.stringify(response));

    const project = await generatePBLV2ProjectSingleCall(pblPlannerInput(), aiCall);
    expect(project.milestones).toHaveLength(4);
    expect(project.milestones[0].microtasks[0].description).toBe(sourceText.trim());
    expect(project.milestones[0].documents?.[0]).toMatchObject({
      title: 'Source sample', content: sourceText.trim(), docType: 'reference',
    });
    expect(project.milestones.map((milestone) => milestone.synthesisCheck?.coreConcept))
      .toEqual(['Authored concept 0', 'Authored concept 1', 'Authored concept 2', 'Authored concept 3']);
    expect(aiCall).toHaveBeenCalledOnce();
  });

  it('honors an explicit learner tier without regenerating the author’s activities', async () => {
    const input = pblPlannerInput();
    input.user = { bio: 'I am an advanced learner.' };
    const response = JSON.parse(validPBLResponse());
    response.projectInfo.proficiency = 'beginner';
    const aiCall: AICallFn = vi.fn(async () => JSON.stringify(response));

    const project = await generatePBLV2ProjectSingleCall(input, aiCall);
    expect(project.proficiency).toBe('advanced');
    expect(project.milestones[0].microtasks[0].description)
      .toBe(response.milestones[0].microtasks[0].description);
    expect(aiCall).toHaveBeenCalledOnce();
  });

  it('runs an authored roleplay without a cosmetic visual or fixed three-stage content rubric', async () => {
    const input = pblPlannerInput();
    input.outline.pblConfig!.scenarioRoleplay = true;
    const response = JSON.parse(validPBLResponse());
    response.scenario = {
      setting: 'Discuss which CSV records to keep.',
      characters: [
        { name: 'Analyst', persona: 'Wants a clear audit trail.' },
        { name: 'Reviewer', persona: 'Wants to retain anomalous rows.' },
      ],
    };
    response.milestones.forEach((milestone: { scenarioStage?: string }) => {
      milestone.scenarioStage = 'roleplay';
    });
    const aiCall: AICallFn = vi.fn(async () => JSON.stringify(response));

    const project = await generatePBLV2ProjectSingleCall(input, aiCall);
    expect(project.scenario?.characters.map(({ name, persona }) => ({ name, persona })))
      .toEqual(response.scenario.characters);
    expect(project.scenario?.sceneVisual).toBeUndefined();
    expect(project.milestones.map((milestone) => milestone.scenarioStage))
      .toEqual(['roleplay', 'roleplay']);
    expect(aiCall).toHaveBeenCalledOnce();
  });

  it.each([
    { response: 'not JSON', issue: 'response was not a JSON object' },
    { response: '[]', issue: 'response was not a JSON object' },
    { response: '{"milestones":[]}', issue: 'milestones must be a non-empty array' },
    { response: '{"milestones":[null]}', issue: 'milestones[0] must be an object' },
    { response: '{"milestones":[{"microtasks":{}}]}', issue: 'microtasks must be a non-empty array' },
    { response: '{"milestones":[{"microtasks":[null]}]}', issue: 'microtasks[0] must be an object' },
    { response: '{"milestones":[{"microtasks":[{"title":123}]}]}', issue: 'title must be a string' },
    { response: '{"milestones":[{"microtasks":[{"hints":{}}]}]}', issue: 'hints must be an array of strings' },
    { response: '{"projectInfo":{"proficiency":["beginner"]},"milestones":[{"microtasks":[{}]}]}', issue: 'proficiency must be beginner' },
  ])('fails once on an unusable runtime shape: $issue', async ({ response, issue }) => {
    const aiCall = vi.fn<AICallFn>().mockResolvedValueOnce(response).mockResolvedValueOnce(validPBLResponse());
    await expect(generatePBLV2ProjectSingleCall(pblPlannerInput(), aiCall)).rejects.toMatchObject({
      name: 'PlannerV2Error', message: expect.stringContaining(issue),
    });
    expect(aiCall).toHaveBeenCalledOnce();
  });

  it('does not degrade a requested but unrunnable roleplay into an ordinary project', async () => {
    const input = pblPlannerInput();
    input.outline.pblConfig!.scenarioRoleplay = true;
    const aiCall: AICallFn = vi.fn(async () => validPBLResponse());
    await expect(generatePBLV2ProjectSingleCall(input, aiCall)).rejects.toMatchObject({
      name: 'PlannerV2Error', message: expect.stringContaining('scenario must be an object'),
    });
    expect(aiCall).toHaveBeenCalledOnce();
  });
});
