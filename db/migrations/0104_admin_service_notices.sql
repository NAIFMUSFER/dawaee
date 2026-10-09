-- Service/update notices only. Reuse the durable push outbox, never email or SMS.
CREATE TABLE service_notices (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 80),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 500),
  locale text NOT NULL CHECK (locale IN ('ar','en')),
  audience text NOT NULL CHECK (audience IN ('self','all')),
  recipient_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  queued_at timestamptz,
  queued_count integer NOT NULL DEFAULT 0
);
REVOKE ALL ON service_notices FROM PUBLIC, dawaee_app, dawaee_worker;
ALTER TABLE service_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_notices FORCE ROW LEVEL SECURITY;
SELECT count(*) FROM app.ensure_definer_policies();

CREATE FUNCTION app.admin_service_notice(
  p_action text, p_id uuid DEFAULT NULL, p_title text DEFAULT NULL,
  p_body text DEFAULT NULL, p_locale text DEFAULT 'ar', p_audience text DEFAULT 'self'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE actor uuid := nullif(current_setting('app.user_id', true),'')::uuid;
  notice public.service_notices%ROWTYPE; targets uuid[]; total integer;
BEGIN
  IF actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.users
      WHERE id=actor AND is_admin AND disabled_at IS NULL AND deletion_requested_at IS NULL) THEN
    RAISE EXCEPTION 'Administrator access required' USING ERRCODE='42501';
  END IF;
  IF p_action='list' THEN
    RETURN (SELECT coalesce(jsonb_agg(x ORDER BY x.created_at DESC),'[]'::jsonb)
      FROM (SELECT id,title,body,locale,audience,created_at,queued_at,queued_count,
        cardinality(recipient_ids) AS eligible_count FROM public.service_notices
        WHERE actor_user_id=actor ORDER BY created_at DESC LIMIT 25) x);
  END IF;
  IF p_id IS NULL OR p_action NOT IN ('preview','send') THEN
    RAISE EXCEPTION 'Invalid notice action' USING ERRCODE='22023';
  END IF;
  -- Serialize replays and concurrent submit clicks for this immutable campaign.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_id::text, 20261009));
  SELECT * INTO notice FROM public.service_notices WHERE id=p_id FOR UPDATE;
  IF notice.id IS NOT NULL AND notice.actor_user_id<>actor THEN
    RAISE EXCEPTION 'Notice unavailable' USING ERRCODE='42501';
  END IF;
  IF p_action='preview' THEN
    IF p_title IS NULL OR p_body IS NULL OR p_locale IS NULL OR p_audience IS NULL
       OR length(btrim(p_title)) NOT BETWEEN 1 AND 80 OR length(btrim(p_body)) NOT BETWEEN 1 AND 500
       OR p_locale NOT IN ('ar','en') OR p_audience NOT IN ('self','all') THEN
      RAISE EXCEPTION 'Invalid notice' USING ERRCODE='22023';
    END IF;
    IF notice.id IS NOT NULL THEN
      IF notice.title<>p_title OR notice.body<>p_body OR notice.locale<>p_locale OR notice.audience<>p_audience THEN
        RAISE EXCEPTION 'Notice is immutable; preview a new notice' USING ERRCODE='22023';
      END IF;
    ELSE
      SELECT coalesce(array_agg(x.id),'{}'::uuid[]) INTO targets FROM (
        SELECT u.id FROM public.users u
        WHERE u.disabled_at IS NULL AND u.deletion_requested_at IS NULL
          AND (p_audience='self' AND u.id=actor OR p_audience='all' AND u.locale=p_locale)
          AND EXISTS (SELECT 1 FROM public.patient_profiles pp WHERE pp.is_self AND pp.archived_at IS NULL
            AND pp.owner_user_id=u.id AND coalesce(pp.linked_user_id,pp.owner_user_id)=u.id)
          AND EXISTS (SELECT 1 FROM public.push_tokens pt JOIN public.auth_sessions s ON s.id=pt.session_id
            AND s.user_id=pt.user_id AND s.device_id=pt.device_id
            WHERE pt.user_id=u.id AND pt.active AND s.revoked_at IS NULL AND s.expires_at>now())
        ORDER BY u.id LIMIT 1001
      ) x;
      IF cardinality(targets)>1000 THEN
        RAISE EXCEPTION 'Audience exceeds the 1000-account safety limit' USING ERRCODE='22023';
      END IF;
      INSERT INTO public.service_notices(id,actor_user_id,title,body,locale,audience,recipient_ids)
        VALUES(p_id,actor,p_title,p_body,p_locale,p_audience,targets) RETURNING * INTO notice;
    END IF;
  ELSE
    IF notice.id IS NULL THEN RAISE EXCEPTION 'Preview required' USING ERRCODE='22023'; END IF;
    IF notice.queued_at IS NULL THEN
      IF notice.created_at<now()-interval '30 minutes' THEN
        RAISE EXCEPTION 'Preview expired; create a new notice' USING ERRCODE='22023';
      END IF;
      INSERT INTO public.notification_deliveries(patient_profile_id,recipient_user_id,kind,channel,
        locale,title,body,payload,dedupe_key,scheduled_for,next_attempt_at)
      SELECT pp.id,u.id,'system','push',notice.locale,notice.title,notice.body,
        jsonb_build_object('serviceNoticeId',notice.id::text),
        'service-notice:'||notice.id::text||':'||u.id::text,now(),now()
      FROM public.users u JOIN public.patient_profiles pp ON pp.owner_user_id=u.id AND pp.is_self
        AND pp.archived_at IS NULL AND coalesce(pp.linked_user_id,pp.owner_user_id)=u.id
      WHERE u.id=ANY(notice.recipient_ids) AND u.disabled_at IS NULL AND u.deletion_requested_at IS NULL
        AND EXISTS (SELECT 1 FROM public.push_tokens pt JOIN public.auth_sessions s ON s.id=pt.session_id
          AND s.user_id=pt.user_id AND s.device_id=pt.device_id
          WHERE pt.user_id=u.id AND pt.active AND s.revoked_at IS NULL AND s.expires_at>now())
      ON CONFLICT (dedupe_key) DO NOTHING;
      GET DIAGNOSTICS total = ROW_COUNT;
      UPDATE public.service_notices SET queued_at=now(),queued_count=total WHERE id=p_id RETURNING * INTO notice;
    END IF;
  END IF;
  RETURN jsonb_build_object('id',notice.id,'title',notice.title,'body',notice.body,
    'locale',notice.locale,'audience',notice.audience,'eligible_count',cardinality(notice.recipient_ids),
    'queued_count',notice.queued_count,'queued_at',notice.queued_at,'created_at',notice.created_at);
END $$;
REVOKE ALL ON FUNCTION app.admin_service_notice(text,uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.admin_service_notice(text,uuid,text,text,text,text) TO dawaee_app;
