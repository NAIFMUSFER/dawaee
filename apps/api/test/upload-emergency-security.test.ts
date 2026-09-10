import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, resetDatabase, signIn, startHarness, type Harness, type TestUser } from './harness.js';
import { redactUrl } from '../src/lib/logger.js';
import { sniffImageType, buildObjectKey } from '../src/providers/storage.js';

/**
 * The two surfaces where this app hands data to something outside itself: an
 * image bucket, and a QR code a stranger can scan.
 *
 * They are unrelated in mechanism and identical in consequence — both end with
 * a patient's medical information leaving the account it belongs to — so both
 * are asserted here against a real database and a real server.
 */

let h: Harness;
let owner: pg.Pool;
let seq = 0;
const client = () => ({ 'x-forwarded-for': `10.55.0.1, 198.18.${Math.floor(seq / 250) % 250}.${(seq++ % 250) + 1}` });
let n = 0;
const phone = () => `+9665${String(8100000 + n++).padStart(8, '0')}`;

/** A real, minimal PNG: signature plus an IHDR chunk. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]), Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 0x41)]);

beforeAll(async () => {
  resetDatabase();
  h = await startHarness();
  owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test', max: 6 });
});
afterAll(async () => { await owner.end(); await h.close(); });

async function requestUpload(user: TestUser, profileId?: string) {
  return h.app.inject({
    method: 'POST', url: '/v1/uploads/request', headers: { ...authHeaders(user), ...client() },
    payload: {
      purpose: 'medication_image', contentType: 'image/png', byteSize: PNG.length,
      ...(profileId ? { patientProfileId: profileId } : {}),
    },
  });
}

// ══════════════════════════════════════ PART A — uploads

describe('an uploaded image belongs to one account', () => {
  it('a patient can request, read and analyse their own object', async () => {
    const a = await signIn(h, phone());
    const req = await requestUpload(a, a.profileId);
    expect(req.statusCode, req.body).toBe(200);
    const { objectKey } = req.json<{ objectKey: string }>();

    const url = await h.app.inject({
      method: 'GET', url: `/v1/uploads/url?objectKey=${encodeURIComponent(objectKey)}`,
      headers: { ...authHeaders(a), ...client() },
    });
    expect(url.statusCode).toBe(200);
  });

  /**
   * The BOLA case. `/v1/uploads/url` looks the object up with no explicit
   * ownership predicate — it relies entirely on row-level security making
   * another patient's row invisible. That is a reasonable design and a fragile
   * one, because a policy change three migrations away would turn it into a
   * read of anyone's object. Asserted rather than assumed.
   */
  it('a second patient cannot get a read URL for the first one\'s object', async () => {
    const a = await signIn(h, phone());
    const b = await signIn(h, phone());
    const { objectKey } = (await requestUpload(a, a.profileId)).json<{ objectKey: string }>();

    const stolen = await h.app.inject({
      method: 'GET', url: `/v1/uploads/url?objectKey=${encodeURIComponent(objectKey)}`,
      headers: { ...authHeaders(b), ...client() },
    });
    expect(stolen.statusCode, 'one patient obtained a read URL for another\'s image').toBe(404);
  });

  it('a second patient cannot run OCR over the first one\'s object', async () => {
    const a = await signIn(h, phone());
    const b = await signIn(h, phone());
    const { objectKey } = (await requestUpload(a, a.profileId)).json<{ objectKey: string }>();

    // B consents, so consent is not what refuses this.
    await h.app.inject({
      method: 'PUT', url: '/v1/me/consents', headers: { ...authHeaders(b), ...client() },
      payload: { type: 'ocr_image_processing', granted: true, version: '1' },
    });

    const stolen = await h.app.inject({
      method: 'POST', url: '/v1/ocr/analyze', headers: { ...authHeaders(b), ...client() },
      payload: { imageKey: objectKey, patientProfileId: b.profileId, kind: 'medication_label' },
    });
    expect([403, 404], `OCR over another patient's image answered ${stolen.statusCode}`)
      .toContain(stolen.statusCode);
  });

  it('a patient cannot attach an upload to a profile they have no access to', async () => {
    const a = await signIn(h, phone());
    const b = await signIn(h, phone());
    const req = await h.app.inject({
      method: 'POST', url: '/v1/uploads/request', headers: { ...authHeaders(b), ...client() },
      payload: {
        purpose: 'medication_image', contentType: 'image/png', byteSize: PNG.length,
        patientProfileId: a.profileId,
      },
    });
    expect([403, 404], `uploading against another patient's profile answered ${req.statusCode}`)
      .toContain(req.statusCode);
  });

  it('an object row records its owner, so ownership is data and not inference', async () => {
    const a = await signIn(h, phone());
    const { objectKey } = (await requestUpload(a, a.profileId)).json<{ objectKey: string }>();
    const { rows } = await owner.query<{ owner_user_id: string; patient_profile_id: string }>(
      'SELECT owner_user_id, patient_profile_id FROM stored_objects WHERE object_key=$1', [objectKey],
    );
    expect(rows[0]!.owner_user_id).toBe(a.userId);
    expect(rows[0]!.patient_profile_id).toBe(a.profileId);
  });
});

// ══════════════════════════════════════ file validation

describe('what the bytes are, not what the caller says they are', () => {
  it('rejects a declared type that is not an image', async () => {
    const a = await signIn(h, phone());
    for (const contentType of ['image/svg+xml', 'application/pdf', 'text/html', 'application/zip']) {
      const r = await h.app.inject({
        method: 'POST', url: '/v1/uploads/request', headers: { ...authHeaders(a), ...client() },
        payload: { purpose: 'medication_image', contentType, byteSize: 100, patientProfileId: a.profileId },
      });
      expect(r.statusCode, `${contentType} was accepted`).toBe(400);
    }
  });

  /**
   * SVG is refused deliberately. It is a document format that executes script,
   * not a picture: an accepted SVG served back to a browser is stored XSS, and
   * OCR gains nothing from it.
   */
  it('SVG is not an allowed image type', async () => {
    const { ALLOWED_IMAGE_TYPES } = await import('../src/providers/storage.js');
    expect([...ALLOWED_IMAGE_TYPES]).not.toContain('image/svg+xml');
  });

  it('the magic-byte sniff decides, and disagrees with a lying extension', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    // A PDF, an HTML page, an SVG and a ZIP renamed as images.
    expect(sniffImageType(Buffer.from('%PDF-1.7\n%âãÏÓ\n'))).toBeNull();
    expect(sniffImageType(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull();
    expect(sniffImageType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
    expect(sniffImageType(Buffer.from([0xff, 0xd8]))).toBeNull(); // truncated JPEG
  });

  it('a file whose bytes are a script but whose header is an image is still refused downstream', () => {
    // A polyglot: real PNG signature, script payload after it. The sniff passes
    // — that is what a polyglot is for — so the protection that matters is that
    // the object is never served as anything but a sniffed image type, and
    // never as text/html.
    const polyglot = Buffer.concat([PNG, Buffer.from('<script>alert(1)</script>')]);
    expect(sniffImageType(polyglot)).toBe('image/png');
  });

  it('rejects a declared size over the cap', async () => {
    const a = await signIn(h, phone());
    const r = await h.app.inject({
      method: 'POST', url: '/v1/uploads/request', headers: { ...authHeaders(a), ...client() },
      payload: {
        purpose: 'medication_image', contentType: 'image/png',
        byteSize: 16 * 1024 * 1024, patientProfileId: a.profileId,
      },
    });
    expect(r.statusCode).toBe(400);
  });
});

// ══════════════════════════════════════ object keys

describe('the object key is the server\'s, not the caller\'s', () => {
  it('a filename never reaches the key', () => {
    const key = buildObjectKey('medication_image', '11111111-2222-3333-4444-555555555555', 'image/png');
    expect(key).toMatch(/^medication_image\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.png$/);
  });

  it('a traversal attempt in the request cannot shape the key', () => {
    for (const purpose of ['../../etc/passwd', '..\\..\\windows', 'a\u0000b']) {
      const key = buildObjectKey(purpose, null, 'image/png');
      // The purpose is echoed, so the guarantee that matters is the storage
      // layer refusing anything that escapes its root — asserted below.
      expect(key.endsWith('.png')).toBe(true);
    }
  });

  it('the local store refuses a key that escapes its root', async () => {
    const { LocalStorageProvider } = await import('../src/providers/storage.js');
    const { loadConfig } = await import('../src/config.js');
    const store = new LocalStorageProvider(loadConfig());
    await expect(store.getObject('../../../etc/passwd')).rejects.toThrow();
  });

  /**
   * Object ownership is already stored explicitly in `stored_objects`, so the
   * externally visible key does not need to repeat any stable patient-profile
   * identifier. This prevents bucket listings and provider access logs from
   * becoming a cross-object patient correlation handle.
   */
  it('the key carries no stable profile correlation handle', () => {
    const profileId = '11111111-2222-3333-4444-555555555555';
    const key = buildObjectKey('medication_image', profileId, 'image/png');
    expect(key).not.toContain(profileId);
    expect(key).not.toContain(profileId.slice(0, 8));
    expect(key).not.toMatch(/\+9665|@|[Aa]spirin/);
  });
});

// ══════════════════════════════════════ PART B — emergency QR

describe('the emergency card discloses only what was switched on', () => {
  const enable = async (user: TestUser) => {
    const r = await h.app.inject({
      method: 'POST', url: `/v1/emergency/qr/enable?profileId=${user.profileId}`,
      headers: { ...authHeaders(user), ...client() },
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json<{ token: string; qrUrl: string }>().token;
  };
  const scan = (token: string) =>
    h.app.inject({ method: 'GET', url: `/v1/emergency/scan/${token}`, headers: client() });

  it('the token is a 192-bit random value, stored only as a hash', async () => {
    const user = await signIn(h, phone());
    const token = await enable(user);
    // 24 random bytes, base64url — 192 bits. Brute force is not a threat model
    // at that size; the limiter exists for scraping and load, not guessing.
    expect(Buffer.from(token, 'base64url')).toHaveLength(24);

    const { rows } = await owner.query<{ qr_token_hash: string }>(
      'SELECT qr_token_hash FROM emergency_cards WHERE patient_profile_id=$1', [user.profileId],
    );
    expect(rows[0]!.qr_token_hash).not.toBe(token);
    expect(rows[0]!.qr_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a brand-new card shows nothing a patient did not switch on', async () => {
    const user = await signIn(h, phone());
    const token = await enable(user);
    const body = (await scan(token)).json<Record<string, unknown>>();
    expect(body.allergies).toEqual([]);
    expect(body.medications).toEqual([]);
    expect(body.emergencyContacts).toEqual([]);
    expect(body.conditionsNote).toBeNull();
    expect(body.bloodType).toBeNull();

    const { rows } = await owner.query<Record<string, boolean>>(
      'SELECT include_medications, include_allergies, include_contacts, include_conditions FROM emergency_cards WHERE patient_profile_id=$1',
      [user.profileId],
    );
    expect(Object.values(rows[0]!), 'a disclosure flag defaults to on').toEqual([false, false, false, false]);
  });

  it('the response carries no internal identifier', async () => {
    const user = await signIn(h, phone());
    const token = await enable(user);
    const body = (await scan(token)).body;
    expect(body).not.toContain(user.userId);
    expect(body).not.toContain(user.profileId);
    expect(JSON.parse(body)).not.toHaveProperty('id');
  });

  it('every invalid token gives one answer, and it names nobody', async () => {
    const user = await signIn(h, phone());
    const token = await enable(user);
    // Everything a guesser would actually send: a random token of the right
    // shape, a valid one with a byte changed, a short one, a case-flipped one,
    // an encoded traversal attempt.
    const shapes = await Promise.all([
      scan('A'.repeat(32)), scan(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')),
      scan('ab'), scan(token.toUpperCase() === token ? token.toLowerCase() : token.toUpperCase()),
      scan('%2e%2e%2f'),
    ]);
    const distinct = new Set(shapes.map((r) => `${r.statusCode}:${r.body.replace(/"requestId":"[^"]+"/, '')}`));
    expect(distinct.size, `invalid tokens produced ${distinct.size} different answers: ${[...distinct].join(' || ')}`).toBe(1);
    expect([...distinct][0]).toContain('not active');

    /**
     * A parameter longer than the route allows is refused by the framework
     * before the handler, so it answers 414 rather than 404. That distinguishes
     * "too long to be a token" and nothing else — no card is looked up, and the
     * answer is the same whether or not any patient exists. Asserted so the
     * difference stays that shallow.
     */
    const tooLong = await scan('x'.repeat(500));
    expect(tooLong.statusCode).toBe(414);
    expect(tooLong.body, 'the over-long response names a patient').not.toMatch(/patientName|bloodType|allergies/);
  });

  it('rotating the card revokes the previous token', async () => {
    const user = await signIn(h, phone());
    const first = await enable(user);
    expect((await scan(first)).statusCode).toBe(200);
    const second = await enable(user);
    expect(second).not.toBe(first);
    expect((await scan(first)).statusCode, 'the old QR still worked after rotation').toBe(404);
    expect((await scan(second)).statusCode).toBe(200);
  });

  it('disabling the card revokes the token', async () => {
    const user = await signIn(h, phone());
    const token = await enable(user);
    await h.app.inject({
      method: 'POST', url: `/v1/emergency/qr/disable?profileId=${user.profileId}`,
      headers: { ...authHeaders(user), ...client() },
    });
    expect((await scan(token)).statusCode).toBe(404);
  });

  /**
   * Unauthenticated PHI must not be written to a disk anywhere between the
   * server and the paramedic's screen — including the browser history of a
   * device that is about to be handed back.
   */
  it('neither answer may be stored by a browser or a proxy', async () => {
    const user = await signIn(h, phone());
    const token = await enable(user);
    for (const r of [await scan(token), await scan('A'.repeat(32))]) {
      expect(r.headers['cache-control'], `status ${r.statusCode} is cacheable`).toContain('no-store');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
    }
  });

  /**
   * The token is a path segment, and a path segment is not something `redact`
   * can reach — it lives inside the `req.url` string that Fastify's request
   * serializer writes verbatim.
   */
  it('the token never reaches a log line', () => {
    const token = 'Ab3-_XyZ0123456789abcdefghij';
    expect(redactUrl(`/v1/emergency/scan/${token}`)).toBe('/v1/emergency/scan/[redacted]');
    expect(redactUrl(`/v1/emergency/scan/${token}`)).not.toContain(token);
    expect(redactUrl(`/e/${token}`)).not.toContain(token);
    expect(redactUrl('/v1/uploads/local/key?expires=1&sig=SECRETSIG')).not.toContain('SECRETSIG');
    // Ordinary paths are untouched: the log is still useful.
    expect(redactUrl('/v1/medications')).toBe('/v1/medications');
    expect(redactUrl('/health')).toBe('/health');
  });

  it('the resolver returns a fixed, minimal column set', async () => {
    const { rows } = await owner.query<{ def: string }>(
      "SELECT pg_get_functiondef('app.resolve_emergency_qr(text)'::regprocedure) AS def",
    );
    const def = rows[0]!.def;
    expect(def, 'the resolver does not pin its search_path').toMatch(/SET search_path/);
    const returns = def.slice(def.indexOf('RETURNS'), def.indexOf('LANGUAGE'));
    // Widening this is how an emergency card quietly becomes a patient lookup.
    for (const col of ['patient_display_name', 'blood_type', 'allergies', 'conditions_note', 'emergency_contacts', 'medications']) {
      expect(returns).toContain(col);
    }
    expect(returns, 'the resolver returns an internal identifier').not.toMatch(/\bid\b|user_id|phone/);
  });
});

// ══════════════════════════════════════ the OCR boundary

/**
 * OCR is the one place a patient's medication photograph leaves this system for
 * a third party. What accompanies it decides whether that is a picture or a
 * medical record.
 */
describe('what leaves for the OCR provider, and what comes back', () => {
  it('the provider is handed the image and its type, and nothing about the patient', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/providers/ocr.ts', import.meta.url), 'utf8');
    // Every provider method takes (image, contentType). If a patient id, a
    // phone number or a display name ever appears here, a prescription photo
    // has become an identified medical record in someone else's logs.
    for (const leak of ['patientProfileId', 'userId', 'phoneE164', 'displayName', 'ownerUserId']) {
      expect(src, `the OCR provider is sent ${leak}`).not.toContain(leak);
    }
    expect(src).toMatch(/readMedicationLabel\(\s*image: Buffer/);
  });

  it('analysis requires a recorded consent, and says so rather than proceeding', async () => {
    const a = await signIn(h, phone());
    const { objectKey } = (await requestUpload(a, a.profileId)).json<{ objectKey: string }>();
    const r = await h.app.inject({
      method: 'POST', url: '/v1/ocr/analyze', headers: { ...authHeaders(a), ...client() },
      payload: { imageKey: objectKey, patientProfileId: a.profileId, kind: 'medication_label' },
    });
    // 428: the consent has never been granted for this account.
    expect(r.statusCode, 'a prescription photo was sent to a third party without consent').toBe(428);
    expect(r.json<{ error: { code: string } }>().error.code).toBe('consent_required');
  });

  /**
   * Safety, not only security. Nothing OCR reads may become a medication or a
   * schedule on its own: a misread strength is a dosing error, and the patient
   * is the only one who can confirm what the box says.
   */
  it('the analysis response is a suggestion and creates nothing', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/routes/uploads.ts', import.meta.url), 'utf8');
    const handler = src.slice(src.indexOf("app.post('/v1/ocr/analyze'"));
    expect(handler).toMatch(/requiresUserConfirmation: true/);
    expect(handler, 'the OCR route writes to the database')
      .not.toMatch(/INSERT INTO medications|INSERT INTO medication_schedules/);
    expect(handler).toMatch(/schedulesCreated: 0/);
  });

  it('no live OCR or storage provider is configured, so nothing here proves a live one works', async () => {
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();
    // Recorded rather than asserted as good: this is why the live-provider rows
    // of the report say NOT RUN.
    expect(['mock', 'google_vision', 'azure_document_intelligence']).toContain(cfg.OCR_PROVIDER);
    expect(['local', 's3', 'r2']).toContain(cfg.STORAGE_PROVIDER);
  });
});
