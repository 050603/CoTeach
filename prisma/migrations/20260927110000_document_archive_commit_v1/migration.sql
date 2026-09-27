-- Additive: the previous scope-only helper remains available to older builds.
-- Caller must retain course admission, its LOCAL deadline, and commit-bound FIFO.
CREATE FUNCTION public.openpbl_document_archive_commit_v1(
  p_context jsonb, p_original jsonb, p_draft jsonb, p_receipt_payload jsonb
) RETURNS TABLE (payload jsonb, reused boolean, error_code text)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER PARALLEL UNSAFE
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_scope record;
  v_artifact text := 'document:' || (p_context->>'submissionId');
  v_now timestamp(3) := (p_context->>'submittedAt')::timestamptz AT TIME ZONE 'UTC';
  v_payload jsonb;
  v_audit jsonb;
  v_written text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'DOCUMENT_ARCHIVE_COMMIT_REQUIRES_READ_COMMITTED' USING ERRCODE = '25001';
  END IF;
  -- Nested VOLATILE SPI keeps the existing row wait followed by a fresh read.
  SELECT * INTO v_scope FROM public.openpbl_document_archive_scope_v1(
    p_original, p_context->>'receiptKey', v_artifact, p_context->>'submissionId',
    p_context->>'participationId', p_context->>'courseId', p_context->>'studentId', p_context->>'offeringId');
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::jsonb, false, 'STUDENT_SCOPE_MISMATCH'::text; RETURN;
  END IF;
  IF upper(v_scope."userStatus") IS DISTINCT FROM 'ACTIVE'
    OR upper(v_scope."userRole") IS DISTINCT FROM 'STUDENT'
    OR v_scope."sessionVersion" IS DISTINCT FROM (p_context->>'sessionVersion')::integer THEN
    RETURN QUERY SELECT NULL::jsonb, false, 'UNAUTHENTICATED'::text; RETURN;
  END IF;
  IF upper(v_scope."enrollmentStatus") NOT IN ('ACTIVE', 'COMPLETED') THEN
    RETURN QUERY SELECT NULL::jsonb, false, 'STUDENT_SCOPE_MISMATCH'::text; RETURN;
  END IF;
  -- Authorization precedes even historical receipt replay. Closed/COMPLETED
  -- students may replay an already committed receipt but cannot create one.
  IF v_scope.receipt IS NOT NULL AND v_scope.receipt <> 'null'::jsonb THEN
    IF v_scope.receipt->'fingerprint' IS DISTINCT FROM p_receipt_payload->'fingerprint' THEN
      RETURN QUERY SELECT NULL::jsonb, false, 'IDEMPOTENCY_CONFLICT'::text; RETURN;
    END IF;
    RETURN QUERY SELECT v_scope.receipt, true, NULL::text; RETURN;
  END IF;
  IF NOT v_scope.unchanged THEN
    RETURN QUERY SELECT NULL::jsonb, false, 'DRAFT_VERSION_CONFLICT'::text; RETURN;
  END IF;
  IF upper(v_scope."instanceStatus") IS DISTINCT FROM 'TEACHING'
    OR upper(v_scope."offeringStatus") IS DISTINCT FROM 'OPEN'
    OR upper(v_scope."enrollmentStatus") IS DISTINCT FROM 'ACTIVE'
    OR v_scope."archivedAt" IS NOT NULL THEN
    RETURN QUERY SELECT NULL::jsonb, false, 'COURSE_LOCKED'::text; RETURN;
  END IF;
  -- Draft/view transformation, UUIDs and timestamps are supplied by the same JS
  -- preparation as the fallback. Only locked fresh sequence/research scope vary.
  v_payload := p_receipt_payload || jsonb_build_object('sequence', v_scope.sequence);
  v_audit := jsonb_build_object('legacy', jsonb_build_object('stageKey', 'make', 'source', 'submission',
    'actorId', p_context->>'studentId'), 'detail', v_payload, 'schemaVersion', 1);
  WITH artifact AS (
      INSERT INTO public."Artifact" (id, "participationId", title, type, status, "updatedAt")
      VALUES (v_artifact, p_context->>'participationId', p_context->>'title', 'DOCUMENT_ARCHIVE', 'SUBMITTED', v_now)
      ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, status = EXCLUDED.status, "updatedAt" = EXCLUDED."updatedAt"
      RETURNING id
    ), asset AS (
      INSERT INTO public."FileAsset" (id, "originalName", "storageKey", "offeringId", "uploadedById", size, "mimeType", sha256, "updatedAt")
      VALUES (p_context->>'uploadId', p_context->>'filename', p_context->>'storageKey',
        p_context->>'offeringId', p_context->>'studentId', (p_context->>'size')::bigint, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', p_context->>'sha256', v_now) RETURNING id
    ), version AS (
      INSERT INTO public."ArtifactVersion" (id, "artifactId", sequence, "sourceHtml", "fileAssetId", "mimeType", sha256, size, status, "submittedAt")
      SELECT p_receipt_payload->>'versionId', artifact.id, v_scope.sequence, p_context->>'sourceHtml', asset.id, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', p_context->>'sha256', (p_context->>'size')::bigint, 'SUBMITTED', v_now
      FROM artifact CROSS JOIN asset RETURNING id
    ), submission AS (
      UPDATE public."ClassroomSubmission" SET status = 'SUBMITTED', "submittedAt" = v_now, "updatedAt" = v_now, payload = p_draft::jsonb
      WHERE id = p_context->>'submissionId' RETURNING id
    ), receipt AS (
      INSERT INTO public."DomainEvent" (id, "idempotencyKey", "actorId", "offeringId", "classroomInstanceId", "participationId", "researchKey", "eventType", payload)
      VALUES (p_context->>'receiptId', p_context->>'receiptKey', p_context->>'studentId', p_context->>'offeringId', p_context->>'courseId', p_context->>'participationId',
        v_scope."researchKey", 'document_version_submitted', v_payload::jsonb) RETURNING id
    ), audit AS (
      INSERT INTO public."AiInteractionEvent" (id, "idempotencyKey", "userId", "offeringId", "participationId", "researchKey", "eventType", actor, "requestId", content, payload)
      VALUES (p_context->>'auditId', 'ai:' || (p_context->>'receiptKey'), p_context->>'studentId', p_context->>'offeringId', p_context->>'participationId', v_scope."researchKey",
        'submit', 'student', p_receipt_payload->>'requestId', '提交项目实践文档第 ' || v_scope.sequence || ' 版', v_audit::jsonb) RETURNING id
    ), course AS (
      UPDATE public."ClassroomInstance" SET "runtimeConfig" = jsonb_set(
        CASE WHEN jsonb_typeof("runtimeConfig") = 'object' THEN "runtimeConfig" ELSE '{}'::jsonb END, '{version}',
        to_jsonb(COALESCE(("runtimeConfig"->>'version')::numeric, 1) + 1)), "updatedAt" = v_now
      WHERE id = p_context->>'courseId' RETURNING id
    ) SELECT version.id INTO v_written FROM version CROSS JOIN submission CROSS JOIN receipt CROSS JOIN audit CROSS JOIN course;
  IF v_written IS NULL THEN
    RAISE EXCEPTION 'DOCUMENT_ARCHIVE_COMMIT_INCOMPLETE';
  END IF;
  RETURN QUERY SELECT v_payload, false, NULL::text;
END
$function$;
