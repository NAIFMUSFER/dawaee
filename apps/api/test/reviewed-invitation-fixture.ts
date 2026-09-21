import type { InjectOptions, LightMyRequestResponse } from 'fastify';

/** Clinical fixtures explicitly perform the same preview/consent round trip
 * as the current client. Negative cases retain the real preview refusal. */
export async function reviewAndAcceptInvitation(
  send: (options: InjectOptions) => Promise<LightMyRequestResponse>,
  request: InjectOptions,
): Promise<LightMyRequestResponse> {
  const preview = await send({ ...request, method: 'POST', url: '/v1/caregivers/invitations/preview' });
  if (preview.statusCode !== 200) return preview;
  const shown = preview.json<{ id: string; role: string; permissions: string[] }>();
  return send({ ...request, method: 'POST', url: '/v1/caregivers/invitations/accept',
    payload: { relationshipId: shown.id, role: shown.role, permissions: shown.permissions } });
}
