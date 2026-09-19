import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmTestEmail, resetDatabase, startHarness, type Harness } from './harness.js';
let h: Harness;
beforeAll(async()=>{resetDatabase();h=await startHarness();});
afterAll(async()=>{await h.close();});
describe('new registration email requirement',()=>{
  it('rejects a phone-only registration',async()=>{
    const r=await h.app.inject({method:'POST',url:'/v1/auth/register',payload:{phone:'+966501234891',displayName:'Email required',password:'Strong test phrase 491!',deviceId:'email-required-fixture'}});
    expect(r.statusCode).toBe(400);
  });
  it('permits bootstrap but blocks clinical reads and writes until mailbox proof, including a fresh login',async()=>{
    const email='onboarding@example.test',password='Strong test phrase 892!';
    const r=await h.app.inject({method:'POST',url:'/v1/auth/register',payload:{email,displayName:'New patient',password,deviceId:'onboarding-fixture'}});
    expect(r.statusCode,r.body).toBe(200);
    const headers={authorization:`Bearer ${r.json().accessToken}`};
    const me=await h.app.inject({url:'/v1/me',headers});
    expect(me.json().user).toMatchObject({email,emailVerified:false,emailVerificationRequired:true});
    const profiles=await h.app.inject({url:'/v1/profiles',headers});const id=profiles.json().profiles[0].id;
    const read=()=>h.app.inject({url:`/v1/notes?profileId=${id}`,headers});
    expect((await read()).statusCode).toBe(403);
    expect((await h.app.inject({method:'POST',url:'/v1/notes',headers,payload:{profileId:id,text:'Blocked'}})).statusCode).toBe(403);
    const login=await h.app.inject({method:'POST',url:'/v1/auth/login',payload:{identifier:email,password,deviceId:'onboarding-fixture-2'}});
    expect(login.statusCode).toBe(200);
    expect((await h.app.inject({url:`/v1/notes?profileId=${id}`,headers:{authorization:`Bearer ${login.json().accessToken}`}})).statusCode).toBe(403);
    confirmTestEmail(me.json().user.id);
    expect((await read()).statusCode).toBe(200);
    const verified=await h.app.inject({url:'/v1/me',headers});
    expect(verified.json().user).toMatchObject({id:me.json().user.id,emailVerified:true,emailVerificationRequired:false});
  });
});
