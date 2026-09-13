import { updateEscalationPolicySchema as baseUpdateEscalationPolicySchema } from './contracts.js';

/**
 * An enabled escalation ladder must always begin with the patient. The worker
 * treats stage zero as the patient's own reminder, so accepting a caregiver (or
 * an empty ladder) first can suppress that reminder even though later stages are
 * otherwise structurally valid.
 *
 * Disabled policies retain the historical contract and may be empty; the mobile
 * app does not use disabled policies for "never alert family" — it keeps patient
 * reminder stages and removes caregiver stages instead.
 */
export const updateEscalationPolicySchema = baseUpdateEscalationPolicySchema.refine(
  (policy) => !policy.enabled || (policy.stages.length > 0 && policy.stages[0]?.target === 'patient'),
  {
    message: 'enabled escalation policies must start with a patient stage',
    path: ['stages', 0, 'target'],
  },
);
