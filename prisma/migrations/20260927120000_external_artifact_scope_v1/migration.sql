-- Additive helper. Caller already owns this course's advisory transaction lock.
-- Separate SPI statements are required: SELECT after the row lock gets a fresh
-- READ COMMITTED snapshot even when a row-only writer committed while waiting.
CREATE FUNCTION public.openpbl_external_artifact_scope_v1(p_course text, p_student text, p_receipt text)
RETURNS TABLE (
  status text, "runtimeStages" jsonb, "currentStageIndex" jsonb, "runtimeVersion" jsonb,
  "archivedAt" timestamp(3), "offeringId" text, "offeringStatus" text, "templateStages" jsonb,
  "participationId" text, "researchKey" text, "enrollmentStatus" text, "groupId" text,
  "userStatus" text, "userRole" text, "sessionVersion" integer, "readAllowed" boolean,
  sequence integer, "hasReceipt" boolean
) LANGUAGE plpgsql VOLATILE SECURITY INVOKER PARALLEL UNSAFE
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'EXTERNAL_ARTIFACT_SCOPE_REQUIRES_READ_COMMITTED' USING ERRCODE = '25001';
  END IF;
  PERFORM ci.id FROM public."ClassroomInstance" ci WHERE ci.id = p_course FOR UPDATE;
  RETURN QUERY
  SELECT ci.status, ci."runtimeConfig" -> 'stages' AS "runtimeStages",
        ci."runtimeConfig" -> 'currentStageIndex' AS "currentStageIndex", ci."runtimeConfig" -> 'version' AS "runtimeVersion",
        a."archivedAt", o.id AS "offeringId", o.status AS "offeringStatus",
        CASE WHEN jsonb_typeof(ci."runtimeConfig"->'stages') = 'array' THEN NULL
          ELSE tv.snapshot #> '{design,stages}' END AS "templateStages",
        p.id AS "participationId", e."researchKey", e.status AS "enrollmentStatus", member."groupId",
        u.status AS "userStatus", u.role AS "userRole", u."sessionVersion", (
  NOT EXISTS (SELECT 1 FROM public."ClassroomTemplate" t WHERE t.id = p_course)
  AND CASE WHEN EXISTS (SELECT 1 FROM public."CourseOffering" named WHERE named.id = p_course) THEN
    EXISTS (SELECT 1 FROM public."Enrollment" named_enrollment WHERE named_enrollment."userId" = p_student
      AND named_enrollment."offeringId" = p_course
      AND named_enrollment.status IN ('ACTIVE', 'active', 'COMPLETED', 'completed'))
    ELSE p.id IS NOT NULL AND e."offeringId" = c."offeringId"
      AND e.status IN ('ACTIVE', 'active', 'COMPLETED', 'completed') END) AS "readAllowed",
        COALESCE((SELECT max(v.sequence) FROM public."ArtifactVersion" v JOIN public."Artifact" ar ON ar.id = v."artifactId"
          WHERE ar."participationId" = p.id AND ar.type IN ('PDF_ARCHIVE', 'FILE_ARCHIVE')), 0) + 1 AS sequence,
        EXISTS (SELECT 1 FROM public."DomainEvent" d WHERE d."idempotencyKey" = p_receipt) AS "hasReceipt"
      FROM public."ClassroomInstance" ci JOIN public."Activity" a ON a.id = ci."activityId"
      JOIN public."Chapter" c ON c.id = a."chapterId" JOIN public."CourseOffering" o ON o.id = c."offeringId"
      JOIN public."ClassroomTemplateVersion" tv ON tv.id = ci."templateVersionId"
      LEFT JOIN public."User" u ON u.id = p_student
      LEFT JOIN public."Enrollment" e ON e."userId" = u.id AND e."offeringId" = o.id
      LEFT JOIN public."ClassroomParticipation" p ON p."enrollmentId" = e.id AND p."instanceId" = ci.id
      LEFT JOIN LATERAL (SELECT m."groupId" FROM public."GroupMember" m JOIN public."ProjectGroup" g ON g.id = m."groupId"
        WHERE m."userId" = p_student AND m."leftAt" IS NULL AND g."offeringId" = o.id AND g.status = 'ACTIVE'
        ORDER BY m."joinedAt" DESC, m.id ASC LIMIT 1) member ON true
      WHERE ci.id = p_course;
END
$function$;
