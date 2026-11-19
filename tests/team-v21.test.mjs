import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {mkdtemp,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startFieldProof} from '../server.mjs';
import {act,createTeam,createEquipment,schedule,envelope,setupCode} from './team-fixtures.mjs';

let server,profiles,members,equipment,measurement,orderId;
const newReading=async (client,id,value,notes,photo)=>{
  const inspection=(await client('workspace')).state.inspections.find(item=>item.id===id);
  const questionId=inspection.questions[0].id;
  return act(client,{type:'result',id,questionId,fields:{reading:value,notes,...(photo?{photo}:{})}});
};
const photo=async name=>({id:randomUUID(),name,at:new Date().toISOString(),w:1536,h:1024,
  src:'data:image/jpeg;base64,'+(await readFile(new URL('../src/demo-pump.jpg',import.meta.url))).toString('base64')});
before(async()=>{
  const file=join(await mkdtemp(join(tmpdir(),'fieldproof-v21-')),'fieldproof.sqlite');
  server=await startFieldProof({port:0,file,setupCode});
  ({profiles,members}=await createTeam(server.origin));
  equipment=await createEquipment(profiles.admin,members);
  const {result}=await act(profiles.admin,{type:'template',fields:{name:'Pump thermal inspection',questions:[
    {label:'轴承温度 / Bearing temperature',kind:'measurement',unit:'°C',min:15,max:75,priority:'High'}
  ]}});
  measurement={...equipment,template:result};
});
after(()=>server?.close());

test('measurement classification is server-owned and uses the scheduled, inclusive range',async()=>{
  const id=await schedule(profiles.admin,measurement,members.inspector);
  const {state}=await profiles.inspector('workspace');
  const [check]=state.inspections.find(record=>record.id===id).questions;
  assert.equal(check.kind,'measurement');
  await act(profiles.inspector,{type:'result',id,questionId:check.id,fields:{value:'Pass'}},400);
  await act(profiles.inspector,{type:'result',id,questionId:check.id,fields:{reading:'75'}},400);
  await act(profiles.admin,{type:'template',id:measurement.template,fields:{name:'Pump thermal inspection',questions:[
    {id:check.id,label:check.label,kind:'measurement',unit:'°C',min:20,max:75,priority:'High'}
  ]}});
  const low=await newReading(profiles.inspector,id,15,'');
  assert.equal(low.state.inspections.find(record=>record.id===id).results[check.id].value,'Pass');
  const high=await newReading(profiles.inspector,id,75,'');
  assert.equal(high.state.inspections.find(record=>record.id===id).results[check.id].value,'Pass');
  assert.deepEqual((await act(profiles.inspector,{type:'submit',id})).result,[]);
});

test('concurrent failed inspections link into one order and preserve all photos and readings',async()=>{
  const a=await schedule(profiles.admin,measurement,members.inspector);
  const b=await schedule(profiles.admin,measurement,members.inspector);
  const [photoA,photoB]=await Promise.all([photo('轴承高温.jpg'),photo('热测第二次.jpg')]);
  await newReading(profiles.inspector,a,86.25,'轴承过热 / Bearing overheating',photoA);
  await newReading(profiles.inspector,b,91.5,'重复异常 / Repeated overheat',photoB);
  const baseline=(await profiles.inspector('workspace')).state;
  const results=await Promise.all([a,b].map(id=>profiles.inspector('actions',envelope(baseline,{type:'submit',id}))));
  [orderId]=results[0].result;
  assert.deepEqual(results[1].result,[orderId]);
  const {state}=await profiles.technician('workspace');
  assert.equal(state.work.length,1);
  assert.equal(state.work[0].sources.length,2);
  assert.deepEqual(new Set(state.evidence.map(item=>item.id)),new Set([photoA.id,photoB.id]));
  assert.deepEqual(state.inspections.map(row=>row.results[row.questions[0].id].reading),[86.25,91.5]);
  assert.equal((await profiles.technician('photos/'+photoB.id)).name,photoB.name);
  assert.equal((await profiles.unrelated('workspace')).state.issueCandidates.length,0);
  const inbox=state.notices.map(row=>row.kind);
  assert.ok(inbox.includes('Work order assigned')&&inbox.includes('New evidence on work order'));
});

test('fault report triage, explicit links, priority targets, and notice reads are durable',async()=>{
  const {admin,inspector,supervisor,technician}=profiles;
  await act(admin,{type:'settings',fields:{workspace:'Harborstone Facilities',defaultAssignee:members.technician,correctiveDays:3,
    responseHours:{Urgent:1,High:8,Medium:24,Low:72}}});
  await act(technician,{type:'startWork',id:orderId});
  await act(technician,{type:'repairDraft',id:orderId,fields:{notes:'Lubricated and cooled the bearing.'}});
  await act(technician,{type:'requestReview',id:orderId});
  const after=await schedule(admin,measurement,members.inspector);
  const draft=await newReading(inspector,after,87,'High after the first repair.');
  const qid=draft.state.inspections.find(row=>row.id===after).questions[0].id;
  await act(inspector,{type:'submit',id:after,fields:{decisions:{[qid]:orderId}}});
  const reopened=(await supervisor('workspace')).state.work.find(w=>w.id===orderId);
  assert.equal(reopened.status,'In Progress');
  assert.equal(reopened.history.at(-1).title,'Finding linked; verification reset');

  const id=randomUUID();
  await act(inspector,{type:'reportFault',id,fields:{assetId:equipment.asset,title:'联轴器防护罩裂纹',notes:'Cracked coupling guard / 防护罩裂纹',priority:'Urgent',photo:await photo('防护罩.jpg')}});
  await act(inspector,{type:'approveFault',id,fields:{assigneeId:members.technician,priority:'Urgent',due:FP.localDay()}},403);
  const review=(await supervisor('workspace')).state;
  assert.equal(review.faults.find(item=>item.id===id).status,'Reported');
  assert.ok(review.notices.some(item=>item.kind==='Fault report needs review'));
  const approved=await act(supervisor,{type:'approveFault',id,fields:{assigneeId:members.technician,priority:'Urgent',due:FP.shift(FP.localDay(),2),notes:'Replace damaged guard.'}});
  const created=approved.state.work.find(item=>item.id===approved.result);
  assert.equal(Date.parse(created.respondBy)-Date.parse(created.createdAt),3600000);
  assert.equal(FP.ops.responseLate(created,Date.parse(created.respondBy)+1),true);
  assert.equal(created.sources[0].reportId,id);
  const reporter=(await inspector('workspace')).state;
  const notice=reporter.notices.find(n=>n.kind==='Fault report assigned');
  assert.equal(notice.read,false);
  await act(inspector,{type:'readNotice',id:notice.id});
  assert.equal((await inspector('workspace')).state.notices.find(n=>n.id===notice.id).read,true);
  const backup=await admin('backup');
  FP.storage.validate(backup.state,backup.images);
  const saved=await admin('restore',{backup,revision:backup.state.revision});
  assert.equal(saved.state.faults.find(item=>item.id===id).workId,created.id);
  assert.equal(saved.state.work.find(item=>item.id===orderId).sources.length,3);
});

test('a selected order closed before submission causes no half-submitted inspection',async()=>{
  const {admin,inspector,supervisor,technician}=profiles;
  await act(technician,{type:'repairDraft',id:orderId,fields:{notes:'Repeated thermal test under load; normal.'}});
  await act(technician,{type:'requestReview',id:orderId});
  const id=await schedule(admin,measurement,members.inspector);
  const {state}=await newReading(inspector,id,84,'Reading from an offline check.');
  const qid=state.inspections.find(row=>row.id===id).questions[0].id;
  const command=envelope(state,{type:'submit',id,fields:{decisions:{[qid]:orderId}}});
  await act(supervisor,{type:'close',id:orderId,fields:{notes:'Independent acceptance.'}});
  await inspector('actions',command,409);
  assert.equal((await inspector('workspace')).state.inspections.find(item=>item.id===id).status,'Draft');
  const separate=await act(inspector,{type:'submit',id,fields:{decisions:{[qid]:'new'}}});
  assert.notEqual(separate.result[0],orderId);
});
