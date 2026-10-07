import type { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditTransaction, createAuditDatabase } from './independent-audit-db.js';
vi.mock('../src/lib/db.js', async original => ({
  ...await original<typeof import('../src/lib/db.js')>(),
  withTransaction: (fn: (tx: PoolClient) => Promise<unknown>) => auditTransaction(db,'dawaee_app',fn),
  withUser: (uid: string,fn:(tx:PoolClient)=>Promise<unknown>)=>auditTransaction(db,'dawaee_app',fn,uid),
}));
import { registerRegistrationCodeRoutes } from '../src/routes/registration-code.js';
import { registerErrorHandler } from '../src/middleware/error-handler.js';
import { openEmailJob, accountEmailContent } from '../src/providers/account-email.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/lib/password.js';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { googleIdentity, verifyGoogleTokenClaims } from '../src/auth/google-token.js';
let db:PGlite;
const http=Fastify();
const owner=(sql:string,args:unknown[]=[])=>auditTransaction(db,'dawaee_migrator',tx=>tx.query(sql,args));
beforeAll(async()=>{db=await createAuditDatabase();registerErrorHandler(http);registerRegistrationCodeRoutes(http);await http.ready();},60_000);
afterAll(async()=>{await http.close();await db?.close();});
const request=(email:string,ip:string)=>http.inject({method:'POST',url:'/v1/auth/registration-code/request',remoteAddress:ip,payload:{email,locale:'en'}});
const complete=(email:string,challenge:string,code:string,password='Synthetic code password 583!')=>http.inject({method:'POST',url:'/v1/auth/registration-code/complete',remoteAddress:'198.18.80.1',payload:{email,locale:'en',challenge,code,password,displayName:'V2 account',deviceId:'v2-device'}});
async function mail(email:string){const row=(await owner('SELECT payload FROM email_registration_challenges WHERE email=$1',[email])).rows[0];return openEmailJob(row.payload);}
describe('in-app registration with real SQL and restricted runtime role',()=>{
 it('creates no identity before proof, then creates a verified account and live session inside the app',async()=>{
  const email='v2-code@example.test';const res=await request(email,'198.18.80.2');expect(res.statusCode,res.body).toBe(202);
  expect((await owner('SELECT count(*)::int AS n FROM users WHERE email=$1',[email])).rows[0].n).toBe(0);
  const message=await mail(email);expect(message.code).toMatch(/^\d{6}$/);
  const content=accountEmailContent(message,loadConfig());expect(content.text).not.toContain('/account-email');
  const challenge=res.json().challenge;
  expect((await complete(email,challenge,'999999'===message.code?'999998':'999999')).statusCode).toBe(403);
  const verified=await complete(email,challenge,message.code!);expect(verified.statusCode,verified.body).toBe(200);expect(verified.json().accessToken).toBeTruthy();
  expect((await owner('SELECT count(*)::int AS n FROM user_email_verifications WHERE email=$1',[email])).rows[0].n).toBe(1);
  // A consumed code cannot override/reset a credential or create a new account.
  expect((await complete(email,challenge,message.code!,'Another strong password 456!')).statusCode).toBe(403);
 });
 it('bounds guesses across distributed client IPs for the same challenge',async()=>{
  const email='v2-limit@example.test';const res=await request(email,'198.18.80.3');const challenge=res.json().challenge;
  const msg=await mail(email);const wrong=msg.code==='111111'?'222222':'111111';
  for(let i=0;i<5;i++)expect((await complete(email,challenge,wrong)).statusCode).toBe(403);
  expect((await complete(email,challenge,msg.code!)).statusCode).toBe(429);
 });
 it('rejects expired codes',async()=>{
  const email='v2-expired@example.test';const res=await request(email,'198.18.80.4');const msg=await mail(email);
  await owner("UPDATE email_registration_challenges SET expires_at=now()-interval '1 second' WHERE email=$1",[email]);
  expect((await complete(email,res.json().challenge,msg.code!)).statusCode).toBe(403);
 });
});
describe('Google identity boundary',()=>{
 it('refuses unverified and non-authoritative mailbox identities',()=>{
  expect(()=>googleIdentity({sub:'g1',email:'x@gmail.com',email_verified:false})).toThrow();
  expect(()=>googleIdentity({sub:'g1',email:'x@example.com',email_verified:true})).toThrow();
  expect(googleIdentity({sub:'g1',email:'x@gmail.com',email_verified:true}).subject).toBe('g1');
 });
 it('stores stable subject, preserves passwords and rejects suspended accounts and subject collisions',async()=>{
  const hash=await hashPassword('Google fixture password 792!');
  const resolve=(sub:string,email:string)=>auditTransaction(db,'dawaee_app',tx=>tx.query('SELECT * FROM app.resolve_google_account($1,$2,$3,$4,$5)',[sub,email,'Google fixture',hash,'en']));
  const made=(await resolve('google-fixture-sub','v2google@gmail.com')).rows[0];expect(made.created).toBe(true);
  const again=(await resolve('google-fixture-sub','renamed@gmail.com')).rows[0];expect(again.user_id).toBe(made.user_id);expect(again.created).toBe(false);
  expect((await resolve('different-sub','v2google@gmail.com')).rows[0].user_id).toBeNull();
  expect((await owner('SELECT password_hash FROM user_credentials WHERE user_id=$1',[made.user_id])).rows[0].password_hash).toBe(hash);
  await owner('UPDATE users SET disabled_at=now() WHERE id=$1',[made.user_id]);
  expect((await resolve('google-fixture-sub','v2google@gmail.com')).rows[0].user_id).toBeNull();
  const denied=await auditTransaction(db,'dawaee_app',async tx=>{try{await tx.query('SELECT * FROM google_auth_identities');return false;}catch{return true;}});
  expect(denied).toBe(true);
 });
});

describe('Google signed-token verification', () => {
 it('checks signature, issuer, audience, expiration and email ownership', async () => {
  const pair = await generateKeyPair('RS256');
  const jwk = await exportJWK(pair.publicKey);
  const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'fixture', alg: 'RS256' }] });
  const token = (overrides: Record<string, unknown> = {}, key = pair.privateKey) => new SignJWT({
    sub: 'verified-sub', email: 'fixture@gmail.com', email_verified: true,
    iss: 'https://accounts.google.com', aud: 'allowed-client', iat: Math.floor(Date.now()/1000),
    exp: Math.floor(Date.now()/1000) + 300, ...overrides,
  }).setProtectedHeader({alg:'RS256',kid:'fixture'}).sign(key);
  const check = async (overrides: Record<string, unknown> = {}) => verifyGoogleTokenClaims(await token(overrides), ['allowed-client'], keys);
  await expect(check()).resolves.toMatchObject({subject:'verified-sub'});
  await expect(check({aud:'foreign-client'})).rejects.toThrow();
  await expect(check({iss:'https://attacker.test'})).rejects.toThrow();
  await expect(check({exp:Math.floor(Date.now()/1000)-1})).rejects.toThrow();
  await expect(check({email_verified:false})).rejects.toThrow();
  const attacker = await generateKeyPair('RS256');
  await expect(verifyGoogleTokenClaims(await token({},attacker.privateKey),['allowed-client'],keys)).rejects.toThrow();
 });
});
