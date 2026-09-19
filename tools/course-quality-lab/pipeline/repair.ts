import { fingerprint } from "./fingerprint";
import type { PipelineIssue } from "./types";

export type RepairScope = "target" | "page" | "module" | "section";
export type RepairDecisionAction = "repair" | "rediagnose" | "accept" | "unresolved";

export interface RepairSnapshot {
  artifactFingerprint: string;
  issues: readonly PipelineIssue[];
  scope: RepairScope;
  recordedAt: string;
}

export interface RepairDecision {
  action: RepairDecisionAction;
  scope: RepairScope;
  reason: "passed" | "progress" | "repeated-artifact" | "no-progress" | "regression" | "exhausted-scope";
}

const SCOPES: readonly RepairScope[] = ["target", "page", "module", "section"];

function blockingIssues(snapshot: RepairSnapshot): readonly PipelineIssue[] {
  return snapshot.issues.filter((issue) => issue.severity === "blocking");
}

function issueSignature(snapshot: RepairSnapshot): string {
  return fingerprint(blockingIssues(snapshot).map((issue) => ({
    category: issue.category,
    ownerModule: issue.ownerModule,
    target: issue.target,
    evidence: issue.evidence,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function widerScope(scope: RepairScope): RepairScope | undefined {
  return SCOPES[SCOPES.indexOf(scope) + 1];
}

/**
 * State-driven repair policy. It allows as many improving repairs as necessary,
 * but repeated artifacts, unchanged issues, and regressions widen the repair
 * boundary. Only a repeated failure at section scope becomes unresolved.
 */
export class RepairStrategy {
  private readonly history: RepairSnapshot[] = [];

  decide(snapshot: RepairSnapshot): RepairDecision {
    const blocking = blockingIssues(snapshot);
    if (blocking.length === 0) {
      this.history.push(snapshot);
      return { action: "accept", scope: snapshot.scope, reason: "passed" };
    }

    const priorAtScope = this.history.filter((item) => item.scope === snapshot.scope);
    const priorArtifact = this.history.find((item) =>
      item.artifactFingerprint === snapshot.artifactFingerprint,
    );
    const previous = this.history.at(-1);
    const repeatedIssues = previous && issueSignature(previous) === issueSignature(snapshot);
    const bestBlockingCount = this.history.length > 0
      ? Math.min(...this.history.map((item) => blockingIssues(item).length))
      : Number.POSITIVE_INFINITY;
    const regressed = blocking.length > bestBlockingCount;
    this.history.push(snapshot);

    const stalled = Boolean(priorArtifact || repeatedIssues || regressed);
    if (!stalled) {
      return { action: "repair", scope: snapshot.scope, reason: "progress" };
    }

    const nextScope = widerScope(snapshot.scope);
    if (!nextScope) {
      return { action: "unresolved", scope: snapshot.scope, reason: "exhausted-scope" };
    }
    const reason = regressed
      ? "regression"
      : priorArtifact || priorAtScope.some((item) =>
          item.artifactFingerprint === snapshot.artifactFingerprint)
        ? "repeated-artifact"
        : "no-progress";
    return { action: "rediagnose", scope: nextScope, reason };
  }

  snapshots(): readonly RepairSnapshot[] {
    return [...this.history];
  }
}

