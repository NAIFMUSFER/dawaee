import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * Render places every public web service behind Cloudflare and its own load
 * balancers. The edge writes CF-Connecting-IP from the actual connection while
 * X-Forwarded-For can contain caller-supplied entries. When this trust mode is
 * explicitly enabled by deployment configuration, collapse the forwarded chain
 * to the edge-authenticated address before Fastify derives req.ip.
 *
 * Missing or malformed edge metadata fails closed: discard X-Forwarded-For so a
 * caller cannot regain control of req.ip by supplying a forged chain. Fastify
 * then falls back to the socket address; the existing production diagnostic
 * warns if that resolves to infrastructure and therefore collapses clients into
 * one rate-limit bucket.
 */
export const CF_CONNECTING_IP_HEADER = 'cf-connecting-ip';

export function bindTrustedCloudflareClientIp(
  headers: IncomingHttpHeaders,
  enabled: boolean,
): void {
  if (!enabled) return;

  const raw = headers[CF_CONNECTING_IP_HEADER];
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  if (candidate && isIP(candidate)) {
    headers['x-forwarded-for'] = candidate;
    return;
  }

  delete headers['x-forwarded-for'];
}
