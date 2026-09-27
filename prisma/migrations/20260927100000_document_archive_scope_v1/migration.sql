-- Additive, versioned helper. Caller must hold the course advisory transaction lock.
-- VOLATILE gives the RETURN QUERY a fresh READ COMMITTED snapshot AFTER the
-- separate PERFORM has finished waiting for a row-only course writer.
CREATE FUNCTION public.openpbl_document_archive_scope_v1(
  p_original jsonb, p_receipt text, p_artifact text, p_submission text,
  p_person text, p_course text, p_student text, p_offering text
) RETURNS TABLE (
  "researchKey" text, "instanceStatus" text, "offeringStatus" text,
  "enrollmentStatus" text, "archivedAt" timestamp(3), "userStatus" text,
  "userRole" text, "sessionVersion" integer, unchanged boolean, receipt jsonb, sequence integer
) LANGUAGE plpgsql VOLATILE SECURITY INVOKER PARALLEL UNSAFE
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'DOCUMENT_ARCHIVE_SCOPE_REQUIRES_READ_COMMITTED' USING ERRCODE = '25001';
  END IF;
  PERFORM ci.id FROM public."ClassroomInstance" ci WHERE ci.id = p_course FOR UPDATE;
  RETURN QUERY
  SELECT e."researchKey", ci.status AS "instanceStatus", o.status AS "offeringStatus",
      e.status AS "enrollmentStatus", a."archivedAt", u.status AS "userStatus", u.role AS "userRole", u."sessionVersion",
      s.payload IS NOT DISTINCT FROM p_original::jsonb AS unchanged,
      (SELECT d.payload FROM public."DomainEvent" d WHERE d."idempotencyKey" = p_receipt) AS receipt,
      COALESCE((SELECT max(v.sequence) FROM public."ArtifactVersion" v WHERE v."artifactId" = p_artifact), 0) + 1 AS sequence
    FROM public."ClassroomParticipation" p JOIN public."Enrollment" e ON e.id = p."enrollmentId"
    JOIN public."User" u ON u.id = e."userId"
    JOIN public."ClassroomInstance" ci ON ci.id = p."instanceId"
    JOIN public."Activity" a ON a.id = ci."activityId" JOIN public."Chapter" c ON c.id = a."chapterId"
    JOIN public."CourseOffering" o ON o.id = c."offeringId"
    JOIN public."ClassroomSubmission" s ON s."participationId" = p.id AND s.id = p_submission
    WHERE p.id = p_person AND ci.id = p_course
      AND e."userId" = p_student AND e."offeringId" = o.id AND o.id = p_offering
    FOR UPDATE OF p;
END
$function$;
