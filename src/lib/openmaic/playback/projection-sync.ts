export interface AppliedProjectedPlayback {
  engine: object;
  version: number;
}

/** Re-renders must not rewind a running engine to an already-applied cursor. */
export function shouldApplyProjectedPlayback(
  previous: AppliedProjectedPlayback | null,
  engine: object,
  version: number,
): boolean {
  return !previous || previous.engine !== engine || version > previous.version;
}
