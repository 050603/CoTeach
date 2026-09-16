import { describe, expect, it } from 'vitest';
import { POST as canonicalPOST } from '../openmaic/transcription/route';
import { POST as legacyPOST } from './route';

describe('/api/transcription compatibility route', () => {
  it('uses the canonical OpenMAIC transcription handler', () => {
    expect(legacyPOST).toBe(canonicalPOST);
  });
});
