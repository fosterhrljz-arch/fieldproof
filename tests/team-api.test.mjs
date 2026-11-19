import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {startFieldProof} from '../server.mjs';
import {api,act,createTeam,createEquipment,schedule,envelope,setupCode,testPassword,people} from './team-fixtures.mjs';
import '../src/demo.js';

let server,port,db,members,profiles,equipment;
let inspection,order;
before(async()=>{
  db=join(await mkdtemp(join(tmpdir(),'fieldproof-api-')),'fieldproof.sqlite');
  server=await startFieldProof({port:0,file:db,setupCode});
  port=server.server.address().port;
  ({profiles,members}=await createTeam(server.origin));
  equipment=await createEquipment(profiles.admin,members);
  inspection=await schedule(profiles.admin,equipment,members.inspector);
});
after(async()=>server?.close());

test('authentication, account isolation and manager permissions are enforced by the API',async()=>{
  const {admin,inspector,technician,unrelated,supervisor}=profiles;
  await api(server.origin)('workspace',undefined,401);
  await api(server.origin)('login',{email:people.admin.email,password:'wrong-password'},401);
  const {state}=await inspector('workspace');
  assert.deepEqual(state.inspections.map(record=>record.id),[inspection]);
  assert.equal((await unrelated('workspace')).state.inspections.length,0);
  assert.equal((await technician('workspace')).state.assets.length,0);
  const q=state.inspections[0].questions[0];
  await act(unrelated,{type:'result',id:inspection,questionId:q.id,fields:{value:'Pass'}},403);
  await act(inspector,{type:'reschedule',id:inspection,fields:{assigneeId:members.unrelated,due:FP.localDay()}},403);
  await act(inspector,{type:'settings',fields:{workspace:'Renamed',correctiveDays:1}},403);
  await inspector('members',undefined,403);
  await inspector('backup',undefined,403);
  await act(supervisor,{type:'settings',fields:{workspace:'Renamed',correctiveDays:1}},403);
  await admin('logout',{},403,{origin:'https://external.invalid'});
  await inspector('workspace',undefined,401,{'X-FieldProof-Account':members.admin});
});

test('record edits merge across fields, reject same-field conflicts, and replay submissions once',async()=>{
  const client=profiles.inspector;
  const second=api(server.origin);
  await second('login',{email:people.inspector.email,password:testPassword});
  const {state}=await client('workspace');
  const [seal,pressure,noise]=state.inspections[0].questions;
  const firstNote=envelope(state,{type:'result',id:inspection,questionId:seal.id,fields:{notes:'Water below the leaking pump seal.'}});
  const outdated=envelope(state,{type:'result',id:inspection,questionId:seal.id,fields:{notes:'Overwritten description'}});
  await client('actions',firstNote);
  await second('actions',outdated,409);
  const independent=envelope(state,{type:'result',id:inspection,questionId:pressure.id,fields:{value:'Pass'}});
  await second('actions',independent);
  await act(client,{type:'result',id:inspection,questionId:seal.id,fields:{value:'Fail'}});
  await act(client,{type:'result',id:inspection,questionId:noise.id,fields:{value:'Pass'}});
  const photo={id:randomUUID(),name:'pump seal.jpg',at:new Date().toISOString(),w:1536,h:1024,
    src:'data:image/jpeg;base64,'+(await readFile(new URL('../src/demo-pump.jpg',import.meta.url))).toString('base64')};
  await act(client,{type:'result',id:inspection,questionId:seal.id,fields:{photo}});
  await profiles.unrelated('photos/'+photo.id,undefined,404);
  const latest=(await client('workspace')).state;
  const command=envelope(latest,{type:'submit',id:inspection});
  const responses=await Promise.all([client('actions',command),second('actions',command)]);
  assert.equal(responses.filter(result=>result.duplicate).length,1);
  assert.deepEqual(responses[0].result,responses[1].result);
  [order]=responses[0].result;
  assert.equal((await profiles.admin('workspace')).state.work.filter(record=>record.inspectionId===inspection).length,1);
  const worker=(await profiles.technician('workspace')).state;
  assert.equal(worker.inspections[0].questions.length,1);
  assert.equal(worker.work[0].id,order);
  assert.equal((await profiles.technician('photos/'+photo.id)).src,photo.src);
});

test('the repair contributor cannot approve. A different manager can close and preserve the audit chain',async()=>{
  const {admin,supervisor,technician,inspector}=profiles;
  await act(inspector,{type:'assign',id:order,fields:{priority:'Urgent',assigneeId:members.inspector,due:FP.localDay()}},403);
  await act(technician,{type:'startWork',id:order});
  await act(technician,{type:'repairDraft',id:order,fields:{notes:'Replaced the shaft seal and pressure-tested the connection.'}});
  await act(supervisor,{type:'repairDraft',id:order,fields:{notes:'Observed the preliminary check and documented a maximum of 54 psi.'}});
  await act(technician,{type:'requestReview',id:order});
  await act(supervisor,{type:'close',id:order,fields:{notes:'I helped with this repair.'}},403);
  await act(technician,{type:'close',id:order,fields:{notes:''}},403);
  await act(admin,{type:'reject',id:order,fields:{notes:'Run the pump for 30 additional minutes.'}});
  await act(technician,{type:'repairDraft',id:order,fields:{notes:'Dry after a full operating check at 54 psi.'}});
  await act(technician,{type:'requestReview',id:order});
  await act(supervisor,{type:'close',id:order,fields:{notes:''}},403);
  const closed=await act(admin,{type:'close',id:order,fields:{notes:'Verified on site independently.'}});
  assert.deepEqual(closed.state.work[0].history.map(e=>e.status),['Open','In Progress','Pending Verification','In Progress','Pending Verification','Closed']);
  assert.equal(closed.state.work[0].repairs.length,2);
  assert.equal(closed.state.work[0].history.at(-1).actorId,members.admin);
  assert.equal(FP.stats(closed.state,'',30).resolved,1);
  assert.ok((await admin('audit')).some(entry=>entry.action==='submit'&&entry.actor===members.inspector));
});

test('recurrence, role changes and revocation preserve record ownership',async()=>{
  const {admin,unrelated}=profiles;
  const recurring=await act(admin,{type:'recurrence',fields:{templateId:equipment.template,assetId:equipment.asset,assigneeId:members.unrelated,start:FP.localDay(),interval:'Weekly'}});
  assert.equal(recurring.state.inspections.filter(i=>i.scheduleId===recurring.result).length,3);
  const member=(await admin('members')).find(row=>row.id===members.unrelated);
  await admin('members',{id:member.id,version:member.version,name:member.name,role:member.role,enabled:false});
  await unrelated('workspace',undefined,401);
  await admin('members',{id:member.id,version:member.version,name:member.name,role:member.role,enabled:true},409);
});

test('durable server restart and v1 backup import preserve relations without granting account access',async()=>{
  const backup=await profiles.admin('backup');
  await server.close();
  server=await startFieldProof({port,file:db,setupCode});
  assert.equal((await profiles.admin('workspace')).state.work.find(w=>w.id===order).status,'Closed');
  await profiles.unrelated('workspace',undefined,401);
  assert.equal(backup.images.length,1);
  const {state:legacy}=FP.demo();
  const current=await profiles.admin('workspace');
  const legacyFile={format:'FieldProof backup',version:1,state:legacy,images:[]};
  await profiles.admin('restore',{backup:legacyFile,revision:current.state.revision-1},409);
  const restored=await profiles.admin('restore',{backup:legacyFile,revision:current.state.revision});
  assert.equal(restored.state.assets.length,legacy.assets.length);
  assert.notEqual(restored.state.workspaceKey,current.state.workspaceKey);
  assert.ok(restored.state.people.some(p=>p.id==='morgan'&&p.available===false));
  assert.equal((await profiles.inspector('workspace')).state.inspections.length,0);
  assert.ok((await profiles.admin('audit')).some(entry=>entry.action==='workspace-restore'));
  await profiles.admin('restore',{backup,revision:restored.state.revision});
  assert.equal((await profiles.admin('workspace')).state.work.find(w=>w.id===order).status,'Closed');
});
