// Backward-compatible endpoint for classroom pages that were opened before the
// OpenMAIC API routes moved under /api/openmaic. Keep this alias so an active
// lesson can submit an in-memory recording without forcing every student to
// reload the page first.
export { maxDuration, POST } from '../openmaic/transcription/route';
