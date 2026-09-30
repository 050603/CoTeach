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
  it('refuses the package correction request after an invalid first response', async () => {
    const aiCall = vi.fn().mockResolvedValue('{"projectInfo":{},"milestones":[]}');
    await expect(generateSceneContent(outline, aiCall)).rejects.toMatchObject({ code: 'PBL_FIRST_PASS_VALIDATION_FAILED' });
    expect(aiCall).toHaveBeenCalledOnce();
  });
  it('does not start the legacy agentic fallback when v2 is disabled', async () => {
    vi.stubEnv('PBL_V2_DISABLED', 'true');
    const aiCall = vi.fn();
    await expect(generateSceneContent(outline, aiCall)).rejects.toThrow('cannot fall back');
    expect(aiCall).not.toHaveBeenCalled();
  });
});
