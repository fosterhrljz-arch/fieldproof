(() => {
  const {find,check,priorities,uid,event,shift,timestampDay}=FP;
  const responseDefaults={Urgent:4,High:24,Medium:72,Low:168};
  const isReading=q=>q?.kind==='measurement';
  const validNumber=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e12;
  const within=(q,reading)=>(q.min==null||reading>=q.min)&&(q.max==null||reading<=q.max);
  const sources=order=>order.sources?.length ? order.sources : order.inspectionId ?
    [{kind:'inspection',inspectionId:order.inspectionId,questionId:order.questionId,at:order.createdAt,actorId:order.history[0]?.actorId}] : [];
  const inspectionSources=order=>sources(order).filter(source=>source.kind==='inspection');
  function defaults(state) {
    state.faults ||= [];
    state.notices ||= [];
    state.noticeReads ||= {};
    return state;
  }
  const responseHours=(state,priority)=>state.settings.responseHours?.[priority]??responseDefaults[priority];
  const responseTarget=(state,priority,at)=>new Date(Date.parse(at)+responseHours(state,priority)*3600000).toISOString();
  const responseLate=(order,now=Date.now())=>order.status==='Open'&&order.respondBy&&Date.parse(order.respondBy)<now;
  function tighten(state,order,priority) {
    if (priorities.indexOf(priority)>=priorities.indexOf(order.priority)) return;
    order.priority=priority;
    if (!order.respondedAt) {
      const target=responseTarget(state,priority,order.createdAt);
      order.respondBy=order.respondBy&&order.respondBy<target?order.respondBy:target;
    }
  }
  const conflict=()=>{throw Object.assign(new Error('The selected work order is no longer open for this equipment. Review the current orders and try again.'),{status:409});};
  function selectedOrder(state,assetId,id) {
    const order=find(state.work,id);
    if (!order||order.assetId!==assetId||!FP.open(order)) conflict();
    return order;
  }
  function addSource(state,order,source,priority) {
    order.sources=[...sources(order),source];
    tighten(state,order,priority);
    const returns=order.status==='Pending Verification';
    if (returns) order.status='In Progress';
    order.history.push(event(source.at,source.actorId,returns?'Finding linked; verification reset':
      source.kind==='report'?'On-site report linked':'Inspection finding linked',source.inspectionId||source.reportId,returns?'In Progress':''));
    if (order.respondBy) order.history.at(-1).respondBy=order.respondBy;
    return order.id;
  }
  function match(state,inspection,q) {
    const side=(question,result)=>!isReading(question)?'check':question.min!=null&&result.reading<question.min?'low':'high';
    const currentSide=side(q,inspection.results[q.id]);
    return state.work.filter(order=>FP.open(order)&&order.assetId===inspection.assetId&&inspectionSources(order).some(source=>{
      const prior=find(state.inspections,source.inspectionId);
      if (source.questionId!==q.id||prior?.templateId!==inspection.templateId) return false;
      return side(find(prior.questions,q.id),prior.results[q.id])===currentSide;
    }))
      .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))[0];
  }
  function addFindings(state,inspection,decisions,at,actor) {
    const linked=[];
    for (const q of inspection.questions.filter(q=>inspection.results[q.id].value==='Fail')) {
      const decision=decisions?.[q.id]||'auto';
      const existing=decision==='auto'?match(state,inspection,q):decision==='new'?null:selectedOrder(state,inspection.assetId,decision);
      const fields={kind:'inspection',inspectionId:inspection.id,questionId:q.id,at,actorId:actor.id};
      if (existing) {
        linked.push(addSource(state,existing,fields,q.priority));
        continue;
      }
      const order=FP.addWork(state,{title:'Correct: '+q.label,description:inspection.results[q.id].notes,assetId:inspection.assetId,
        assigneeId:find(state.people,state.settings.defaultAssignee)?.available===false?'':state.settings.defaultAssignee,
        priority:q.priority,due:shift(timestampDay(at),state.settings.correctiveDays)},at,actor,fields);
      order.sources=[fields];
      linked.push(order.id);
    }
    return [...new Set(linked)];
  }
  function applyReading(q,result,reading,at,actor) {
    check(isReading(q),'This check does not accept a measurement.');
    check(reading===null||validNumber(reading),'Enter a finite numerical measurement.');
    result.reading=reading;
    result.value=reading===null?'':within(q,reading)?'Pass':'Fail';
    result.at=reading===null?'':at;
    result.recordedBy=reading===null?'':actor.id;
  }
  function questionFields(q) {
    if (!isReading(q)) return {};
    const unit=String(q.unit??'').trim();
    check(unit&&unit.length<=30,'Enter a unit for every measurement.');
    check((q.min==null||validNumber(q.min))&&(q.max==null||validNumber(q.max))&&(q.min!=null||q.max!=null),
      'Enter at least one valid measurement limit.');
    check(q.min==null||q.max==null||q.min<=q.max,'The minimum measurement must be no greater than the maximum.');
    return {kind:'measurement',unit,min:q.min??null,max:q.max??null};
  }
  function applyFault(state,action,at,actor) {
    defaults(state);
    const fields=action.fields||{};
    if (action.type==='reportFault') {
      check(!find(state.faults,action.id),'This fault report already exists.');
      const equipment=find(state.assets,fields.assetId)||find(state.equipmentDirectory||[],fields.assetId);
      check(equipment&&equipment.status!=='Retired','Select an active asset.');
      const title=String(fields.title??'').trim();
      const notes=String(fields.notes??'').trim();
      check(title&&notes,'Enter a fault title and describe what you observed.');
      check(priorities.includes(fields.priority),'Select a priority.');
      const photos=[];
      if (fields.photo) {
        const {src,...meta}=fields.photo;
        state.evidence.push(meta);
        photos.push(meta.id);
      }
      state.faults.push({id:action.id,title,notes,assetId:fields.assetId,priority:fields.priority,photos,
        status:'Reported',reporterId:actor.id,createdAt:at,reviewedAt:'',reviewedBy:'',reviewNote:'',workId:''});
      return action.id;
    }
    const fault=find(state.faults,action.id);
    if (!fault||fault.status!=='Reported') throw Object.assign(new Error('This fault report has already been reviewed.'),{status:409});
    const note=String(fields.notes??'').trim();
    if (action.type==='declineFault') check(note,'Enter a reason for declining the report.');
    if (action.type==='approveFault') {
      const incoming={kind:'report',reportId:fault.id,at,actorId:actor.id};
      if (fields.workId) {
        const existing=selectedOrder(state,fault.assetId,fields.workId);
        fault.workId=addSource(state,existing,incoming,fault.priority);
      } else {
        check(fields.assigneeId,'Choose a repair assignee.');
        const order=FP.addWork(state,{...fields,title:fault.title,description:fault.notes,assetId:fault.assetId},at,actor);
        order.sources=[incoming];
        order.history[0].title='Created from an on-site report';
        order.history[0].note=fault.id;
        fault.workId=order.id;
      }
    }
    Object.assign(fault,{status:fault.workId?'Assigned':'Declined',reviewedAt:at,reviewedBy:actor.id,reviewNote:note});
    return fault.workId||fault.id;
  }
  function inbox(state,account,now=Date.now()) {
    const rows=(state.notices||[]).filter(n=>n.memberId===account.id);
    const today=FP.workspaceDay(state);
    for (const record of state.inspections.filter(r=>r.assigneeId===account.id&&r.status!=='Completed'&&r.due<=today)) {
      rows.push({id:record.id+'-due-'+record.due,kind:record.due<today?'Inspection overdue':'Inspection due today',route:'inspections/run/'+record.id,
        recordId:record.id,title:record.title,at:record.updatedAt});
    }
    for (const order of state.work.filter(w=>w.assigneeId===account.id&&FP.open(w))) {
      const late=responseLate(order,now);
      if (late||order.due<today) rows.push({id:order.id+(late?'-response-'+Date.parse(order.respondBy):'-due-'+order.due),
        kind:late?'Response overdue':'Work order overdue',route:'work/'+order.id,recordId:order.id,title:order.title,at:late?order.respondBy:order.createdAt});
    }
    const read=new Set(state.noticeReads?.[account.id]||[]);
    return rows.sort((a,b)=>b.at.localeCompare(a.at)).slice(0,80).map(row=>({...row,read:read.has(row.id)}));
  }
  function recordNotices(state,action,result,at,actorId,previous) {
    defaults(state);
    const push=(memberId,kind,route,item)=> {
      if (!memberId||memberId===actorId||find(state.people,memberId)?.available===false) return;
      state.notices.push({id:uid(),memberId,kind,route:route+item.id,recordId:item.id,title:item.title,at});
    };
    const managers=state.people.filter(p=>['Supervisor','Admin'].includes(p.role)&&p.available!==false);
    for (const inspection of state.inspections.slice(previous.inspections)) push(inspection.assigneeId,'Inspection assigned','inspections/run/',inspection);
    const created=state.work.slice(previous.work);
    for (const order of created) push(order.assigneeId,'Work order assigned','work/',order);
    const record=find(state.work,action.id);
    if (action.type==='assign'&&record?.assigneeId!==previous.assigneeId) push(record?.assigneeId,'Work order assigned','work/',record);
    if (action.type==='reschedule') {
      const inspection=find(state.inspections,action.id);
      if (inspection.assigneeId!==previous.assigneeId) push(inspection.assigneeId,'Inspection assigned','inspections/run/',inspection);
    }
    if (action.type==='requestReview') managers.filter(p=>!record.repairs.some(r=>r.actorId===p.id||r.contributors?.includes(p.id)))
      .forEach(p=>push(p.id,'Repair ready for review','work/',record));
    if (action.type==='reject' || action.type==='close') push(record.assigneeId,action.type==='reject'?'Repair returned for rework':'Work order closed','work/',record);
    const fault=find(state.faults,action.id);
    if (action.type==='reportFault') managers.forEach(p=>push(p.id,'Fault report needs review','faults/',fault));
    if (action.type==='approveFault'||action.type==='declineFault') push(fault.reporterId,action.type==='approveFault'?'Fault report assigned':'Fault report declined','faults/',fault);
    if (action.type==='approveFault'&&action.fields.workId) {
      const linked=find(state.work,action.fields.workId);
      push(linked.assigneeId,'New evidence on work order','work/',linked);
    }
    if (action.type==='submit') for (const id of result||[]) {
      const order=find(state.work,id);
      if (!created.includes(order)) push(order.assigneeId,'New evidence on work order','work/',order);
    }
    if (state.notices.length>4000) state.notices=state.notices.slice(-4000);
  }
  FP.ops={defaults,responseDefaults,responseHours,responseTarget,responseLate,tighten,sources,inspectionSources,addFindings,applyReading,isReading,validNumber,within,
    questionFields,applyFault,inbox,recordNotices,match};
})();
