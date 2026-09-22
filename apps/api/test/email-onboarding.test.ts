import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmailAccount, resetDatabase, startHarness, type Harness } from './harness.js';
let h: Harness;
beforeAll(async()=>{resetDatabase();h=await startHarness();});
afterAll(async()=>{await h.close();});
describe('new registration email requirement',()=>{
  it('rejects a phone-only registration',async()=>{
    const r=await h.app.inject({method:'POST',url:'/v1/auth/register',payload:{phone:'+966501234891',displayName:'Email required',password:'Strong test phrase 491!',deviceId:'email-required-fixture'}});
    expect(r.statusCode).toBe(426);
  });
  it('creates no bootstrap session before mailbox proof; a completed fixture starts verified and usable',async()=>{
    const email='onboarding@example.test',password='Strong test phrase 892!';
    const r=await h.app.inject({method:'POST',url:'/v1/auth/register',payload:{email,deviceId:'onboarding-fixture'}});
    expect(r.statusCode,r.body).toBe(202);
    expect(r.json().accessToken).toBeUndefined();
    expect((await h.app.inject({method:'POST',url:'/v1/auth/login',payload:{identifier:email,password,deviceId:'before-proof'}})).statusCode).toBe(401);
    const completed=await createEmailAccount(h,email,'New patient',password,'after-proof');
    const headers={authorization:`Bearer ${completed.token}`};
    const me=await h.app.inject({url:'/v1/me',headers});
    expect(me.json().user).toMatchObject({email,emailVerified:true,emailVerificationRequired:false});
    const profiles=await h.app.inject({url:'/v1/profiles',headers});const id=profiles.json().profiles[0].id;
    const read=()=>h.app.inject({url:`/v1/notes?profileId=${id}`,headers});
    expect((await read()).statusCode).toBe(200);
    expect((await h.app.inject({method:'POST',url:'/v1/notes',headers,payload:{profileId:id,text:'Usable'}})).statusCode).toBe(200);
  });
});
