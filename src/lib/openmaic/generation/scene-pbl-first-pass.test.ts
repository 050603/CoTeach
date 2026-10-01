import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateSceneContent } from './scene-generator';
import { validPBLResponse } from '../../../../packages/@openmaic/generation/test/scene-fixtures';
import type { SceneOutline } from '../types/generation';
const outline: SceneOutline = { id: 'pbl', type: 'pbl', title: 'CSV Data Analyzer', description: 'Build a CSV analysis project.', keyPoints: ['CSV'], order: 0, pblConfig: { projectTopic: 'CSV Data Analyzer', projectDescription: 'Build a CSV analysis project.', targetSkills: ['CSV'], issueCount: 2 } };
afterEach(() => vi.unstubAllEnvs());
describe('PBL shared durable authoring adapter', () => {
  it('authors through the supplied stage call without requiring a direct language model', async () => {
    const aiCall = vi.fn().mockResolvedValue(validPBLResponse());
    const result = await generateSceneContent(outline, aiCall, { targetLanguage: 'en-US' });
    expect(result).toMatchObject({ projectV2: { title: 'CSV Data Analyzer project' } });
    expect(aiCall).toHaveBeenCalledOnce();
  });
  it('reports an unusable activity structure after its sole authoring call', async () => {
    const aiCall = vi.fn().mockResolvedValue('{"projectInfo":{},"milestones":[]}');
    await expect(generateSceneContent(outline, aiCall)).rejects.toMatchObject({
      name: 'PlannerV2Error', message: expect.stringContaining('milestones must be a non-empty array'),
    });
    expect(aiCall).toHaveBeenCalledOnce();
  });
  it('returns the first authored activity without rejecting missing gains or teaching rubrics', async () => {
    const response = JSON.parse(validPBLResponse());
    response.projectInfo.gains = ['Inspect a DataFrame'];
    delete response.milestones[0].briefing;
    delete response.milestones[0].completionCriteria;
    delete response.milestones[0].debrief;
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify(response));
    const result = await generateSceneContent(outline, aiCall);
    expect(result).toMatchObject({ projectV2: {
      title: 'CSV Data Analyzer project', gains: ['Inspect a DataFrame'],
      milestones: [{ microtasks: [{ description: response.milestones[0].microtasks[0].description }] }, {}],
    } });
    expect(aiCall).toHaveBeenCalledOnce();
  });
  it('does not start the legacy agentic fallback when v2 is disabled', async () => {
    vi.stubEnv('PBL_V2_DISABLED', 'true');
    const aiCall = vi.fn();
    await expect(generateSceneContent(outline, aiCall)).rejects.toThrow('cannot fall back');
    expect(aiCall).not.toHaveBeenCalled();
  });
});
