/**
 * PBL v2 — Single-call Planner
 *
 * A single-shot alternative to the agentic tool-calling loop in
 * `./planner.ts`. The LLM is asked to emit ONE JSON object describing the
 * whole project (mirroring the slide-content generation pattern:
 * `AICallFn` with no tools → `parseJsonResponse` → deterministic
 * post-processing). The same `PBLProjectV2` is produced, so this is a
 * package-owned project output is preserved across the re-seat.
 *
 * Why: the loop needs ~20-40 ordered, mutually-gated tool calls to
 * succeed; any stall, stray narrative turn, or skipped
 * `mark_design_complete` aborts the whole run. A single structured
 * output collapses that failure surface to one call + one JSON parse.
 *
 * All the deterministic hydration (ids / status / order / assignee /
 * thread bootstrap / proficiency re-seat) and post-processing
 * (`normalizeProjectRuntime`) uses the same runtime helpers as the loop path.
 */

import { parseJsonResponse } from '../json-repair.js';
import { noopGenerationLogger } from '../logger.js';
import type { AICallFn } from '../pipeline-types.js';
import { normalizeProjectRuntime } from './operations/kernel/progress.js';
import {
  PlannerV2Error,
  SCENARIO_SCHEMA_VERSION,
  emptyProject,
  buildPlannerSystemPrompt,
  newId,
  instructorProjectAnchor,
  applyPlannerProficiency,
  type PlannerV2Callbacks,
} from './planner-core.js';

import type {
  PBLProjectV2,
  PBLPlannerV2Input,
  PBLMilestone,
  PBLMicrotask,
  PBLRole,
  PBLScenarioConfig,
  PBLScenarioCharacter,
  PBLSceneVisual,
  PBLDocument,
} from './types.js';

const SINGLE_CALL_PROMPT = 'planner-single-call-system';
const SCENARIO_PROMPT = 'planner-scenario-single-call-system';

/** Narrow call seam used by the untooled single-call planner. */
export type PlannerSingleCallFn = AICallFn;

function buildSingleCallUserPrompt(scenarioRoleplay: boolean): string {
  const sharedChecklist = [
    'projectInfo has non-empty title, description, learningObjective, 3-5 gains, and the exact requested proficiency',
    'instructorRole.name is non-empty',
    'milestones is a non-empty array',
    'every milestone has title, briefing, completionCriteria, debrief, and at least one microtask',
    'every microtask has a non-empty title',
  ];
  const scenarioChecklist = scenarioRoleplay
    ? [
        'scenario exists with setting, at least one character (name/persona/situation), and sceneVisual.caption plus emoji motifs',
        'milestones follow the exact skeleton: first scenarioStage "prep", last "wrapup", and at least one middle "roleplay"',
        'every roleplay microtask has non-empty successWhen',
      ]
    : [];
  const checklist = [...sharedChecklist, ...scenarioChecklist]
    .map((item) => `- ${item}`)
    .join('\n');

  return [
    'Design the PBL project now. Output the single JSON object described in the system prompt — no prose, no code fences.',
    '',
    'In this first response, author the complete project with these teaching details:',
    checklist,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// LLM output shape
// ---------------------------------------------------------------------------

/** The JSON object the single LLM call must produce. Only the fields the
 *  model actually decides — ids / status / order / assignee / timestamps /
 *  threads are all assigned by code during hydration. Milestones nest
 *  their microtasks (no milestoneId references needed). */
interface PlannerLLMOutput {
  projectInfo?: {
    title?: string;
    description?: string;
    learningObjective?: string;
    gains?: string[];
    proficiency?: 'beginner' | 'intermediate' | 'advanced';
  };
  instructorRole?: {
    name?: string;
    description?: string;
    systemPrompt?: string;
  };
  /** SCENARIO ONLY. Present when the outline opted into role-play; hydrated
   *  onto `project.scenario`. Ordinary projects omit it. */
  scenario?: {
    setting?: string;
    goal?: string;
    rules?: string;
    learnerRole?: string;
    characters?: Array<{
      name?: string;
      persona?: string;
      situation?: string;
      boundaries?: string;
      openingLine?: string;
    }>;
    sceneVisual?: {
      caption?: string;
      bg1?: string;
      bg2?: string;
      accent?: string;
      motifs?: string[];
    };
  };
  milestones?: Array<{
    title?: string;
    description?: string;
    briefing?: string;
    completionCriteria?: string;
    debrief?: string;
    coreConcept?: string;
    /** SCENARIO ONLY. Stage role in the prep → roleplay → wrapup skeleton. */
    scenarioStage?: 'prep' | 'roleplay' | 'wrapup';
    documents?: Array<{
      title?: string;
      content?: string;
      docType?: PBLDocument['docType'];
    }>;
    microtasks?: Array<{
      title?: string;
      description?: string;
      hints?: string[];
      // SCENARIO ONLY beat fields (roleplay milestones).
      successWhen?: string;
      characterObjective?: string;
      skillFocus?: string;
      learnerBrief?: string;
      narration?: string;
      completionCriteria?: string;
    }>;
  }>;
}

/** LLM JSON has no runtime type guarantees (`parseJsonResponse` only
 *  confirms it parsed). Trim a parsed value ONLY if it is actually a string;
 *  a non-string scalar (e.g. `title: 123`) becomes '' instead of throwing a
 *  raw `TypeError` from `.trim()`. Wrong field types are rejected before
 *  hydration; absent authoring fields remain empty. */
function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Coerce an unknown value to a clean `string[]`: non-array → `[]`,
 *  non-string entries dropped, trimmed, empties removed. */
function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(toText).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Validation (post-parse, pre-hydrate)
// ---------------------------------------------------------------------------

/** Reject only shapes the project runtime cannot consume. Missing teaching
 * prose, gains, cosmetic details, or rubric coverage are left for the teacher
 * to review; they never commission a corrected model draft. */
function validateLLMOutput(
  parsed: PlannerLLMOutput | null,
  scenarioRoleplay: boolean,
): string[] {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord(parsed)) return ['response was not a JSON object'];
  const gaps: string[] = [];
  const textFields = (record: Record<string, unknown>, fields: string[], path: string) => {
    for (const field of fields) {
      if (record[field] != null && typeof record[field] !== 'string') {
        gaps.push(`${path}.${field} must be a string`);
      }
    }
  };
  const stringList = (value: unknown, path: string) => {
    if (value == null) return;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      gaps.push(`${path} must be an array of strings`);
    }
  };
  for (const field of ['projectInfo', 'instructorRole']) {
    const value = parsed[field];
    if (value != null && !isRecord(value)) gaps.push(`${field} must be an object`);
  }
  if (isRecord(parsed.projectInfo)) {
    textFields(parsed.projectInfo, ['title', 'description', 'learningObjective'], 'projectInfo');
    stringList(parsed.projectInfo.gains, 'projectInfo.gains');
    if (parsed.projectInfo.proficiency != null &&
      !['beginner', 'intermediate', 'advanced'].includes(parsed.projectInfo.proficiency as string)) {
      gaps.push('projectInfo.proficiency must be beginner | intermediate | advanced');
    }
  }
  if (isRecord(parsed.instructorRole)) {
    textFields(parsed.instructorRole, ['name', 'description', 'systemPrompt'], 'instructorRole');
  }

  if (!Array.isArray(parsed.milestones) || parsed.milestones.length === 0) {
    gaps.push('milestones must be a non-empty array');
  }
  const milestones = Array.isArray(parsed.milestones) ? parsed.milestones : [];
  milestones.forEach((milestone, i) => {
    const path = `milestones[${i}]`;
    if (!isRecord(milestone)) {
      gaps.push(`${path} must be an object`);
      return;
    }
    textFields(milestone,
      ['title', 'description', 'briefing', 'completionCriteria', 'debrief', 'coreConcept'], path);
    if (milestone.scenarioStage != null &&
      !['prep', 'roleplay', 'wrapup'].includes(milestone.scenarioStage as string)) {
      gaps.push(`${path}.scenarioStage must be prep | roleplay | wrapup`);
    }
    if (!Array.isArray(milestone.microtasks) || milestone.microtasks.length === 0) {
      gaps.push(`${path}.microtasks must be a non-empty array`);
    }
    const tasks = Array.isArray(milestone.microtasks) ? milestone.microtasks : [];
    tasks.forEach((task, j) => {
      const taskPath = `${path}.microtasks[${j}]`;
      if (!isRecord(task)) {
        gaps.push(`${taskPath} must be an object`);
        return;
      }
      textFields(task, ['title', 'description', 'successWhen', 'characterObjective',
        'skillFocus', 'learnerBrief', 'narration', 'completionCriteria'], taskPath);
      stringList(task.hints, `${taskPath}.hints`);
    });
    if (milestone.documents != null) {
      if (!Array.isArray(milestone.documents)) gaps.push(`${path}.documents must be an array`);
      else milestone.documents.forEach((document, j) => {
        const documentPath = `${path}.documents[${j}]`;
        if (!isRecord(document)) gaps.push(`${documentPath} must be an object`);
        else {
          textFields(document, ['title', 'content'], documentPath);
          if (document.docType != null &&
            !['markdown', 'reference', 'starter_file'].includes(document.docType as string)) {
            gaps.push(`${documentPath}.docType must be markdown | reference | starter_file`);
          }
        }
      });
    }
  });

  // A live role-play needs a usable cast and an actual stage hosting it.
  // These are routing requirements, not a prescribed teaching skeleton.
  if (scenarioRoleplay || parsed.scenario != null) {
    const scenario = parsed.scenario;
    if (!isRecord(scenario)) gaps.push('scenario must be an object for a role-play project');
    else {
      textFields(scenario, ['setting', 'goal', 'rules', 'learnerRole'], 'scenario');
      const characters = Array.isArray(scenario.characters) ? scenario.characters : [];
      if (characters.length === 0) gaps.push('scenario.characters must be a non-empty array');
      characters.forEach((character, i) => {
        const path = `scenario.characters[${i}]`;
        if (!isRecord(character)) gaps.push(`${path} must be an object`);
        else {
          textFields(character, ['name', 'persona', 'situation', 'boundaries', 'openingLine'], path);
          if (!toText(character.name) || !toText(character.persona)) {
            gaps.push(`${path} needs name and persona for the live character runtime`);
          }
        }
      });
      if (scenario.sceneVisual != null) {
        if (!isRecord(scenario.sceneVisual)) gaps.push('scenario.sceneVisual must be an object');
        else {
          textFields(scenario.sceneVisual, ['caption', 'bg1', 'bg2', 'accent'], 'scenario.sceneVisual');
          stringList(scenario.sceneVisual.motifs, 'scenario.sceneVisual.motifs');
        }
      }
    }
    if (!milestones.some((milestone) => isRecord(milestone) && milestone.scenarioStage === 'roleplay')) {
      gaps.push('scenario needs a roleplay stage to host its live character');
    }
    milestones.forEach((milestone, i) => {
      if (isRecord(milestone) && milestone.scenarioStage == null) {
        gaps.push(`milestones[${i}].scenarioStage is needed to route the live scenario`);
      }
    });
  } else if (milestones.some((milestone) => isRecord(milestone) && milestone.scenarioStage != null)) {
    gaps.push('scenarioStage cannot route a live scenario without a scenario cast');
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// Hydration (parity with the loop's six tools + mark_design_complete)
// ---------------------------------------------------------------------------

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

type LLMScenario = NonNullable<PlannerLLMOutput['scenario']>;

/** Build the frozen `scenario` block from the LLM output: assign character
 *  ids and keep only valid hex colours. Authored character facts and motifs
 *  are retained; validation already guarantees a runnable cast. */
function hydrateScenario(raw: LLMScenario): PBLScenarioConfig {
  const characters: PBLScenarioCharacter[] = (Array.isArray(raw.characters) ? raw.characters : [])
    .filter((c) => toText(c?.name) && toText(c?.persona))
    .map((c) => ({
      id: newId('char'),
      name: toText(c.name),
      persona: toText(c.persona),
      ...(toText(c.situation) ? { situation: toText(c.situation) } : {}),
      ...(toText(c.boundaries) ? { boundaries: toText(c.boundaries) } : {}),
      ...(toText(c.openingLine) ? { openingLine: toText(c.openingLine) } : {}),
    }));

  const scenario: PBLScenarioConfig = { setting: toText(raw.setting), characters };
  if (toText(raw.goal)) scenario.goal = toText(raw.goal);
  if (toText(raw.rules)) scenario.rules = toText(raw.rules);
  if (toText(raw.learnerRole)) scenario.learnerRole = toText(raw.learnerRole);

  const sv = raw.sceneVisual;
  if (sv && (toText(sv.caption) || toStringList(sv.motifs).length > 0)) {
    const visual: PBLSceneVisual = {
      caption: toText(sv.caption),
      motifs: toStringList(sv.motifs),
    };
    if (typeof sv.bg1 === 'string' && HEX_RE.test(sv.bg1.trim())) visual.bg1 = sv.bg1.trim();
    if (typeof sv.bg2 === 'string' && HEX_RE.test(sv.bg2.trim())) visual.bg2 = sv.bg2.trim();
    if (typeof sv.accent === 'string' && HEX_RE.test(sv.accent.trim()))
      visual.accent = sv.accent.trim();
    scenario.sceneVisual = visual;
  }
  return scenario;
}

function hydrateProject(
  project: PBLProjectV2,
  parsed: PlannerLLMOutput,
  log = noopGenerationLogger,
): void {
  const info = parsed.projectInfo ?? {};

  // Project info — set title/description/objective BEFORE building the
  // instructor anchor (which reads them) and before proficiency re-seat.
  // All text reads go through `toText`; absent authoring fields remain empty
  // rather than being replaced with invented teaching content.
  project.title = toText(info.title);
  project.description = toText(info.description);
  project.learningObjective = toText(info.learningObjective) || undefined;
  project.gains = toStringList(info.gains);
  const fallbackTier = project.proficiency === '' ? 'intermediate' : project.proficiency;
  applyPlannerProficiency(project, info.proficiency ?? fallbackTier, log);

  // Instructor role.
  const llmRole = parsed.instructorRole ?? {};
  const anchoredSystemPrompt = [toText(llmRole.systemPrompt), instructorProjectAnchor(project)]
    .filter(Boolean)
    .join('\n\n');
  const role: PBLRole = {
    id: newId('role'),
    type: 'instructor',
    name: toText(llmRole.name),
    description: toText(llmRole.description) || undefined,
    systemPrompt: anchoredSystemPrompt,
  };
  project.roles.push(role);

  // Milestones (+ nested microtasks). Array shapes are coerced defensively
  // after validation; the author's task text and hints are retained.
  project.milestones = (Array.isArray(parsed.milestones) ? parsed.milestones : []).map(
    (m, i): PBLMilestone => {
      const microtasks: PBLMicrotask[] = (Array.isArray(m.microtasks) ? m.microtasks : []).map(
        (t, j): PBLMicrotask => {
          const mt: PBLMicrotask = {
            id: newId('mt'),
            title: toText(t.title),
            description: toText(t.description) || undefined,
            status: 'todo',
            assignee: 'user',
            hints: toStringList(t.hints),
            order: j,
          };
          // SCENARIO ONLY beat fields — attached only when present (ordinary
          // microtasks carry none). Their authored text is not revised.
          const successWhen = toText(t.successWhen);
          if (successWhen) mt.successWhen = successWhen;
          const characterObjective = toText(t.characterObjective);
          if (characterObjective) mt.characterObjective = characterObjective;
          const skillFocus = toText(t.skillFocus);
          if (skillFocus) mt.skillFocus = skillFocus;
          const learnerBrief = toText(t.learnerBrief);
          if (learnerBrief) mt.learnerBrief = learnerBrief;
          const narration = toText(t.narration);
          if (narration) mt.narration = narration;
          const beatCriteria = toText(t.completionCriteria);
          if (beatCriteria) mt.completionCriteria = beatCriteria;
          return mt;
        },
      );
      const coreConcept = toText(m.coreConcept);
      const scenarioStage = (['prep', 'roleplay', 'wrapup'] as const).includes(
        m.scenarioStage as never,
      )
        ? m.scenarioStage
        : undefined;
      return {
        id: newId('ms'),
        title: toText(m.title),
        description: toText(m.description) || undefined,
        status: i === 0 ? 'active' : 'locked',
        order: i,
        microtasks,
        briefing: toText(m.briefing),
        completionCriteria: toText(m.completionCriteria),
        debrief: toText(m.debrief),
        ...(coreConcept ? { synthesisCheck: { coreConcept } } : {}),
        ...(Array.isArray(m.documents) ? { documents: m.documents.map((document): PBLDocument => ({
          id: newId('doc'),
          title: toText(document.title),
          content: toText(document.content),
          docType: document.docType ?? 'markdown',
        })) } : {}),
        ...(scenarioStage ? { scenarioStage } : {}),
      };
    },
  );

  // SCENARIO ONLY. Freeze the cast/premise/visual onto the project and stamp
  // the scenario schema version (parity with the loop's set_scenario).
  // Executable routing and cast shapes were checked before hydration.
  if (parsed.scenario) {
    project.scenario = hydrateScenario(parsed.scenario);
    project.schemaVersion = SCENARIO_SCHEMA_VERSION;
  }

  // Bootstrap the Instructor thread + flip lifecycle (= mark_design_complete).
  const instructor = project.roles.find((r) => r.type === 'instructor');
  if (instructor && !project.threads.some((t) => t.agentId === instructor.id)) {
    project.threads.push({ agentId: instructor.id, messages: [] });
  }
  project.status = 'active';
  project.uiPhase = 'hero';
  project.updatedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Single-call PBL planner re-seated on the package's `AICallFn`.
 *
 * One authoring call → JSON/runtime-shape validation → hydration. Teaching
 * completeness and presentation preferences never reject or rewrite the draft.
 * `PlannerV2Error` is reserved for a response the runtime cannot execute.
 */
export async function generatePBLV2ProjectSingleCall(
  input: PBLPlannerV2Input,
  aiCall: PlannerSingleCallFn,
  callbacks?: PlannerV2Callbacks,
): Promise<PBLProjectV2> {
  const log = callbacks?.logger ?? noopGenerationLogger;
  const pblConfig = input.outline.pblConfig;
  if (!pblConfig) {
    throw new PlannerV2Error(
      'Planner v2 (single-call) invoked on an outline without pblConfig — this is a generation pipeline bug.',
      emptyProject(input, callbacks?.logger),
    );
  }

  const scenarioRoleplay = pblConfig.scenarioRoleplay === true;
  const project = emptyProject(input, log);
  const contentLanguage =
    project.languageDirective || 'Match the language of the outline content above.';
  const systemPrompt = await buildPlannerSystemPrompt(
    input,
    project.proficiency,
    contentLanguage,
    scenarioRoleplay,
    // Two prompts, one single-call path: scenario-roleplay outlines get the
    // scenario authoring spec + scenario-augmented schema; everything else
    // gets the ordinary project prompt.
    scenarioRoleplay ? SCENARIO_PROMPT : SINGLE_CALL_PROMPT,
  );

  const basePrompt = buildSingleCallUserPrompt(scenarioRoleplay);

  const callModel = async (prompt: string): Promise<PlannerLLMOutput | null> => {
    const result = await aiCall(systemPrompt, prompt);
    return parseJsonResponse<PlannerLLMOutput>(result, { logger: log });
  };

  const parsed = await callModel(basePrompt);
  const gaps = validateLLMOutput(parsed, scenarioRoleplay);

  if (!parsed || gaps.length > 0) {
    throw new PlannerV2Error(
      `Planner v2 (single-call) failed to produce a valid project: ${gaps.join('; ')}`,
      project,
    );
  }

  hydrateProject(project, parsed, log);

  callbacks?.onProgress?.({ kind: 'project_info', title: project.title });
  for (const milestone of project.milestones) {
    callbacks?.onProgress?.({ kind: 'milestone', title: milestone.title, index: milestone.order });
    for (const task of milestone.microtasks) {
      callbacks?.onProgress?.({
        kind: 'microtask',
        milestoneTitle: milestone.title,
        title: task.title,
        index: task.order,
      });
    }
  }

  // Hydrate learner/runtime state without adding, removing, or judging any
  // authored teaching content. Final content review belongs to the teacher.
  normalizeProjectRuntime(project);

  const microtaskCount = project.milestones.reduce((acc, m) => acc + m.microtasks.length, 0);
  callbacks?.onProgress?.({
    kind: 'complete',
    milestoneCount: project.milestones.length,
    microtaskCount,
  });
  log.info(
    `Planner v2 (single-call) done: ${project.milestones.length} milestones, ${microtaskCount} microtasks, ${project.roles.length} roles.`,
  );

  return project;
}
