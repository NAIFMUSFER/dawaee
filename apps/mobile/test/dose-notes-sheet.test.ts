import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { createHarness } = require('./profile-screen-harness.cjs');
const screens: any[]=[];
function sheet(canWrite=true, canRead=true) {
  let closes=0;
  const props={profileId:'patient-A',dose:{id:'dose-A',scheduledAt:'2026-09-18T12:00:00Z',scheduledTimezone:'Asia/Riyadh',medication:{name:'Synthetic medicine'}},canWrite,canRead,onClose:()=>closes++};
  const h=createHarness(resolve('apps/mobile/src/components/DoseNotesSheet.tsx'),resolve('apps/mobile/src/hooks/useRequestScope.ts'),{}, {__exportName:'DoseNotesSheet',__props:props});
  h.props=props; h.closes=()=>closes; screens.push(h); return h;
}
afterEach(()=>{for(const h of screens.splice(0))h.unmount();});
describe('dose note entry',()=>{
  it('loads only the chosen dose and persists optional text without confirming the dose',async()=>{
    const h=sheet();
    expect(h.requests[0].payload).toEqual({profileId:'patient-A',doseOccurrenceId:'dose-A'});
    h.requests[0].resolve({notes:[]});await h.flush();
    h.find('Field').onChangeText('  ملاحظة لهذه الجرعة  ');await h.flush();
    const save=h.find('Button',(p:any)=>p.label==='notes.save'); save.onPress();save.onPress();await h.flush();
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]).toMatchObject({method:'POST',route:'/v1/notes',payload:{profileId:'patient-A',doseOccurrenceId:'dose-A',text:'ملاحظة لهذه الجرعة',tags:[]}});
    expect(h.text()).not.toContain('notes.saved');
    h.requests[1].resolve({note:{id:'saved'}});await h.flush();
    expect(h.find('Field').value).toBe(''); expect(h.text()).toContain('notes.saved');
    h.requests[2].resolve({notes:[{id:'saved',text:'ملاحظة لهذه الجرعة',tags:[],recordedAt:'2026-09-18T12:01:00Z'}]});await h.flush();
    expect(h.text()).toContain('ملاحظة لهذه الجرعة');
  });
  it('keeps a failed save draft and disallows empty notes',async()=>{
    const h=sheet(true,false);h.requests[0].resolve({notes:[],ownOnly:true});await h.flush();h.find('Button',(p:any)=>p.label==='notes.save').onPress();expect(h.requests).toHaveLength(1);
    h.find('Field').onChangeText('Keep my draft');await h.flush();h.find('Button',(p:any)=>p.label==='notes.save').onPress();await h.flush();
    h.requests[1].reject(new Error('offline'));await h.flush();
    expect(h.find('Field').value).toBe('Keep my draft'); expect(h.text()).toContain('notes.failed');
  });
  it('honors read and write permissions separately',()=>{
    const readOnly=sheet(false,true);expect(readOnly.find('Field')).toBeNull();expect(readOnly.find('Button',(p:any)=>p.label==='notes.save')).toBeNull();
    const writeOnly=sheet(true,false);expect(writeOnly.requests).toHaveLength(1);expect(writeOnly.requests[0].payload).toEqual({profileId:'patient-A',doseOccurrenceId:'dose-A',own:'true'});
  });
  it('does not apply a previous dose response after the sheet closes',async()=>{
    const h=sheet();h.unmount();h.requests[0].resolve({notes:[{id:'private',text:'PRIVATE-OLD-NOTE',tags:[],recordedAt:''}]});await h.flush();
    expect(h.text()).not.toContain('PRIVATE-OLD-NOTE');
  });
});
