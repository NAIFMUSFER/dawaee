-- Keep medical action time separate from the server acceptance / undo clock.
-- Existing rows retain the original window; replay does not reopen it.
ALTER TABLE dose_occurrences ADD COLUMN confirmed_received_at timestamptz;

-- Recording a dose implies its automatic stock movement, not permission to
-- edit stock manually or read clinical event history. Keep that distinction.
CREATE OR REPLACE FUNCTION app.apply_dose_stock_event(p_dose uuid, p_event bigint)
RETURNS TABLE(remaining_quantity numeric, clamped boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  caller_role text := COALESCE(NULLIF(current_setting('role', true), 'none'), session_user);
  actor_id uuid := app.current_user_id();
  dose_row public.dose_occurrences%ROWTYPE;
  event_row record;
  stock_row public.medication_stock%ROWTYPE;
  movement public.stock_transactions%ROWTYPE;
  delta_value numeric;
  balance_value numeric;
  reason_value public.stock_reason;
BEGIN
  IF caller_role <> 'dawaee_app' OR actor_id IS NULL THEN
    RAISE EXCEPTION 'Dose stock event not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT d.* INTO dose_row FROM public.dose_occurrences d WHERE d.id = p_dose FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(dose_row.patient_profile_id, 'confirm_dose')
    OR NOT app.has_permission(dose_row.patient_profile_id, 'view_medications')
    OR NOT EXISTS (SELECT 1 FROM public.medications m JOIN public.medication_schedules s
      ON s.medication_id = m.id AND s.patient_profile_id = m.patient_profile_id
      WHERE m.id = dose_row.medication_id AND s.id = dose_row.schedule_id
        AND m.patient_profile_id = dose_row.patient_profile_id) THEN
    RAISE EXCEPTION 'Dose stock event not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT e.*, e.xmin AS inserted_xid INTO event_row FROM public.dose_events e
    WHERE e.id = p_event AND e.dose_occurrence_id = p_dose
      AND e.patient_profile_id = dose_row.patient_profile_id AND e.actor_user_id = actor_id
      AND e.type IN ('taken','undone');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dose stock event not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT st.* INTO movement FROM public.stock_transactions st WHERE st.dose_event_id = p_event;
  IF FOUND THEN
    -- A retry observes the original ledger entry and never changes the box.
    RETURN QUERY SELECT movement.balance_after,
      movement.reason = 'dose_taken' AND abs(movement.delta) < dose_row.dose_quantity;
    RETURN;
  END IF;

  -- A previously untracked/unknown-stock take must never consume stock later
  -- just because tracking was subsequently enabled. Only its creating
  -- transaction may apply an event that has no ledger movement yet.
  IF event_row.inserted_xid <> pg_current_xact_id()::xid
    OR EXISTS (SELECT 1 FROM public.dose_events e WHERE e.dose_occurrence_id = p_dose
      AND e.type IN ('taken','skipped','snoozed','undone') AND e.id > p_event) THEN
    RAISE EXCEPTION 'Dose stock event not authorized' USING ERRCODE = '42501';
  END IF;

  IF event_row.type = 'taken' THEN
    IF dose_row.status NOT IN ('taken','taken_late')
      OR dose_row.confirmed_by_user_id IS DISTINCT FROM actor_id
      OR dose_row.client_event_id IS DISTINCT FROM event_row.client_event_id
      OR dose_row.confirmed_at IS DISTINCT FROM event_row.at THEN
      RAISE EXCEPTION 'Dose stock event not authorized' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF dose_row.status NOT IN ('taken','taken_late','skipped') OR dose_row.confirmed_at IS NULL
      OR event_row.at < COALESCE(dose_row.confirmed_received_at, dose_row.confirmed_at)
      OR event_row.at > COALESCE(dose_row.confirmed_received_at, dose_row.confirmed_at) + interval '10 minutes'
      OR event_row.metadata->>'previousStatus' IS DISTINCT FROM dose_row.status::text THEN
      RAISE EXCEPTION 'Dose stock event not authorized' USING ERRCODE = '42501';
    END IF;
    IF dose_row.status = 'skipped' THEN RETURN; END IF;
  END IF;

  SELECT st.* INTO stock_row FROM public.medication_stock st
    WHERE st.medication_id = dose_row.medication_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  -- A preserved historical occurrence can use an older unit even though the
  -- current schedule and newly created stock agree. Never convert implicitly.
  IF stock_row.unit IS DISTINCT FROM dose_row.dose_unit THEN RETURN; END IF;

  IF event_row.type = 'taken' THEN
    IF NOT stock_row.tracking_enabled OR stock_row.remaining_quantity IS NULL THEN RETURN; END IF;
    delta_value := -LEAST(stock_row.remaining_quantity, dose_row.dose_quantity);
    reason_value := 'dose_taken';
  ELSE
    WITH current_take AS (
      SELECT e.id, e.metadata FROM public.dose_events e
       WHERE e.dose_occurrence_id = p_dose AND e.type = 'taken'
       ORDER BY e.id DESC LIMIT 1
    )
    SELECT st.* INTO movement FROM public.stock_transactions st CROSS JOIN current_take e
     WHERE st.dose_occurrence_id = p_dose AND st.reason = 'dose_taken'
       AND (st.dose_event_id = e.id OR
         (e.metadata->>'stockLedgerVersion' IS DISTINCT FROM '1' AND st.dose_event_id IS NULL))
     ORDER BY st.dose_event_id DESC NULLS LAST, st.created_at DESC LIMIT 1;
    IF NOT FOUND THEN RETURN; END IF;
    delta_value := -movement.delta;
    reason_value := 'dose_undone';
  END IF;

  balance_value := stock_row.remaining_quantity + delta_value;
  UPDATE public.medication_stock SET remaining_quantity = balance_value
    WHERE medication_id = dose_row.medication_id;
  INSERT INTO public.stock_transactions
    (medication_id, patient_profile_id, delta, reason, dose_occurrence_id, dose_event_id, balance_after, actor_user_id)
  VALUES (dose_row.medication_id, dose_row.patient_profile_id, delta_value, reason_value,
    p_dose, p_event, balance_value, actor_id);
  RETURN QUERY SELECT balance_value, event_row.type = 'taken' AND abs(delta_value) < dose_row.dose_quantity;
END;
$$;

REVOKE ALL ON FUNCTION app.apply_dose_stock_event(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_dose_stock_event(uuid, bigint) TO dawaee_app;
SELECT app.ensure_definer_policies();
