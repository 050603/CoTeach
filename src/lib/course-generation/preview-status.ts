/** Live generation metadata; intentionally separate from server-only loading. */
export interface GenerationPreviewStatus {
  contentVersion: string;
  active: boolean;
  jobStatus: string;
  scenes: Record<string, {
    status: 'preparing' | 'ready' | 'failed';
    phase?: 'audio' | 'alignment';
    error?: string;
  }>;
}
