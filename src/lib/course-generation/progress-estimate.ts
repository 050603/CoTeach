export function estimateRemainingSeconds(input: {
  startedAt: Date;
  scenePhaseStartedAt: number | null;
  scenePhaseInitialGenerated: number;
  scenesGenerated: number;
  totalScenes: number;
  progress: number;
  baselineSeconds: number;
  step?: string;
  nowMs?: number;
}): number | null {
  const now = input.nowMs ?? Date.now();
  const elapsed = Math.max(1, (now - input.startedAt.getTime()) / 1_000);
  const observedScenes = Math.max(0, input.scenesGenerated - input.scenePhaseInitialGenerated);
  if (observedScenes > 0 && input.totalScenes > input.scenesGenerated) {
    const phaseElapsed = input.scenePhaseStartedAt
      ? Math.max(1, (now - input.scenePhaseStartedAt) / 1_000)
      : elapsed;
    const observedWallSecondsPerPage = phaseElapsed / observedScenes;
    const secondsPerPage = Math.max(25, observedWallSecondsPerPage);
    return Math.max(45, Math.round((input.totalScenes - input.scenesGenerated) * secondsPerPage + 60));
  }
  if (input.step === "generating_scenes" && observedScenes === 0) return null;
  if (input.progress >= 90) return Math.max(20, Math.round(elapsed * 0.08));
  return Math.max(45, Math.round(input.baselineSeconds - elapsed));
}
