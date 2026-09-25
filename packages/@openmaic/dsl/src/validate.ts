/**
 * Pure, dependency-free structural validators for the slide DSL contract.
 *
 * This is the contract's authoritative, zero-dependency validation boundary for
 * in-process (TS / JS) producers and consumers — generators, importers, the
 * runtime engine. It checks object shape, required fields (including each action
 * variant's), known discriminants, and the scene `type` <-> `content` binding
 * that the public {@link Scene} type enforces. Producers can rely on it without
 * shipping a schema validator, because it adds no runtime dependency.
 *
 * The shipped JSON Schema (`@openmaic/dsl/schema/*`) is the cross-language
 * mirror of the same contract — reach for it from non-TS consumers, or when you
 * want exhaustive value-level (type / format) checking. These validators are a
 * structural subset (presence + discriminants); the schema additionally checks
 * each field's value shape. Both describe the same contract. No runtime
 * dependencies.
 */
import { isActionType, MAX_LASER_WAYPOINTS } from './action.js';
import type { ActionType } from './action.js';
import { isWidgetType } from './interactive.js';
import { isPBLProject } from './pbl.js';
import { isSceneType } from './stage.js';
import { isIsoTimestamp, isRuntimeSessionStatus } from './runtime.js';
import { isWellFormedDslVersion } from './version.js';

export interface ValidationIssue {
  /** JSON-pointer-ish path to the offending value, e.g. `/actions/0/elementId`. */
  path: string;
  message: string;
}

export type ValidationResult = { valid: true } | { valid: false; errors: ValidationIssue[] };

/** Runtime kind of a required field, checked with `typeof` / `Array.isArray`. */
type FieldKind = 'string' | 'number' | 'boolean' | 'object' | 'array';

/**
 * Required fields beyond `ActionBase` (`id`) for each action variant, with the
 * runtime kind each must have. Checked for presence AND shape. Kept in lockstep
 * (both directions, names + kinds) with the generated `action.schema.json` by a
 * test — the schema, derived from the TS types, is the source of truth.
 */
const ACTION_REQUIRED_FIELDS: Record<ActionType, Readonly<Record<string, FieldKind>>> = {
  spotlight: { elementId: 'string' },
  laser: { elementId: 'string' },
  play_video: { elementId: 'string' },
  speech: { text: 'string' },
  wb_open: {},
  wb_draw_text: { content: 'string', x: 'number', y: 'number' },
  wb_draw_image: { src: 'string', x: 'number', y: 'number', width: 'number', height: 'number' },
  wb_draw_shape: { shape: 'string', x: 'number', y: 'number', width: 'number', height: 'number' },
  wb_draw_chart: {
    chartType: 'string',
    x: 'number',
    y: 'number',
    width: 'number',
    height: 'number',
    data: 'object',
  },
  wb_draw_latex: { latex: 'string', x: 'number', y: 'number' },
  wb_draw_table: { x: 'number', y: 'number', width: 'number', height: 'number', data: 'array' },
  wb_draw_line: { startX: 'number', startY: 'number', endX: 'number', endY: 'number' },
  wb_draw_code: { language: 'string', code: 'string', x: 'number', y: 'number' },
  wb_edit_code: { elementId: 'string', operation: 'string' },
  wb_clear: {},
  wb_delete: { elementId: 'string' },
  wb_close: {},
  discussion: { topic: 'string' },
  widget_highlight: { target: 'string' },
  widget_setState: { state: 'object' },
  widget_annotation: { target: 'string' },
  widget_reveal: { target: 'string' },
};

function matchesKind(value: unknown, kind: FieldKind): boolean {
  if (kind === 'array') return Array.isArray(value);
  if (kind === 'object') return isObject(value);
  return typeof value === kind;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqString(
  o: Record<string, unknown>,
  key: string,
  path: string,
  errors: ValidationIssue[],
): void {
  if (typeof o[key] !== 'string')
    errors.push({ path: `${path}/${key}`, message: `expected string \`${key}\`` });
}

function reqNumber(
  o: Record<string, unknown>,
  key: string,
  path: string,
  errors: ValidationIssue[],
): void {
  if (typeof o[key] !== 'number')
    errors.push({ path: `${path}/${key}`, message: `expected number \`${key}\`` });
}

function done(errors: ValidationIssue[]): ValidationResult {
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

function checkSpeechAnchor(
  value: unknown,
  path: string,
  errors: ValidationIssue[],
): void {
  if (!isObject(value) || typeof value.quote !== 'string' || !value.quote.trim()) {
    errors.push({ path, message: 'speech anchor must contain a non-empty quote' });
    return;
  }
  if (
    value.occurrence !== undefined
    && (
      typeof value.occurrence !== 'number'
      || !Number.isInteger(value.occurrence)
      || value.occurrence < 0
    )
  ) {
    errors.push({
      path: `${path}/occurrence`,
      message: 'speech anchor occurrence must be a non-negative integer',
    });
  }
}

function checkMediaOffset(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    errors.push({ path, message: 'media offset must be a non-negative finite number' });
  }
}

function checkSpeechAlignment(
  value: unknown,
  narrationText: string,
  path: string,
  errors: ValidationIssue[],
): void {
  if (!isObject(value)) {
    errors.push({ path, message: 'speech alignment must be an object' });
    return;
  }

  for (const field of ['version', 'textHash', 'audioHash'] as const) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      errors.push({
        path: `${path}/${field}`,
        message: `speech alignment ${field} must be a non-empty string`,
      });
    }
  }
  if (value.language !== undefined && (
    typeof value.language !== 'string' || !value.language.trim()
  )) {
    errors.push({
      path: `${path}/language`,
      message: 'speech alignment language must be a non-empty string when present',
    });
  }
  if (!['pending', 'aligned', 'failed'].includes(String(value.status))) {
    errors.push({
      path: `${path}/status`,
      message: 'speech alignment status must be `pending`, `aligned`, or `failed`',
    });
  }
  if (value.error !== undefined && (typeof value.error !== 'string' || !value.error.trim())) {
    errors.push({
      path: `${path}/error`,
      message: 'speech alignment error must be a non-empty string when present',
    });
  }
  if (!Array.isArray(value.spans)) {
    errors.push({ path: `${path}/spans`, message: 'speech alignment spans must be an array' });
    return;
  }
  if (value.status === 'aligned' && value.spans.length === 0) {
    errors.push({
      path: `${path}/spans`,
      message: 'an aligned speech timeline must contain at least one span',
    });
  }

  let previousEndChar = 0;
  let previousEndMs = 0;
  value.spans.forEach((span, index) => {
    const spanPath = `${path}/spans/${index}`;
    if (!isObject(span)) {
      errors.push({ path: spanPath, message: 'speech alignment span must be an object' });
      return;
    }
    if (typeof span.text !== 'string' || span.text.length === 0) {
      errors.push({ path: `${spanPath}/text`, message: 'aligned span text must be non-empty' });
    }
    const startChar = typeof span.startChar === 'number'
      && Number.isInteger(span.startChar)
      && span.startChar >= 0
      ? span.startChar
      : null;
    const endChar = typeof span.endChar === 'number'
      && Number.isInteger(span.endChar)
      && span.endChar > 0
      ? span.endChar
      : null;
    if (startChar === null) {
      errors.push({
        path: `${spanPath}/startChar`,
        message: 'aligned span startChar must be a non-negative integer',
      });
    }
    if (endChar === null || (startChar !== null && endChar <= startChar)) {
      errors.push({
        path: `${spanPath}/endChar`,
        message: 'aligned span endChar must be an integer greater than startChar',
      });
    }

    const startMs = typeof span.startMs === 'number'
      && Number.isFinite(span.startMs)
      && span.startMs >= 0
      ? span.startMs
      : null;
    const endMs = typeof span.endMs === 'number'
      && Number.isFinite(span.endMs)
      && span.endMs >= 0
      ? span.endMs
      : null;
    if (startMs === null) {
      errors.push({
        path: `${spanPath}/startMs`,
        message: 'aligned span startMs must be a non-negative finite number',
      });
    }
    if (endMs === null || (startMs !== null && endMs < startMs)) {
      errors.push({
        path: `${spanPath}/endMs`,
        message: 'aligned span endMs must be finite and no earlier than startMs',
      });
    }

    if (startChar !== null && endChar !== null && endChar > startChar) {
      if (startChar < previousEndChar) {
        errors.push({ path: `${spanPath}/startChar`, message: 'aligned spans must not overlap' });
      }
      if (endChar > narrationText.length) {
        errors.push({
          path: `${spanPath}/endChar`,
          message: 'aligned span character range exceeds narration text',
        });
      } else if (
        typeof span.text === 'string'
        && narrationText.slice(startChar, endChar) !== span.text
      ) {
        errors.push({
          path: `${spanPath}/text`,
          message: 'aligned span text must equal its original narration slice',
        });
      }
      previousEndChar = Math.max(previousEndChar, endChar);
    }
    if (startMs !== null && endMs !== null && endMs >= startMs) {
      if (startMs < previousEndMs) {
        errors.push({ path: `${spanPath}/startMs`, message: 'aligned span times must not overlap' });
      }
      previousEndMs = Math.max(previousEndMs, endMs);
    }
  });
}

/**
 * Check a table of root-level envelope fields against their declared runtime
 * kinds, pushing one {@link ValidationIssue} per violation at path `/<field>`.
 *
 * One helper for all three runtime-envelope tables (session-required,
 * record-required, record-optional) so the presence / kind / emptiness rules
 * cannot drift between the copies. Two modes:
 *
 * - required (`opts.optional` falsy): the field must be present with its kind,
 *   and a required `'string'` must additionally be **non-empty** — an empty
 *   `id` / `learnerKey` passes `typeof` yet is useless as an identity/partition
 *   key, so it is a contract violation, not valid data.
 * - optional (`opts.optional` true): the field is only checked *when present*,
 *   and only for its `typeof` kind. Optional anchors (`sceneId`, `subAnchor`)
 *   stay lax on emptiness — an empty best-effort anchor is the app's business.
 *
 * `checkAction`'s variant-field loop is deliberately NOT routed through here:
 * it uses nested paths and a different "requires"/"must be" message shape.
 */
function checkFields(
  doc: Record<string, unknown>,
  fields: Readonly<Record<string, FieldKind>>,
  opts: { optional?: boolean },
  errors: ValidationIssue[],
): void {
  for (const [field, kind] of Object.entries(fields)) {
    const value = doc[field];
    if (opts.optional) {
      if (value !== undefined && !matchesKind(value, kind)) {
        errors.push({ path: `/${field}`, message: `expected ${kind} \`${field}\`` });
      }
      continue;
    }
    if (!matchesKind(value, kind)) {
      errors.push({ path: `/${field}`, message: `expected ${kind} \`${field}\`` });
      continue;
    }
    if (kind === 'string' && value === '') {
      errors.push({ path: `/${field}`, message: `expected non-empty string \`${field}\`` });
    }
  }
}

function checkAction(doc: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isObject(doc)) {
    errors.push({ path: path || '/', message: 'action must be an object' });
    return;
  }
  reqString(doc, 'id', path, errors);
  if (doc.groupId !== undefined && (typeof doc.groupId !== 'string' || !doc.groupId.trim())) {
    errors.push({ path: `${path}/groupId`, message: 'groupId must be a non-empty string' });
  }
  if (!isActionType(doc.type)) {
    errors.push({
      path: `${path}/type`,
      message: `unknown action type: ${JSON.stringify(doc.type)}`,
    });
    return; // can't check variant fields without a known type
  }
  for (const [field, kind] of Object.entries(ACTION_REQUIRED_FIELDS[doc.type])) {
    const value = doc[field];
    if (value === undefined) {
      errors.push({
        path: `${path}/${field}`,
        message: `${doc.type} action requires \`${field}\``,
      });
    } else if (!matchesKind(value, kind)) {
      errors.push({
        path: `${path}/${field}`,
        message: `${doc.type} action field \`${field}\` must be ${kind}`,
      });
    }
  }
  if (doc.type === 'spotlight' || doc.type === 'laser') {
    if (doc.speechId !== undefined && (typeof doc.speechId !== 'string' || !doc.speechId.trim())) {
      errors.push({
        path: `${path}/speechId`,
        message: `${doc.type} action field \`speechId\` must be a non-empty string`,
      });
    }
    if (doc.speechOffsetMs !== undefined) {
      checkMediaOffset(doc.speechOffsetMs, `${path}/speechOffsetMs`, errors);
    }
    if (doc.speechAnchor !== undefined) {
      checkSpeechAnchor(doc.speechAnchor, `${path}/speechAnchor`, errors);
    }
    if (doc.endSpeechAnchor !== undefined) {
      checkSpeechAnchor(doc.endSpeechAnchor, `${path}/endSpeechAnchor`, errors);
    }
    if (doc.endSpeechOffsetMs !== undefined) {
      checkMediaOffset(doc.endSpeechOffsetMs, `${path}/endSpeechOffsetMs`, errors);
    }
    if (
      doc.necessity !== undefined
      && doc.necessity !== 'essential'
      && doc.necessity !== 'helpful'
    ) {
      errors.push({
        path: `${path}/necessity`,
        message: 'visual action necessity must be `essential` or `helpful`',
      });
    }
    if (
      doc.omissionRisk !== undefined
      && (typeof doc.omissionRisk !== 'string' || !doc.omissionRisk.trim())
    ) {
      errors.push({
        path: `${path}/omissionRisk`,
        message: 'visual action omissionRisk must be a non-empty string',
      });
    }
    if (
      doc.type === 'spotlight'
      && doc.endSpeechId !== undefined
      && (typeof doc.endSpeechId !== 'string' || !doc.endSpeechId.trim())
    ) {
      errors.push({
        path: `${path}/endSpeechId`,
        message: 'spotlight action field `endSpeechId` must be a non-empty string',
      });
    }

    if (doc.selector !== undefined) {
      const selectorPath = `${path}/selector`;
      if (!isObject(doc.selector)) {
        errors.push({ path: selectorPath, message: 'selector must be an object' });
      } else if ('cellId' in doc.selector) {
        if (typeof doc.selector.cellId !== 'string' || !doc.selector.cellId.trim()) {
          errors.push({
            path: `${selectorPath}/cellId`,
            message: 'cell selector requires a non-empty string `cellId`',
          });
        }
        if (
          doc.selector.quote !== undefined
          && (typeof doc.selector.quote !== 'string' || !doc.selector.quote)
        ) {
          errors.push({
            path: `${selectorPath}/quote`,
            message: '`quote` must be a non-empty string when present',
          });
        }
      } else if ('rowIndex' in doc.selector) {
        if (
          typeof doc.selector.rowIndex !== 'number'
          || !Number.isInteger(doc.selector.rowIndex)
          || doc.selector.rowIndex < 0
        ) {
          errors.push({
            path: `${selectorPath}/rowIndex`,
            message: 'row selector requires a non-negative integer `rowIndex`',
          });
        }
        if (
          doc.selector.quote !== undefined
          && (typeof doc.selector.quote !== 'string' || !doc.selector.quote)
        ) {
          errors.push({
            path: `${selectorPath}/quote`,
            message: '`quote` must be a non-empty string when present',
          });
        }
      } else if ('quote' in doc.selector) {
        if (typeof doc.selector.quote !== 'string' || !doc.selector.quote) {
          errors.push({
            path: `${selectorPath}/quote`,
            message: 'quote selector requires a non-empty string `quote`',
          });
        }
      } else {
        errors.push({
          path: selectorPath,
          message: 'selector requires `cellId`, `rowIndex`, or `quote`',
        });
      }

      if (isObject(doc.selector) && 'occurrence' in doc.selector) {
        const occurrence = doc.selector.occurrence;
        if (
          occurrence !== undefined
          && (
            typeof occurrence !== 'number'
            || !Number.isInteger(occurrence)
            || occurrence < 0
          )
        ) {
          errors.push({
            path: `${selectorPath}/occurrence`,
            message: '`occurrence` must be a non-negative integer',
          });
        }
      }
    }
    if (
      doc.type === 'laser'
      && doc.duration !== undefined
      && (typeof doc.duration !== 'number' || !Number.isFinite(doc.duration) || doc.duration < 0)
    ) {
      errors.push({
        path: `${path}/duration`,
        message: 'laser action field `duration` must be a non-negative finite number',
      });
    }
    if (doc.type === 'laser' && doc.waypoints !== undefined) {
      if (!Array.isArray(doc.waypoints) || doc.waypoints.length < 1 || doc.waypoints.length > MAX_LASER_WAYPOINTS) {
        errors.push({
          path: `${path}/waypoints`,
          message: `laser action field \`waypoints\` must contain 1 to ${MAX_LASER_WAYPOINTS} targets`,
        });
      } else {
        doc.waypoints.forEach((waypoint, index) => {
          const waypointPath = `${path}/waypoints/${index}`;
          if (!isObject(waypoint)) {
            errors.push({ path: waypointPath, message: 'laser waypoint must be an object' });
            return;
          }
          if (typeof waypoint.elementId !== 'string' || !waypoint.elementId.trim()) {
            errors.push({
              path: `${waypointPath}/elementId`,
              message: 'laser waypoint requires a non-empty string `elementId`',
            });
          }
          if (waypoint.selector !== undefined) {
            const probe = {
              id: '__waypoint_probe__',
              type: 'laser',
              elementId: waypoint.elementId,
              selector: waypoint.selector,
            };
            checkAction(probe, waypointPath, errors);
          }
          if (waypoint.speechAnchor !== undefined) {
            checkSpeechAnchor(
              waypoint.speechAnchor,
              `${waypointPath}/speechAnchor`,
              errors,
            );
          }
          if (waypoint.speechOffsetMs !== undefined) {
            checkMediaOffset(
              waypoint.speechOffsetMs,
              `${waypointPath}/speechOffsetMs`,
              errors,
            );
          }
        });
      }
    }
  }
  if (doc.type === 'speech' && doc.speechAlignment !== undefined) {
    checkSpeechAlignment(
      doc.speechAlignment,
      typeof doc.text === 'string' ? doc.text : '',
      `${path}/speechAlignment`,
      errors,
    );
  }
  if (doc.type === 'wb_draw_line') {
    for (const key of ['startAnchor', 'endAnchor']) {
      const anchor = doc[key];
      if (anchor === undefined) continue;
      if (!isObject(anchor) || typeof anchor.elementId !== 'string' || !anchor.elementId.trim()
        || !['top', 'right', 'bottom', 'left', 'center'].includes(String(anchor.side))) {
        errors.push({ path: `${path}/${key}`, message: 'anchor requires a non-empty elementId and a valid side' });
      }
    }
  }
}

function checkInteractiveContent(doc: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isObject(doc)) {
    errors.push({ path: path || '/', message: 'interactive content must be an object' });
    return;
  }
  if (doc.type !== 'interactive') {
    errors.push({ path: `${path}/type`, message: 'expected `interactive` content type' });
  }
  if (typeof doc.html !== 'string' && typeof doc.url !== 'string') {
    errors.push({
      path: path || '/',
      message: 'interactive content requires `html` or `url` as a string',
    });
  }
  if (doc.url !== undefined && typeof doc.url !== 'string') {
    errors.push({ path: `${path}/url`, message: '`url` must be a string when present' });
  }
  if (doc.html !== undefined && typeof doc.html !== 'string') {
    errors.push({ path: `${path}/html`, message: '`html` must be a string when present' });
  }
  if (doc.widgetType !== undefined && !isWidgetType(doc.widgetType)) {
    errors.push({
      path: `${path}/widgetType`,
      message: `unknown widget type: ${JSON.stringify(doc.widgetType)}`,
    });
  }
  if (doc.widgetConfig !== undefined) {
    if (!isObject(doc.widgetConfig)) {
      errors.push({
        path: `${path}/widgetConfig`,
        message: '`widgetConfig` must be an object when present',
      });
    } else if (!isWidgetType(doc.widgetConfig.type)) {
      errors.push({
        path: `${path}/widgetConfig/type`,
        message: `unknown widget config type: ${JSON.stringify(doc.widgetConfig.type)}`,
      });
    }
  }
}

function checkPBLContent(doc: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isObject(doc)) {
    errors.push({ path: path || '/', message: 'pbl content must be an object' });
    return;
  }
  if (doc.type !== 'pbl') {
    errors.push({ path: `${path}/type`, message: 'expected `pbl` content type' });
  }
  if (doc.projectV2 !== undefined && !isPBLProject(doc.projectV2)) {
    errors.push({
      path: `${path}/projectV2`,
      message: '`projectV2` must be a structurally valid PBL project when present',
    });
  }
  if (doc.projectConfig !== undefined && !isObject(doc.projectConfig)) {
    errors.push({
      path: `${path}/projectConfig`,
      message: '`projectConfig` must be an object when present',
    });
  }
}

function checkScene(doc: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isObject(doc)) {
    errors.push({ path: path || '/', message: 'scene must be an object' });
    return;
  }
  reqString(doc, 'id', path, errors);
  reqString(doc, 'stageId', path, errors);
  reqString(doc, 'title', path, errors);
  reqNumber(doc, 'order', path, errors);

  // The scene `type` is bound to its `content` (see `Scene`) for all four
  // persisted kinds owned by the contract.
  const t = doc.type;
  if (!isSceneType(t)) {
    errors.push({
      path: `${path}/type`,
      message: `unknown scene type: ${JSON.stringify(t)}`,
    });
  }

  const content = doc.content;
  if (!isObject(content)) {
    errors.push({ path: `${path}/content`, message: 'scene `content` must be an object' });
  } else if (isSceneType(t)) {
    if (content.type !== t) {
      errors.push({
        path: `${path}/content/type`,
        message: `content type ${JSON.stringify(content.type)} does not match scene type ${JSON.stringify(t)}`,
      });
    } else if (t === 'slide' && !isObject(content.canvas)) {
      errors.push({
        path: `${path}/content/canvas`,
        message: 'slide content requires an object `canvas`',
      });
    } else if (t === 'quiz' && !Array.isArray(content.questions)) {
      errors.push({
        path: `${path}/content/questions`,
        message: 'quiz content requires a `questions` array',
      });
    } else if (t === 'interactive') {
      checkInteractiveContent(content, `${path}/content`, errors);
    } else if (t === 'pbl') {
      checkPBLContent(content, `${path}/content`, errors);
    }
  }

  if (doc.actions !== undefined) {
    if (!Array.isArray(doc.actions)) {
      errors.push({ path: `${path}/actions`, message: '`actions` must be an array' });
    } else {
      doc.actions.forEach((a, i) => checkAction(a, `${path}/actions/${i}`, errors));
    }
  }
}

/** Validate a {@link Stage} aggregate (course metadata; scenes are separate). */
export function validateStage(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  if (!isObject(doc))
    return { valid: false, errors: [{ path: '/', message: 'stage must be an object' }] };
  reqString(doc, 'id', '', errors);
  reqString(doc, 'name', '', errors);
  reqNumber(doc, 'createdAt', '', errors);
  reqNumber(doc, 'updatedAt', '', errors);
  return done(errors);
}

/** Validate a {@link Scene} aggregate, including its nested content + actions. */
export function validateScene(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  checkScene(doc, '', errors);
  return done(errors);
}

/** Validate a standalone interactive content payload. */
export function validateInteractiveContent(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  checkInteractiveContent(doc, '', errors);
  return done(errors);
}

/** Validate a standalone current or legacy PBL content payload. */
export function validatePBLContent(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  checkPBLContent(doc, '', errors);
  return done(errors);
}

/** Validate a single {@link Action}, including its variant-required fields. */
export function validateAction(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  checkAction(doc, '', errors);
  return done(errors);
}

/** Required envelope fields of a runtime session, with their runtime kinds. */
const RUNTIME_SESSION_REQUIRED_FIELDS: Readonly<Record<string, FieldKind>> = {
  id: 'string',
  kind: 'string',
  stageId: 'string',
  learnerKey: 'string',
  status: 'string',
  createdAt: 'string',
  updatedAt: 'string',
};

/**
 * Validate a runtime session envelope (#869). Payloads live on records, so
 * this is a pure envelope check; `kind` is an open string by design.
 */
export function validateRuntimeSession(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  if (!isObject(doc)) {
    return { valid: false, errors: [{ path: '/', message: 'runtime session must be an object' }] };
  }
  checkFields(doc, RUNTIME_SESSION_REQUIRED_FIELDS, {}, errors);
  if (typeof doc.status === 'string' && !isRuntimeSessionStatus(doc.status)) {
    errors.push({
      path: '/status',
      message: `unknown session status: ${JSON.stringify(doc.status)}`,
    });
  }
  // `createdAt` / `updatedAt` are documented ISO-8601 strings. The table check
  // above only proves they are strings and, being required, already reports an
  // empty string as non-empty. Refine only a present NON-EMPTY string to the ISO
  // format, so an empty (or wrong-typed) value is reported once — by the table —
  // not twice at the same path.
  if (typeof doc.createdAt === 'string' && doc.createdAt !== '' && !isIsoTimestamp(doc.createdAt)) {
    errors.push({ path: '/createdAt', message: 'expected ISO 8601 `createdAt`' });
  }
  if (typeof doc.updatedAt === 'string' && doc.updatedAt !== '' && !isIsoTimestamp(doc.updatedAt)) {
    errors.push({ path: '/updatedAt', message: 'expected ISO 8601 `updatedAt`' });
  }
  // `runtimeDslVersion` is REQUIRED on a session: sessions are stamped at write
  // time and the runtime line has no unversioned epoch (nothing legitimately
  // predates the runtime envelope), so an absent stamp is a bug — a misrouted
  // legacy document or an unstamped producer write — not legacy data to lift.
  // Kept as its own block (not folded into the required-field table) so an
  // absent stamp gets a specific message and is reported exactly once at
  // `/runtimeDslVersion`. A present stamp must be a well-formed `x.y.z` string:
  // `migrateRuntime`/`runtimeDslVersionOf` throw on a malformed stamp, so
  // accepting a string like `'legacy'` here would only defer the failure to
  // read time.
  if (doc.runtimeDslVersion === undefined) {
    errors.push({
      path: '/runtimeDslVersion',
      message: 'missing `runtimeDslVersion`; runtime sessions are stamped at write time',
    });
  } else if (typeof doc.runtimeDslVersion !== 'string') {
    errors.push({ path: '/runtimeDslVersion', message: 'expected string `runtimeDslVersion`' });
  } else if (!isWellFormedDslVersion(doc.runtimeDslVersion)) {
    errors.push({
      path: '/runtimeDslVersion',
      message: 'malformed `runtimeDslVersion`: expected x.y.z',
    });
  }
  // A session versions on `runtimeDslVersion`; the document line's `dslVersion`
  // is never part of a session's shape. This is the one deliberate exception to
  // the structural-subset rule (unknown fields ignored): a stray sibling stamp
  // is evidence of a misrouted migration, and once stored it makes the envelope
  // ambiguous to the cross-line guard (`migrate`/`migrateRuntime` fail loud on
  // own-stamp-absent + sibling-stamp-present), so reject it at the door.
  if (doc.dslVersion !== undefined) {
    errors.push({
      path: '/dslVersion',
      message:
        'unexpected document-line `dslVersion` on a runtime session; sessions version on `runtimeDslVersion`',
    });
  }
  return done(errors);
}

/** Required envelope fields of a runtime record, with their runtime kinds. */
const RUNTIME_RECORD_REQUIRED_FIELDS: Readonly<Record<string, FieldKind>> = {
  id: 'string',
  sessionId: 'string',
  seq: 'number',
  createdAt: 'string',
};

/** Optional anchor fields of a runtime record, with their runtime kinds. */
const RUNTIME_RECORD_OPTIONAL_FIELDS: Readonly<Record<string, FieldKind>> = {
  sceneId: 'string',
  actionIndex: 'number',
  subAnchor: 'string',
};

/**
 * Validate a runtime record envelope (#869). The payload is app-owned and
 * checked only for presence — per-kind payload validators are injected at
 * the store boundary, exactly like scene-content validators (#860).
 */
export function validateRuntimeRecord(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  if (!isObject(doc)) {
    return { valid: false, errors: [{ path: '/', message: 'runtime record must be an object' }] };
  }
  checkFields(doc, RUNTIME_RECORD_REQUIRED_FIELDS, {}, errors);
  checkFields(doc, RUNTIME_RECORD_OPTIONAL_FIELDS, { optional: true }, errors);

  // `seq` is the sole replay ordering key, so it must be a real array-like
  // index. `matchesKind(_, 'number')` above already accepts NaN / Infinity /
  // negative / fractional (all `typeof === 'number'`); narrow to a non-negative
  // integer here so a malformed value can't silently corrupt replay order.
  if (typeof doc.seq === 'number' && !(Number.isInteger(doc.seq) && doc.seq >= 0)) {
    errors.push({ path: '/seq', message: 'expected non-negative integer `seq`' });
  }
  // `actionIndex` is an index into a scene's actions when present: same
  // non-negative-integer rule as `seq` (a wrong-typed value was already flagged
  // by the optional-field check above, so only refine a present number here).
  if (
    typeof doc.actionIndex === 'number' &&
    !(Number.isInteger(doc.actionIndex) && doc.actionIndex >= 0)
  ) {
    errors.push({ path: '/actionIndex', message: 'expected non-negative integer `actionIndex`' });
  }

  // `createdAt` is a documented ISO-8601 string (display metadata; ordering is
  // `seq`). Refine only a present non-empty string to the ISO format; an empty
  // string is already reported once by the required-field table above.
  if (typeof doc.createdAt === 'string' && doc.createdAt !== '' && !isIsoTimestamp(doc.createdAt)) {
    errors.push({ path: '/createdAt', message: 'expected ISO 8601 `createdAt`' });
  }

  // Require a real payload value, not merely the key. `'payload' in doc` would
  // pass an explicit `{ payload: undefined }`; reject that. `null` stays legal —
  // it is a value an app may have deliberately stored.
  if (doc.payload === undefined) {
    errors.push({ path: '/payload', message: 'expected `payload`' });
  }
  return done(errors);
}
