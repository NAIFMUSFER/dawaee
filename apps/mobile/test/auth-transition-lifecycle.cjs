/** Complete checked-in AppProvider; controlled hooks, token storage and I/O.
 * Not a React renderer or a device/HTTP/database integration test. No network.
 * Account names and credentials below are synthetic. Ref updates require render.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise,resolve,reject }; }
async function flush() { for(let i=0;i<100;i++) await Promise.resolve(); }
async function until(p) { for(let i=0;i<300&&!p();i++) await Promise.resolve(); assert.ok(p(), 'controlled boundary not reached'); }
const profile = a => ({id:`SELF-${a}`,displayName:`Synthetic ${a}`,role:'owner',isSelf:true,permissions:null,timezone:'Asia/Riyadh'});
const me = a => ({user:{id:a,displayName:`Synthetic ${a}`,phoneE164:null},preferences:{locale:'en'}});
const same = (a,b) => a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
function harness(file) {
 const h={requests:[],events:[],account:'A',clock:1000,store:async()=>{},clear:async()=>{},device:async()=>'DEVICE',cancel:async()=>{},purge:async()=>{},destroy:async()=>{},remote:async()=>({}),flushCalls:0,owner:'A'};
 const slots=[],effects=[];let cursor=0,unauth;
 const hooks={createContext:()=>({Provider:'Provider'}),useContext:()=>null,
  useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]={...initial,ready:true,signedIn:true,user:me('A').user,profiles:[profile('A')],activeProfile:profile('A')};return[slots[i],u=>{slots[i]=typeof u==='function'?u(slots[i]):u;}];},
  useRef:initial=>{const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},
  useMemo:(fn,deps)=>{const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={deps,value:fn()};return slots[i].value;},
  useCallback:(fn,deps)=>hooks.useMemo(()=>fn,deps),
  useEffect:(effect,deps)=>{const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps)){slots[i]={deps};effects.push(effect);}},
 };
 const request=(method,route,payload)=>{const r={method,route,payload,account:h.account,done:false,...deferred()};h.requests.push(r);
  if(method==='DELETE'||method==='POST'||method==='PATCH')Promise.resolve().then(()=>h.remote(r)).then(v=>{r.done=true;r.resolve(v);},r.reject);
  return r.promise;};
 const imports={react:hooks,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
  'expo-localization':{getLocales:()=>[{languageCode:'en'}]},
  '../api/client.js':{api:{get:r=>request('GET',r),post:(r,p)=>request('POST',r,p),delete:r=>request('DELETE',r),patch:(r,p)=>request('PATCH',r,p)},
   NetworkError:class NetworkError extends Error{},isSignedIn:()=>h.account!==null,
   getDeviceId:()=>h.device(),loadStoredSession:async()=>!!h.account,setUnauthenticatedHandler:fn=>{unauth=fn;},
   storeSession:async t=>{h.account=t.accessToken;h.events.push(['store',h.account]);await h.store(t);},
   clearSession:async()=>{h.events.push(['clear',h.account]);h.account=null;await h.clear();}},
  '../api/restored-session-owner.js':{getRestoredSessionUserId:async()=>h.account},
  '../storage/offline-queue.js':{setCacheOwner:id=>{h.owner=id;h.events.push(['owner',id]);},purgeLocalCaches:id=>{h.events.push(['purge',id]);return h.purge(id);},queueSize:async()=>0,flushQueue:async()=>{h.flushCalls++;return{offline:true};}},
  '../storage/cache-key.js':{destroyCacheKey:id=>{h.events.push(['destroy',id]);return h.destroy(id);}},
  '../notifications/index.js':{cancelAllLocalNotifications:()=>{h.events.push(['cancel']);return h.cancel();},rebuildRemindersFromCache:async()=>{}},
  '../i18n/index.js':{applyNativeDirection:()=>({restartRequired:false})},
 };
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const exports={};class Clock extends Date{static now(){return ++h.clock;}}
 vm.runInNewContext(code,{exports,Date:Clock,console,require:id=>{if(!(id in imports))throw Error(`unmocked import ${id}`);return imports[id];}},{filename:file});
 let value;h.render=()=>{cursor=0;value=exports.AppProvider({children:null}).props.value;return value;};h.actions=()=>value;h.state=()=>slots[0];
 h.pending=route=>h.requests.filter(r=>r.method==='GET'&&r.route===route&&!r.done);
 h.reply=(r,b)=>{assert.ok(r,'pending request');r.done=true;r.resolve(b);};
 h.mount=()=>{for(const effect of effects.splice(0))effect();};h.unauth=async()=>{assert.ok(unauth);h.account=null;await unauth();};
 h.render();return h;
}
async function next(h,route,account) {await until(()=>h.pending(route).some(r=>!account||r.account===account));return h.pending(route).find(r=>!account||r.account===account);}
async function finishLogin(h,a) {h.reply(await next(h,'/v1/me',a),me(a));h.reply(await next(h,'/v1/profiles',a),{profiles:[profile(a)]});}
const signIn=(h,a)=>h.actions().signInWithTokens({accessToken:a,refreshToken:`SYNTHETIC-${a}`});
async function finishStrayReads(h) {for(let i=0;i<6;i++){await flush();for(const r of h.pending('/v1/me'))h.reply(r,me(r.account));for(const r of h.pending('/v1/profiles'))h.reply(r,{profiles:[profile(r.account)]});}}
function scenarios(file) {
 const cases=[];const add=(name,run)=>cases.push({name,run:()=>run(harness(file))});
 add('positive: current password login still commits credential verification',async h=>{const p=signIn(h,'B');await finishLogin(h,'B');await p;assert.equal(h.state().user.id,'B');assert.ok(h.state().credentialVerifiedAt>1000);});
 add('login intent waiting its first cleanup turn cannot overtake a later logout',async h=>{const login=signIn(h,'B');const logout=h.actions().signOut();await finishStrayReads(h);await Promise.all([login,logout]);assert.equal(h.events.filter(e=>e[0]==='store').length,0,'cancelled login stored credentials');assert.equal(h.state().credentialVerifiedAt,null);});
 add('late first-stage login response cannot mark a signed-out session credential-verified',async h=>{const p=signIn(h,'B');const r=await next(h,'/v1/me','B');await h.actions().signOut();h.render();h.reply(r,me('B'));await finishStrayReads(h);await p;assert.equal(h.state().signedIn,false);assert.equal(h.state().credentialVerifiedAt,null,'stale login set credential marker');});
 add('late profile-stage login completion cannot overwrite the next account credential marker',async h=>{const old=signIn(h,'B');h.reply(await next(h,'/v1/me','B'),me('B'));const oldProfile=await next(h,'/v1/profiles','B');const newer=signIn(h,'C');await finishLogin(h,'C');await newer;h.render();const mark=h.state().credentialVerifiedAt;h.reply(oldProfile,{profiles:[profile('B')]});await old;assert.equal(h.state().user.id,'C');assert.equal(h.state().credentialVerifiedAt,mark,'old login supplied a fresh credential marker for C');});
 add('logout during a pending credential write cannot later gain a credential marker',async h=>{const g=deferred();h.store=()=>g.promise;const p=signIn(h,'B');await until(()=>h.events.some(e=>e[0]==='store'));await h.actions().signOut();h.render();g.resolve();await p;assert.equal(h.state().credentialVerifiedAt,null);assert.equal(h.state().signedIn,false);});
 add('logout clears the previous account credential marker',async h=>{const p=signIn(h,'A');await finishLogin(h,'A');await p;h.render();assert.ok(h.state().credentialVerifiedAt);await h.actions().signOut();assert.equal(h.state().credentialVerifiedAt,null);});
 add('a new login waits for the explicit logout remote phase and local sweep',async h=>{const gate=deferred();h.remote=r=>r.method==='DELETE'?gate.promise:{};const out=h.actions().signOut();await until(()=>h.requests.some(r=>r.method==='DELETE'));const login=signIn(h,'B');await flush();const storedTooEarly=h.events.some(e=>e[0]==='store');gate.resolve({});await out;await finishStrayReads(h);await login;assert.equal(storedTooEarly,false,'B credentials entered during A logout');assert.equal(h.state().user.id,'B');assert.equal(h.account,'B');assert.deepEqual(h.events.filter(e=>e[0]==='destroy'),[['destroy','A']]);});
 add('a new login waits for a delayed local cache purge',async h=>{const gate=deferred();h.purge=()=>gate.promise;const out=h.actions().signOut();await until(()=>h.events.some(e=>e[0]==='purge'));const login=signIn(h,'B');await flush();const early=h.events.some(e=>e[0]==='store');gate.resolve();await out;await finishStrayReads(h);await login;assert.equal(early,false,'new account was written while the global sweep was active');assert.equal(h.state().user.id,'B');assert.equal(h.account,'B');});
 add('duplicate explicit logout coalesces destructive cleanup',async h=>{const g=deferred();h.remote=r=>r.method==='DELETE'?g.promise:{};const a=h.actions().signOut(),b=h.actions().signOut();await flush();g.resolve({});await Promise.all([a,b]);assert.equal(h.events.filter(e=>e[0]==='purge').length,1,'duplicate global cache sweeps');assert.equal(h.events.filter(e=>e[0]==='clear').length,1);});
 add('logout invalidates local reminders and visible identity before network completion',async h=>{const g=deferred();h.device=()=>g.promise;const out=h.actions().signOut();await flush();const observed={cancel:h.events.some(e=>e[0]==='cancel'),signedIn:h.state().signedIn,owner:h.owner};g.resolve('DEVICE');await out;assert.equal(observed.cancel,true,'local cancellation waited for remote cleanup');assert.equal(observed.signedIn,false);assert.equal(observed.owner,null);});
 add('device-id failure still performs logout and local privacy cleanup',async h=>{h.device=async()=>{throw Error('synthetic device storage failure');};const failure=await h.actions().signOut().catch(e=>e);assert.equal(failure,undefined,'device-id error escaped before cleanup');assert.equal(h.state().signedIn,false);assert.equal(h.account,null);assert.ok(h.events.some(e=>e[0]==='cancel'));assert.ok(h.events.some(e=>e[0]==='purge'));assert.ok(h.events.some(e=>e[0]==='destroy'&&e[1]==='A'));});
 add('credential-delete failure must not skip destroying local clinical data',async h=>{h.clear=async()=>{throw Error('synthetic keychain deletion failure');};await h.actions().signOut().catch(()=>undefined);assert.equal(h.state().signedIn,false);assert.ok(h.events.some(e=>e[0]==='purge'));assert.ok(h.events.some(e=>e[0]==='destroy'&&e[1]==='A'));});
 add('positive: remote failures do not trap the current logout',async h=>{h.remote=async()=>{throw Error('synthetic remote unavailable');};await h.actions().signOut();assert.equal(h.state().signedIn,false);assert.equal(h.account,null);assert.ok(h.events.some(e=>e[0]==='destroy'));});
 add('profile refresh and sync do not start using the retiring session during logout',async h=>{const g=deferred();h.remote=r=>r.method==='DELETE'?g.promise:{};const out=h.actions().signOut();await until(()=>h.requests.some(r=>r.method==='DELETE'));const reload=h.actions().refreshProfiles(),sync=h.actions().syncNow();await flush();const gets=h.requests.filter(r=>r.method==='GET').length;await finishStrayReads(h);g.resolve({});await Promise.all([reload,sync,out]);assert.equal(gets,0,'new profile read used retiring credentials');assert.equal(h.flushCalls,0);});
 add('preference writes do not persist into a retiring session during logout',async h=>{const g=deferred();h.remote=r=>r.method==='DELETE'?g.promise:{preferences:{}};const out=h.actions().signOut();await until(()=>h.requests.some(r=>r.method==='DELETE'));await h.actions().updatePreferences({locale:'ar'});g.resolve({});await out;assert.equal(h.requests.filter(r=>r.method==='PATCH').length,0);});
 add('a forced rejection during explicit logout cannot shorten its barrier or cancel the waiting new login',async h=>{
  h.mount();await finishLogin(h,'A');await flush();h.render();
  const remote=deferred();h.remote=r=>r.method==='DELETE'?remote.promise:{};
  const out=h.actions().signOut();await until(()=>h.requests.some(r=>r.method==='DELETE'));
  const login=signIn(h,'B');await h.unauth();await flush();
  const early=h.events.some(e=>e[0]==='store');remote.resolve({});await out;
  await finishStrayReads(h);await login;
  assert.equal(early,false,'forced rejection bypassed explicit logout barrier');assert.equal(h.state().user?.id,'B');assert.equal(h.account,'B');
 });
 add('login waiting for forced cleanup is superseded by a later explicit logout',async h=>{
  h.mount();await finishLogin(h,'A');await flush();h.render();
  const gate=deferred();h.purge=()=>gate.promise;const forced=h.unauth();await until(()=>h.events.some(e=>e[0]==='purge'));
  const login=signIn(h,'B'),out=h.actions().signOut();await flush();gate.resolve();
  await forced;await out;await finishStrayReads(h);await login;
  assert.equal(h.events.filter(e=>e[0]==='store').length,0,'superseded waiting login reentered after logout');assert.equal(h.state().signedIn,false);
 });
 add('positive: current credential write failure is still reported to the caller',async h=>{
  const error=Error('synthetic credential write failure');h.store=async()=>{throw error;};
  assert.equal(await signIn(h,'B').catch(e=>e),error);assert.equal(h.state().credentialVerifiedAt,null);
 });
 return cases;
}
module.exports={scenarios,harness,deferred,flush,until,finishLogin,next};
if(require.main===module)(async()=>{let failed=0;for(const c of scenarios(process.argv[2])){try{let done=false,error;c.run().then(()=>{done=true;},e=>{done=true;error=e;});for(let i=0;i<12000&&!done;i++)await Promise.resolve();assert.ok(done,'scenario unresolved: not a success');if(error)throw error;console.log(`PASS ${c.name}`);}catch(e){failed++;console.log(`FAIL ${c.name}\n  ${e.message}`);}}console.log(JSON.stringify({total:scenarios(process.argv[2]).length,failed}));process.exitCode=failed?1:0;})();
