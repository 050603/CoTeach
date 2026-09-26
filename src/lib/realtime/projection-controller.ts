import { browserRandomUUID } from '@/lib/browser/random-uuid';
import type { CourseUiState } from '@/lib/session/types';

// Deliberately scoped to this loaded page: duplicated tabs must not share control.
let clientId: string | undefined;
export function projectionClientId(): string {
  return clientId ??= browserRandomUUID();
}

export function ownsProjection(uiState: CourseUiState | undefined): boolean {
  return uiState?.projectionController?.clientId === projectionClientId();
}
