(() => {
  const {find,check} = FP;
  const manages = role => ['Admin','Supervisor'].includes(role);
  const offlineActions = new Set(['startInspection','result','submit','startWork','repairDraft','requestReview','reportFault']);
  const managerActions = new Set(['place','asset','template','inspection','reschedule','recurrence','pause','work','assign','reject','close','approveFault','declineFault']);
  const actions = new Set([...offlineActions,...managerActions,'settings','readNotice']);
  const error = (status,message) => Object.assign(new Error(message),{status});
  function authorize(state,action,actor) {
    if (!actions.has(action.type)) throw error(400,'Unknown workspace action.');
    if (['reportFault','readNotice'].includes(action.type)) return;
    if (action.type === 'settings') {
      if (actor.role !== 'Admin') throw error(403,'An administrator is required to change workspace settings.');
      return;
    }
    if (managerActions.has(action.type)) {
      if (!manages(actor.role)) throw error(403,'Only managers can perform this action.');
      if (action.type==='close'&&find(state.work,action.id)?.repairs.some(repair=>repair.actorId===actor.id||repair.contributors?.includes(actor.id))) {
        throw error(403,'An independent supervisor must approve this repair.');
      }
      return;
    }
    const record=find(['startInspection','result','submit'].includes(action.type)?state.inspections:state.work,action.id);
    if (!record || (!manages(actor.role) && record.assigneeId !== actor.id)) {
      throw error(403,'This record is no longer assigned to your account or is unavailable.');
    }
  }
  const checklist = inspection => inspection?.questions.map(q=>{
    const result=inspection.results[q.id];
    return [q.id,result.value,result.notes,result.photos,...(q.kind==='measurement'?[result.reading??null]:[])];
  });
  function basis(state,action) {
    const {type,id,questionId,fields={}}=action;
    const inspection=find(state.inspections,id);
    const work=find(state.work,id);
    const inspectionState = inspection && [inspection.assigneeId,inspection.status === 'Completed',inspection.due];
    const workState = work && [work.assigneeId,work.status,work.repairs.length];
    const sameFields = draft => draft && [
      'notes' in fields ? draft.notes:null,'value' in fields ? draft.value:null,
      fields.removePhoto ? draft.photos.includes(fields.removePhoto):null,
      ...('reading' in fields?[draft.reading??null]:[])
    ];
    const versions = {
      result:()=>[inspectionState,sameFields(inspection?.results[questionId])],
      startInspection:()=>inspectionState,
      submit:()=>[inspectionState,checklist(inspection)],
      startWork:()=>workState,
      repairDraft:()=>[workState,sameFields(work?.draft)],
      requestReview:()=>[workState,work?.draft.notes,work?.draft.photos,work?.draft.contributors||[]],
      assign:()=>work&&[work.status,work.assigneeId,work.priority,work.due],
      reject:()=>workState,
      close:()=>workState,
      reschedule:()=>inspection&&[inspectionState,inspection.status],
      asset:()=>find(state.assets,id),
      place:()=>find(state.places,id),
      template:()=>find(state.templates,id),
      recurrence:()=>scheduleConfig(find(state.schedules,id)),
      pause:()=>scheduleConfig(find(state.schedules,id)),
      settings:()=>[state.workspace,state.settings],
      approveFault:()=>find(state.faults||[],id)?.status,
      declineFault:()=>find(state.faults||[],id)?.status
    };
    return JSON.stringify(versions[type]?.() ?? null);
  }
  function scheduleConfig(record) {
    if (!record) return null;
    const {index,...config}=record;
    return config;
  }
  function preview(state,action,actorId) {
    authorize(state,action,find(state.people,actorId));
    if (['submit','requestReview'].includes(action.type)) {
      const safeAction=action.type==='submit' ? {...action,fields:{}} : action;
      FP.perform(structuredClone(state),{...safeAction,actorId},action.localAt);
      state.pendingSubmissions ||= [];
      state.pendingSubmissions.push(action.id);
    } else {
      FP.perform(state,{...action,actorId},action.localAt);
      if (action.type==='reportFault') find(state.faults,action.id).localOnly=true;
    }
  }
  function projection(state,account) {
    const manager=manages(account.role);
    const work=manager ? state.work : state.work.filter(record=>record.assigneeId===account.id);
    const linked=new Map();
    const getSources=order=>FP.ops?.sources(order)||[];
    const faultRefs=new Set();
    if (!manager) for (const order of work) for (const source of getSources(order)) {
      if (source.kind==='report') { faultRefs.add(source.reportId); continue; }
      if (!linked.has(source.inspectionId)) linked.set(source.inspectionId,new Set());
      linked.get(source.inspectionId).add(source.questionId);
    }
    const inspections=manager ? state.inspections : state.inspections.filter(record=>record.assigneeId===account.id||linked.has(record.id));
    const visibleInspections=inspections.map(record=>{
      if (manager || record.assigneeId===account.id) return record;
      const questions=record.questions.filter(q=>linked.get(record.id).has(q.id));
      return {...record,questions,results:Object.fromEntries(questions.map(q=>[q.id,record.results[q.id]]))};
    });
    const faults=(state.faults||[]).filter(fault=>manager||fault.reporterId===account.id||faultRefs.has(fault.id));
    const assetIds=new Set([...work,...visibleInspections,...faults].map(record=>record.assetId));
    const assets=manager?state.assets:state.assets.filter(record=>assetIds.has(record.id));
    const placeIds=new Set(assets.flatMap(record=>FP.chain(state,record.areaId).map(place=>place.id)));
    const photoIds=new Set();
    for (const record of visibleInspections) for (const result of Object.values(record.results)) result.photos.forEach(id=>photoIds.add(id));
    for (const order of work) for (const draft of [order.draft,...order.repairs]) draft.photos.forEach(id=>photoIds.add(id));
    for (const fault of faults) fault.photos.forEach(id=>photoIds.add(id));
    const relevant=new Set([...visibleInspections,...work,...faults].map(record=>record.id));
    const notices=FP.ops?.inbox(state,account).filter(row=>relevant.has(row.recordId))||[];
    const activeAssets=new Set(visibleInspections.filter(record=>record.assigneeId===account.id&&record.status!=='Completed').map(record=>record.assetId));
    const visibleChecks=new Map(visibleInspections.map(record=>[record.id,new Set(record.questions.map(q=>q.id))]));
    const issueLinks=state.work.flatMap(order=>getSources(order).filter(source=>source.kind==='inspection'&&visibleChecks.get(source.inspectionId)?.has(source.questionId))
      .map(source=>({inspectionId:source.inspectionId,questionId:source.questionId,id:order.id,title:order.title,status:order.status})));
    const issueCandidates=state.work.filter(order=>FP.open(order)&&(manager||activeAssets.has(order.assetId))).map(order=>
      ({id:order.id,assetId:order.assetId,title:order.title,status:order.status,priority:order.priority}));
    return {...state,team:true,activeId:account.id,inspections:visibleInspections,work,assets,
      places:manager?state.places:state.places.filter(place=>placeIds.has(place.id)),
      templates:manager?state.templates:[],schedules:manager?state.schedules:[],
      people:state.people.map(({id,name,role,available})=>({id,name,role,available})),
      evidence:state.evidence.filter(photo=>photoIds.has(photo.id)),faults,notices,noticeReads:undefined,issueCandidates,issueLinks,
      equipmentDirectory:state.assets.filter(item=>item.status!=='Retired').map(({id,name,tag})=>({id,name,tag}))};
  }
  function checkAssignment(state,action) {
    for (const key of ['defaultAssignee','assigneeId']) {
      const id=action.fields?.[key];
      if (!id) continue;
      const person=find(state.people,id);
      check(person && person.available !== false, 'Choose an active team member.');
      if (['inspection','reschedule','recurrence'].includes(action.type)) check(person.role !== 'Maintenance','Choose an inspector or manager.');
    }
  }
  FP.team = {manages,offlineActions,actions,authorize,basis,preview,projection,checkAssignment,error};
})();
