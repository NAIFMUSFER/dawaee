/** Render actual UI in a network-free browser fixture, not a native/device test.
 * Only account, router, draft storage and transport are replaced. The form,
 * theme, translations, controls, state transitions and RN Web renderer are real.
 * Usage: node scripts/final-audit/build-ui-fixture.mjs [before-ref] [output-dir]
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const mobile = path.join(root, 'apps/mobile');
const ref = process.argv[2] || 'ac44deb05b083520e7bd66d171849a611c2e424e';
const output = path.resolve(process.argv[3] || '/workspace/scratch/tadawee-ui-fixture');
await mkdir(output, { recursive: true });
const state = `
export const preferences = { locale:'ar', elderlyMode:false, highContrast:false, textScale:1, lowStockThresholdDays:7 };
const profile={id:'00000000-0000-4000-8000-000000000001',isSelf:true,displayName:'اختبار فقط',timezone:'Asia/Riyadh'};
export const useApp=()=>({preferences,user:{id:'fixture-user'},activeProfile:profile,profiles:[profile]});
`;
const transport = `
export class ApiError extends Error{}; export class NetworkError extends Error{};
export const api={post:async(path,payload)=>{document.getElementById('payload').textContent=JSON.stringify({path,payload},null,2);return {medication:{id:'fixture-medication'}};}};
`;
const stubs = new Map([
 ['state/app-store', state], ['api/client', transport],
 ['storage/offline-queue', `let n=0;export const newClientEventId=()=> 'fixture-request-'+(++n);`],
 ['storage/medication-draft', 'export const clearMedicationDrafts=()=>{};export const getMedicationPrefillDraft=()=>null;'],
 ['navigation/private-navigation', 'export const setMedicationDetailRouteIntent=()=>{};'],
]);
const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {I18nProvider} from '${mobile}/src/i18n/index.tsx';
import {preferences} from '${mobile}/src/state/app-store.tsx';
import QuickCreate from '${mobile}/app/medication/quick-create.tsx';
function Fixture(){const [version,setVersion]=useState(0);return <>
<div id="controls" dir="ltr"><strong>TADAWEE / __MODE__ / UI fixture only</strong><label>Language <select aria-label="Language" onChange={e=>{preferences.locale=e.target.value;setVersion(version+1)}}><option>ar</option><option>en</option></select></label><label>Text scale <select aria-label="Text scale" onChange={e=>{preferences.textScale=Number(e.target.value);setVersion(version+1)}}><option>1</option><option>1.5</option><option>2</option></select></label></div>
<div id="app"><SafeAreaProvider initialMetrics={{frame:{x:0,y:0,width:360,height:640},insets:{top:0,bottom:0,left:0,right:0}}}><I18nProvider locale={preferences.locale}><QuickCreate key={version}/></I18nProvider></SafeAreaProvider></div><details><summary>Fixture transport payload (not saved to API)</summary><pre id="payload">No request</pre></details></>};
createRoot(document.getElementById('root')).render(<Fixture/>);`;
for (const mode of ['before','after']) {
 const result = await build({stdin:{contents:entry.replace('__MODE__',mode),resolveDir:mobile,loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',minify:true,
  define:{'process.env.NODE_ENV':'"production"',__DEV__:'false'},nodePaths:[path.join(mobile,'node_modules'),path.join(root,'node_modules')],
  alias:{'react-native':'react-native-web','@dawaee/shared':path.join(root,'packages/shared/src/index.ts')},
  plugins:[{name:'fixture-io',setup(b){
   b.onResolve({filter:/\/(SafeAreaView|NativeSafeAreaProvider)$/},args=>args.importer.includes('react-native-safe-area-context')?({path:path.join(mobile,'node_modules/react-native-safe-area-context/lib/module',args.path.split('/').pop()+'.web.js')}):undefined);
   b.onResolve({filter:/^expo-router$/},()=>({path:'router',namespace:'fixture'}));
   b.onResolve({filter:/^(?:@\/|.*(?:state\/app-store|api\/client|storage\/offline-queue|storage\/medication-draft|navigation\/private-navigation))/},args=>{
    for(const [key] of stubs) if(args.path.replace(/\.(js|tsx?)$/,'').endsWith(key))return {path:key,namespace:'fixture'};
    if(args.path.startsWith('@/'))return {path:path.join(mobile,'src',args.path.slice(2))+(/\.[jt]sx?$/.test(args.path)?'': ['i18n'].includes(args.path.slice(2))?'/index.tsx': ['hooks/useRequestScope','hooks/useTheme'].includes(args.path.slice(2))?'.ts':'.tsx')};
   });
   b.onResolve({filter:/^react(?:-dom(?:\/.*)?)?$/},args=>({path:path.join(mobile,'node_modules',args.path==='react'?'react/index.js':args.path==='react-dom/client'?'react-dom/client.js':'react-dom/index.js')}));
   b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='router'?'export const router={back(){},replace(){}};export const useLocalSearchParams=()=>({});':stubs.get(args.path),loader:'js'}));
   if(mode==='before') b.onLoad({filter:/(?:quick-create|Picker|TimeField|i18n)\.(tsx|ts)$/},async args=>{
    const rel=path.relative(root,args.path);if(!rel.startsWith('apps/mobile/')&&!rel.startsWith('packages/shared/'))return;
    return {contents:execFileSync('git',['show',ref+':'+rel],{encoding:'utf8'}),loader:args.path.endsWith('tsx')?'tsx':'ts'};
   });
  }}]});
 await writeFile(path.join(output,mode+'.html'),`<!doctype html><html lang="ar"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}#root{display:flex;flex-direction:column}#controls{font:12px sans-serif;background:#e7f4ec;padding:4px;display:flex;flex-wrap:wrap;gap:4px}#app{flex:1;display:flex;min-height:0}#app>div{flex:1}details{font:10px sans-serif;max-height:100px;overflow:auto;background:white}pre{white-space:pre-wrap}*{box-sizing:border-box}</style><div id="root"></div><script>${result.outputFiles[0].text.replace(/<\/script/gi,'<\\/script')}</script></html>`);
}
await writeFile(path.join(output,'index.html'),`<!doctype html><html><meta charset="utf-8"><title>TADAWEE UI review fixture</title><style>body{font:16px sans-serif;background:#e6ece9}iframe{border:1px solid #567;width:360px;height:640px;background:white}main{display:flex;gap:20px}label{display:block}</style><h1>TADAWEE UI review — synthetic data, no server</h1><label>Viewport <select id="size" onchange="document.querySelectorAll('iframe').forEach(f=>{let [w,h]=this.value.split('x');f.style.width=w+'px';f.style.height=h+'px'})"><option>360x640</option><option>320x568</option><option>412x915</option></select></label><main><section><h2>Before ${ref.slice(0,7)}</h2><iframe title="Before" src="before.html"></iframe></section><section><h2>After candidate</h2><iframe title="After" src="after.html"></iframe></section></main></html>`);
console.log(output);
