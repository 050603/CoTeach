import type {
  MediaGenerationRequest,
  SceneOutline,
  VisualResourceReference,
} from './outline-types.js';

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

function mediaFingerprint(request: MediaGenerationRequest): string {
  return JSON.stringify({
    type: request.type,
    prompt: request.prompt,
    aspectRatio: request.aspectRatio ?? '',
    style: request.style ?? '',
  });
}

function canonicalMediaId(request: MediaGenerationRequest): string {
  const prefix = request.type === 'video' ? 'gen_vid_' : 'gen_img_';
  const rawId = typeof request.elementId === 'string' ? request.elementId.trim() : '';
  if (rawId.startsWith(prefix) && /^gen_(?:img|vid)_[\w-]+$/i.test(rawId)) return rawId;

  const slug = rawId
    .replace(/^gen_(?:img|vid)_/i, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${prefix}${slug || stableHash(mediaFingerprint(request))}`;
}

function remapVisualResourceRefs(
  outline: SceneOutline,
  idMapping: ReadonlyMap<string, string>,
): SceneOutline['visualIntent'] {
  if (!outline.visualIntent?.resourceRefs?.length || idMapping.size === 0) return outline.visualIntent;
  return {
    ...outline.visualIntent,
    resourceRefs: outline.visualIntent.resourceRefs.map((reference) => {
      const nextId = idMapping.get(reference.resourceId);
      return nextId ? { ...reference, resourceId: nextId } : reference;
    }),
  };
}

function inferredGeneratedReference(
  request: MediaGenerationRequest,
  resourceId: string,
  outline: SceneOutline,
  shared: boolean,
): VisualResourceReference {
  return {
    resourceId,
    kind: request.type === 'video' ? 'generated-video' : 'generated-image',
    required: true,
    reason: shared
      ? 'Reuse the already planned generated resource instead of generating it again.'
      : 'Place the generated resource selected during visual planning.',
    observationGoal: outline.visualIntent?.observationGoal,
  };
}

/**
 * Normalize generated-media IDs without destroying planner-established identity.
 *
 * Stable IDs are preserved. Repeated definitions with the same ID and request are
 * collapsed to one generation request, while the later scene keeps a resource
 * reference to the shared asset. True ID collisions receive a deterministic
 * suffix and the scene's visual references are updated with the same ID.
 */
export function uniquifyMediaElementIds(outlines: SceneOutline[]): SceneOutline[] {
  if (!outlines.some((outline) => outline.mediaGenerations?.length)) return outlines;

  const definitions = new Map<string, string>();

  return outlines.map((outline) => {
    if (!outline.mediaGenerations?.length) return outline;

    const idMapping = new Map<string, string>();
    const sharedRefs: VisualResourceReference[] = [];
    const mediaGenerations: MediaGenerationRequest[] = [];

    for (const request of outline.mediaGenerations) {
      const originalId = request.elementId;
      const fingerprint = mediaFingerprint(request);
      let resourceId = canonicalMediaId(request);
      const existing = definitions.get(resourceId);

      if (existing === fingerprint) {
        idMapping.set(originalId, resourceId);
        if (!outline.visualIntent?.resourceRefs?.some((ref) => ref.resourceId === originalId)) {
          sharedRefs.push(inferredGeneratedReference(request, resourceId, outline, true));
        }
        continue;
      }

      if (existing && existing !== fingerprint) {
        resourceId = `${resourceId}-${stableHash(fingerprint)}`;
        let collisionIndex = 2;
        while (definitions.has(resourceId) && definitions.get(resourceId) !== fingerprint) {
          resourceId = `${canonicalMediaId(request)}-${stableHash(fingerprint)}-${collisionIndex}`;
          collisionIndex += 1;
        }
        if (definitions.get(resourceId) === fingerprint) {
          idMapping.set(originalId, resourceId);
          if (!outline.visualIntent?.resourceRefs?.some((ref) => ref.resourceId === originalId)) {
            sharedRefs.push(inferredGeneratedReference(request, resourceId, outline, true));
          }
          continue;
        }
      }

      definitions.set(resourceId, fingerprint);
      idMapping.set(originalId, resourceId);
      mediaGenerations.push(
        resourceId === request.elementId ? request : { ...request, elementId: resourceId },
      );
    }

    let visualIntent = remapVisualResourceRefs(outline, idMapping);
    const pageGeneratedImageIds = new Set(
      outline.mediaGenerations
        .filter((request) => request.type === 'image')
        .map((request) => idMapping.get(request.elementId) ?? canonicalMediaId(request)),
    );
    if (visualIntent?.resourceRefs?.length && pageGeneratedImageIds.size > 0) {
      visualIntent = {
        ...visualIntent,
        resourceRefs: visualIntent.resourceRefs.map((reference) =>
          reference.kind === 'generated-image' && pageGeneratedImageIds.has(reference.resourceId)
            ? { ...reference, required: true }
            : reference,
        ),
      };
    }
    const generatedImageRefs = mediaGenerations
      .filter((request) => request.type === 'image')
      .filter(
        (request) =>
          !visualIntent?.resourceRefs?.some((reference) => reference.resourceId === request.elementId),
      )
      .map((request) => inferredGeneratedReference(request, request.elementId, outline, false));
    const addedRefs = [...generatedImageRefs, ...sharedRefs];
    if (addedRefs.length > 0) {
      const currentRepresentation = visualIntent?.representation;
      visualIntent = {
        ...visualIntent,
        observationGoal:
          visualIntent?.observationGoal || `Observe the visual evidence for ${outline.title}.`,
        representation:
          currentRepresentation && currentRepresentation !== 'text'
            ? currentRepresentation
            : currentRepresentation === 'text'
              ? 'mixed'
              : 'generated-image',
        resourceRefs: [...(visualIntent?.resourceRefs ?? []), ...addedRefs],
      };
    }

    return {
      ...outline,
      ...(mediaGenerations.length > 0 ? { mediaGenerations } : { mediaGenerations: undefined }),
      ...(visualIntent ? { visualIntent } : {}),
    };
  });
}
