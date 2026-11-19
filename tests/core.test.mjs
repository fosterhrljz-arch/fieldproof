import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import '../src/core.js';
import '../src/demo.js';
import '../src/storage.js';

const day='2026-11-17';
const time=(date,hour=12)=>new Date(date+'T'+hour+':00:00').toISOString();
const {demo,perform,find,stats,occurrence,shift}=FP;
const make = () => demo(day).state;
const save = (state,action,when=day,hour=12)=>perform(state,action,time(when,hour));
after(()=>FP.storage.channel?.close());

test('a pump failure creates one linked corrective action and retains both repair attempts',()=>{
  const state=make();
  const inspection=find(state.inspections,'IN-1021');
  const before=stats(state,'',30,day);
  assert.throws(()=>save(state,{type:'submit',id:inspection.id,actorId:'jordan'}),/every check/);
  for (const id of ['noise','pressure']) save(state,{type:'result',id:inspection.id,questionId:id,actorId:'jordan',fields:{value:'Pass'}});
  const [id]=save(state,{type:'submit',id:inspection.id,actorId:'jordan'});
  const work=find(state.work,id);
  assert.deepEqual([work.assetId,work.inspectionId,work.questionId,work.priority,work.assigneeId,work.due],['pump',inspection.id,'seal','High','maya',shift(day,3)]);
  assert.throws(()=>save(state,{type:'submit',id:inspection.id,actorId:'jordan'}),/already submitted/);
  assert.equal(state.work.filter(item=>item.inspectionId===inspection.id).length,1);
  assert.equal(stats(state,'',30,day).completed,before.completed+1);
  assert.equal(stats(state,'',30,day).outstanding.length,before.outstanding.length+1);
  save(state,{type:'startWork',id,actorId:'maya'});
  const repair=notes=>{
    save(state,{type:'repairDraft',id,actorId:'maya',fields:{notes}});
    save(state,{type:'requestReview',id,actorId:'maya'});
  };
  assert.throws(()=>save(state,{type:'requestReview',id,actorId:'maya'}),/Describe the repair/);
  repair('Replaced seal. Static check complete.');
  assert.throws(()=>save(state,{type:'close',id,actorId:'maya'}),/supervisor/);
  assert.throws(()=>save(state,{type:'reject',id,fields:{notes:' '}}),/Rework reason/);
  save(state,{type:'reject',id,fields:{notes:'Repeat the leak test with circulation running.'}});
  repair('Dry after 30 minutes at 54 psi.');
  save(state,{type:'close',id,fields:{notes:'Verified independently at the pump.'}});
  assert.equal(work.status,'Closed');
  assert.deepEqual(work.repairs.map(item=>item.notes),['Replaced seal. Static check complete.','Dry after 30 minutes at 54 psi.']);
  assert.deepEqual(work.history.filter(item=>item.status).map(item=>item.status),['Open','In Progress','Pending Verification','In Progress','Pending Verification','Closed']);
  assert.equal(stats(state,'',30,day).outstanding.length,before.outstanding.length);
  assert.equal(stats(state,'harbor',30,day).resolved,stats(make(),'harbor',30,day).resolved+1);
  FP.storage.validate(state,[]);
});

test('recurring scheduling handles month ends and reopening without duplicate occurrences',()=>{
  assert.equal(occurrence('2024-01-31','Monthly',1),'2024-02-29');
  assert.equal(occurrence('2024-01-31','Monthly',2),'2024-03-31');
  const state=make();
  const fields={start:day,assetId:'pump',templateId:'water',assigneeId:'jordan',interval:'Weekly',paused:false};
  const id=save(state,{type:'recurrence',fields});
  const occurrences=()=>state.inspections.filter(item=>item.scheduleId===id);
  assert.equal(occurrences().length,3);
  save(state,{type:'tick'});
  assert.equal(occurrences().length,3);
  save(state,{type:'pause',id});
  save(state,{type:'tick'},shift(day,25));
  assert.equal(occurrences().length,3);
  save(state,{type:'pause',id},shift(day,25));
  assert.deepEqual(occurrences().map(item=>item.due),[0,7,14,28,35].map(offset=>shift(day,offset)));
  FP.storage.validate(state,[]);
});

test('statistics reconcile ranges, sites, backlog and past deadlines',()=>{
  const state=make();
  const current=stats(state,'',30,day);
  const prior=stats(state,'',30,day,30);
  assert.deepEqual([current.completed,current.inspections.length,current.outstanding.length,current.overdue.length,current.resolved],[10,14,12,4,9]);
  assert.equal(current.groups.reduce((sum,item)=>sum+item.closed,0),current.resolved);
  assert.equal(current.distribution.reduce((sum,count)=>sum+count,0),current.outstanding.length+current.resolved);
  assert.equal(prior.end,shift(current.start,-1));
  assert.equal(stats(state,'harbor',30,day).outstanding.length+stats(state,'riverside',30,day).outstanding.length,current.outstanding.length);
  const order=state.work.find(item=>item.title==='Reset rooftop unit safety switch');
  save(state,{type:'assign',id:order.id,fields:{assigneeId:'sam',due:shift(day,5),priority:'High'}});
  assert.equal(stats(state,'',30,day).overdue.length,3);
  assert.equal(stats(state,'',30,day,1).overdue.length,stats(make(),'',30,day,1).overdue.length);
});

test('backup validation rejects broken relationships and missing evidence',()=>{
  const state=make();
  FP.storage.validate(state,[]);
  const corrupt=structuredClone(state);
  corrupt.work.find(item=>item.inspectionId).assetId='door';
  assert.throws(()=>FP.storage.validate(corrupt,[]),/Invalid backup/);
  const draft=find(state.inspections,'IN-1021');
  draft.results.seal.photos.push('missing');
  assert.throws(()=>FP.storage.validate(state,[]),/Invalid backup/);
});
