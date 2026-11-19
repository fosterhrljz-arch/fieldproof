(() => {
  const DAY = 86400000;
  const statuses = ['Open', 'In Progress', 'Pending Verification', 'Closed'];
  const priorities = ['Urgent', 'High', 'Medium', 'Low'];
  const assetStates = ['In service', 'Out of service', 'Retired'];
  const roles = ['Inspector', 'Maintenance', 'Supervisor', 'Admin'];
  const kinds = ['Site', 'Building', 'Area'];
  const intervals = ['Weekly', 'Every two weeks', 'Monthly', 'Quarterly'];
  const find = (list, id) => list.find(item => item.id === id);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const required = (value, label) => {
    const clean = String(value ?? '').trim();
    check(clean.length > 0, label + ' is required.');
    return clean;
  };
  const uid = () => globalThis.crypto?.randomUUID?.() ??
    Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const localDay = (date = new Date()) => [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index ? 2 : 4, '0')).join('-');
  const asDate = day => new Date(day + 'T12:00:00');
  const shift = (day, amount) => {
    const date = asDate(day);
    date.setDate(date.getDate() + amount);
    return localDay(date);
  };
  const validDate = day => /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(+asDate(day)) && localDay(asDate(day)) === day;
  const dateValue = (day, label = 'Due date') => {
    check(validDate(day), 'Choose a valid ' + label.toLowerCase() + '.');
    return day;
  };
  const timestampDay = iso => iso ? localDay(new Date(iso)) : '';
  const zoneFormatters = new Map();
  const zonedDay = (date,timeZone) => {
    if (!timeZone) return localDay(date);
    if (!zoneFormatters.has(timeZone)) zoneFormatters.set(timeZone,new Intl.DateTimeFormat('en',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}));
    const parts=zoneFormatters.get(timeZone).formatToParts(date);
    const field=type=>parts.find(part=>part.type===type).value;
    return field('year')+'-'+field('month')+'-'+field('day');
  };
  const workspaceDay = state => zonedDay(new Date(),state?.timeZone);
  const chain = (state, areaId) => {
    const area = find(state.places, areaId);
    const building = find(state.places, area?.parentId);
    const site = find(state.places, building?.parentId);
    return [site, building, area].filter(Boolean);
  };
  const location = (state, asset) => chain(state, asset?.areaId).map(place => place.name).join(' / ');
  const assetSite = (state, assetId) => chain(state, find(state.assets, assetId)?.areaId)[0]?.id;
  const sequence = (state, kind) => {
    state.sequence[kind] += 1;
    return (kind === 'inspection' ? 'IN-' : 'WO-') + String(state.sequence[kind]).padStart(4, '0');
  };
  const event = (at, actorId, title, note = '', status = '') => ({at, actorId, title, note, status});
  const statusAt = (work, day, timeZone) => work.history.filter(entry => zonedDay(new Date(entry.at),timeZone) <= day && entry.status).at(-1)?.status;
  const open = work => work.status !== 'Closed';
  const isOverdue = (work, today = localDay()) => open(work) && work.due < today;
  const history = (work, at, actor, title, note, status = '') => {
    work.history.push(event(at, actor.id, title, note, status));
    if (status) work.status = status;
  };
  const makeInspection = (state, fields, at, scheduleId = '') => {
    const template = find(state.templates, fields.templateId);
    const asset = find(state.assets, fields.assetId);
    check(template && !template.archived, 'Select an active inspection template.');
    check(asset && asset.status !== 'Retired', 'Select an active asset.');
    check(find(state.people, fields.assigneeId), 'Select an inspector.');
    const record = {
      id: sequence(state, 'inspection'), templateId: template.id, title: template.name, assetId: asset.id,
      assigneeId: fields.assigneeId, due: dateValue(fields.due), scheduleId, status: 'Scheduled',
      createdAt: at, updatedAt: at, startedAt: '', submittedAt: '', submittedBy: '',
      questions: template.questions.map(question => ({...question})),
      results: Object.fromEntries(template.questions.map(q => [q.id, {value: '', notes: '', photos: [], at: '', recordedBy: ''}]))
    };
    state.inspections.push(record);
    return record;
  };
  const addWork = (state, fields, at, actor, source = {}) => {
    check(find(state.assets, fields.assetId), 'Select an asset.');
    check(!fields.assigneeId || find(state.people, fields.assigneeId), 'Select a valid assignee.');
    check(priorities.includes(fields.priority), 'Select a priority.');
    const record = {
      id: sequence(state, 'work'), title: required(fields.title, 'Title'), assetId: fields.assetId,
      description: String(fields.description ?? '').trim(), due: dateValue(fields.due),
      assigneeId: fields.assigneeId || '', priority: fields.priority, status: 'Open',
      inspectionId: source.inspectionId || '', questionId: source.questionId || '',
      createdAt: at, closedAt: '', draft: {notes: '', photos: []}, repairs: [],
      history: [{...event(at, actor.id, source.inspectionId ? 'Created from failed inspection check' : 'Work order created', '', 'Open'),due: fields.due}]
    };
    if (state.team&&FP.ops) {
      record.respondBy=FP.ops.responseTarget(state,record.priority,at);
      record.history[0].respondBy=record.respondBy;
    }
    state.work.push(record);
    return record;
  };
  const occurrence = (start, interval, index) => {
    if (interval === 'Weekly' || interval === 'Every two weeks') return shift(start, index * (interval === 'Weekly' ? 7 : 14));
    const first = asDate(start);
    const target = new Date(first.getFullYear(), first.getMonth() + index * (interval === 'Monthly' ? 1 : 3), 1, 12);
    const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(first.getDate(), last));
    return localDay(target);
  };
  const materialize = (state, at) => {
    const through = shift(timestampDay(at), 14);
    let count = 0;
    for (const schedule of state.schedules.filter(item => !item.paused)) {
      const template = find(state.templates, schedule.templateId);
      const asset = find(state.assets, schedule.assetId);
      if (template.archived || asset.status === 'Retired' || find(state.people,schedule.assigneeId)?.available === false) continue;
      let next = occurrence(schedule.start, schedule.interval, schedule.index);
      const existing = new Set(state.inspections.filter(record => record.scheduleId === schedule.id).map(record => record.due));
      while ((next <= through || schedule.index === 0) && validDate(next)) {
        if (!existing.has(next)) {
          makeInspection(state, {...schedule, due: next}, at, schedule.id);
          count++;
        }
        schedule.index++;
        next = occurrence(schedule.start, schedule.interval, schedule.index);
      }
    }
    return count;
  };
  const empty = () => ({
    version: 1, revision: 0, workspace: 'FieldProof Workspace', activeId: 'morgan',
    settings: {defaultAssignee: '', correctiveDays: 3}, sequence: {inspection: 1000, work: 2000},
    people: [{id: 'morgan', name: 'Morgan Reed', role: 'Supervisor'}],
    places: [], assets: [], templates: [], inspections: [], schedules: [], work: [], evidence: []
  });
  function perform(state, action, at = new Date().toISOString()) {
    const actor = find(state.people, action.actorId || state.activeId);
    check(actor, 'Select a local profile first.');
    const value = action.fields || {};
    const inspection = find(state.inspections, action.id);
    const work = find(state.work, action.id);
    const manages = actor.role === 'Supervisor' || actor.role === 'Admin';
    const supervisor = () => check(manages, 'A supervisor is required to verify repairs.');
    const updateDraft = (target, patch) => {
      if (typeof patch.notes === 'string') target.notes = patch.notes.slice(0, 4000);
      if (patch.photo) {
        check(target.photos.length < 12, 'Up to 12 photos can be attached here.');
        const {src, ...meta} = patch.photo;
        state.evidence.push(meta);
        target.photos.push(meta.id);
      }
      if (patch.removePhoto && target.photos.includes(patch.removePhoto)) {
        target.photos = target.photos.filter(id => id !== patch.removePhoto);
        state.evidence = state.evidence.filter(photo => photo.id !== patch.removePhoto);
      }
    };
    switch (action.type) {
      case 'tick': return materialize(state, at);
      case 'profile':
        check(find(state.people, action.id), 'Profile not found.');
        return (state.activeId = action.id);
      case 'person': {
        check(roles.includes(value.role), 'Select a role.');
        const current = find(state.people, action.id);
        if (current?.role === 'Supervisor' && value.role !== 'Supervisor') {
          check(state.people.some(person => person.id !== current.id && person.role === 'Supervisor'), 'Keep at least one supervisor profile.');
        }
        const record = {id: current?.id || uid(), name: required(value.name, 'Name'), role: value.role};
        current ? Object.assign(current, record) : state.people.push(record);
        return record.id;
      }
      case 'settings':
        check(!value.defaultAssignee || find(state.people, value.defaultAssignee), 'Select a valid assignee.');
        check(Number.isInteger(+value.correctiveDays) && +value.correctiveDays >= 0 && +value.correctiveDays <= 365, 'Enter a lead time from 0 to 365 days.');
        state.workspace = required(value.workspace, 'Workspace name');
        state.settings = {defaultAssignee: value.defaultAssignee || '', correctiveDays: +value.correctiveDays};
        if (value.responseHours) {
          check(priorities.every(priority=>Number.isInteger(value.responseHours[priority])&&value.responseHours[priority]>=1&&value.responseHours[priority]<=8760),
            'Set each response target to 1–8,760 hours.');
          state.settings.responseHours = Object.fromEntries(priorities.map(priority=>[priority,value.responseHours[priority]]));
        }
        return;
      case 'reportFault':
      case 'approveFault':
      case 'declineFault':
        return FP.ops.applyFault(state,action,at,actor);
      case 'readNotice': {
        const inbox=FP.ops.inbox(state,actor);
        check(inbox.some(notice=>notice.id===action.id),'That notification is unavailable.');
        state.noticeReads ||= {};
        state.noticeReads[actor.id]=[...new Set([...(state.noticeReads[actor.id]||[]),action.id])].slice(-4000);
        return action.id;
      }
      case 'place': {
        const current = find(state.places, action.id);
        const kind = current?.kind || value.kind;
        const parent = current ? find(state.places, current.parentId) : find(state.places, value.parentId);
        check(kinds.includes(kind), 'Select a location type.');
        check(kind === 'Site' || parent?.kind === kinds[kinds.indexOf(kind) - 1], 'Select a valid parent location.');
        const record = {id: current?.id || uid(), kind, parentId: parent?.id || '', name: required(value.name, 'Name'), notes: value.notes.trim()};
        current ? Object.assign(current, record) : state.places.push(record);
        return record.id;
      }
      case 'asset': {
        const current = find(state.assets, action.id);
        check(find(state.places, value.areaId)?.kind === 'Area', 'Select an inspection area.');
        check(assetStates.includes(value.status), 'Select an equipment status.');
        const tag = required(value.tag, 'Asset tag');
        check(!state.assets.some(item => item.id !== current?.id && item.tag.toLowerCase() === tag.toLowerCase()), 'That asset tag is already in use.');
        const record = {
          id: current?.id || uid(), name: required(value.name, 'Asset name'), tag,
          areaId: value.areaId, type: required(value.type, 'Equipment type'), status: value.status,
          manufacturer: value.manufacturer.trim(), model: value.model.trim(), serial: value.serial.trim(),
          notes: value.notes.trim(), updatedAt: at, changes: current?.changes || []
        };
        const changes = ['name','tag','type','status','manufacturer','model','serial','notes','areaId']
          .filter(key => current && current[key] !== record[key])
          .map(key => key === 'areaId' ? 'Location' : key === 'type' ? 'Equipment type' : key.charAt(0).toUpperCase() + key.slice(1));
        if (!current || changes.length) record.changes.push(event(at, actor.id, current ? 'Asset updated' : 'Asset registered', changes.join(', ')));
        current ? Object.assign(current, record) : state.assets.push(record);
        return record.id;
      }
      case 'template': {
        const current = find(state.templates, action.id);
        check(value.questions.length && value.questions.length <= 40, 'Add 1 to 40 checklist questions.');
        const questions = value.questions.map(q => {
          const mode=FP.ops?.questionFields(q)||{};
          return {id:q.id||uid(),label:required(q.label,'Question'),
            criteria:mode.kind?String(q.criteria??'').trim():required(q.criteria,'Pass criteria'),priority:q.priority,...mode};
        });
        check(questions.every(q => priorities.includes(q.priority)), 'Choose a priority for every question.');
        const record = {id: current?.id || uid(), name: required(value.name, 'Template name'), description: value.description.trim(), questions, archived: Boolean(value.archived)};
        current ? Object.assign(current, record) : state.templates.push(record);
        return record.id;
      }
      case 'inspection': return makeInspection(state, value, at).id;
      case 'reschedule':
        check(inspection && inspection.status !== 'Completed', 'This inspection has already been completed.');
        check(!inspection.scheduleId || (state.team&&value.due===inspection.due), 'Recurring occurrences keep their original due date. Change the recurring schedule for new dates.');
        check(find(state.people, value.assigneeId), 'Select an inspector.');
        Object.assign(inspection, {due: dateValue(value.due), assigneeId: value.assigneeId, updatedAt: at});
        return inspection.id;
      case 'recurrence': {
        check(intervals.includes(value.interval), 'Select a recurrence interval.');
        check(find(state.templates, value.templateId) && find(state.assets, value.assetId) && find(state.people, value.assigneeId), 'Select a template, asset, and inspector.');
        const current = find(state.schedules, action.id);
        const start = dateValue(value.start, 'Start date');
        check(current || start >= timestampDay(at), 'Choose today or a future start date.');
        const samePattern = current?.start === start && current.interval === value.interval;
        check(!current || samePattern || start >= timestampDay(at), 'Choose today or a future date for the new pattern.');
        const record = {id: current?.id || uid(), ...value, start, index: samePattern ? current.index : 0};
        current ? Object.assign(current, record) : state.schedules.push(record);
        materialize(state, at);
        return record.id;
      }
      case 'pause': {
        const schedule = find(state.schedules, action.id);
        check(schedule, 'Schedule not found.');
        if (schedule.paused) {
          while (occurrence(schedule.start, schedule.interval, schedule.index) < timestampDay(at)) schedule.index++;
        }
        schedule.paused = !schedule.paused;
        if (!schedule.paused) materialize(state, at);
        return schedule.paused;
      }
      case 'startInspection':
      case 'result': {
        check(inspection && inspection.status !== 'Completed', 'This inspection is already submitted.');
        check(actor.id === inspection.assigneeId || manages, 'The assigned inspector or a supervisor can record results.');
        inspection.status = 'Draft';
        inspection.startedAt ||= at;
        inspection.updatedAt = at;
        if (action.type === 'result') {
          const result = inspection.results[action.questionId];
          check(result, 'Inspection question not found.');
          const q=find(inspection.questions,action.questionId);
          if ('reading' in value) FP.ops.applyReading(q,result,value.reading,at,actor);
          if (value.value) {
            check(!FP.ops?.isReading(q),'Enter a measurement to determine the check result.');
            check(['Pass','Fail'].includes(value.value), 'Choose Pass or Fail.');
            if (result.value !== value.value) {
              result.at = at;
              result.recordedBy = actor.id;
            }
            result.value = value.value;
          }
          updateDraft(result, value);
        }
        return inspection.id;
      }
      case 'submit': {
        check(inspection && inspection.status !== 'Completed', 'This inspection is already submitted.');
        check(actor.id === inspection.assigneeId || manages, 'The assigned inspector or a supervisor can submit this inspection.');
        for (const question of inspection.questions) {
          const result = inspection.results[question.id];
          check(result.value, 'Choose Pass or Fail for every check.');
          check(result.value !== 'Fail' || result.notes.trim(), 'Add finding notes for each failed check.');
        }
        inspection.status = 'Completed';
        inspection.submittedAt = inspection.updatedAt = at;
        inspection.submittedBy = actor.id;
        if (state.team&&FP.ops) return FP.ops.addFindings(state,inspection,value.decisions,at,actor);
        return inspection.questions.filter(q => inspection.results[q.id].value === 'Fail').map(q =>
          addWork(state, {
            title: 'Correct: ' + q.label, description: inspection.results[q.id].notes, assetId: inspection.assetId,
            assigneeId: find(state.people,state.settings.defaultAssignee)?.available === false ? '' : state.settings.defaultAssignee, priority: q.priority,
            due: shift(timestampDay(at), state.settings.correctiveDays)
          }, at, actor, {inspectionId: inspection.id, questionId: q.id}).id);
      }
      case 'work': return addWork(state, value, at, actor).id;
      case 'assign': {
        check(work && open(work), 'Closed work orders cannot be edited.');
        check(!value.assigneeId || find(state.people, value.assigneeId), 'Select a valid assignee.');
        check(priorities.includes(value.priority), 'Choose a priority.');
        const due = dateValue(value.due);
        const notes = [];
        if (work.assigneeId !== value.assigneeId) notes.push('Assignee: ' + (find(state.people, value.assigneeId)?.name || 'Unassigned'));
        if (work.priority !== value.priority) notes.push('Priority: ' + value.priority);
        if (work.due !== due) notes.push('Due: ' + due);
        if (state.team&&FP.ops) FP.ops.tighten(state,work,value.priority);
        Object.assign(work, {due, priority: value.priority, assigneeId: value.assigneeId});
        if (notes.length) {
          history(work, at, actor, 'Assignment updated', notes.join(' · '));
          work.history.at(-1).due = due;
          if (work.respondBy) work.history.at(-1).respondBy = work.respondBy;
        }
        return work.id;
      }
      case 'startWork':
        check(work?.status === 'Open', 'Only open work orders can be started.');
        check(work.assigneeId, 'Assign this work order before starting.');
        check(actor.id === work.assigneeId || manages, 'The assignee or a supervisor can start this work.');
        history(work, at, actor, 'Work started', '', 'In Progress');
        if (work.respondBy) work.respondedAt ||= at;
        if (state.team) work.draft.contributors = [actor.id];
        return;
      case 'repairDraft':
      case 'requestReview':
        check(work?.status === 'In Progress', 'Start the work order before adding repair evidence.');
        check(actor.id === work.assigneeId || manages, 'The assignee or a supervisor can record the repair.');
        if (action.type === 'repairDraft') {
          updateDraft(work.draft, value);
          if (state.team) work.draft.contributors = [...new Set([...(work.draft.contributors || []),actor.id])];
          return;
        }
        check(work.assigneeId, 'Assign this work order before submitting a repair.');
        check(work.draft.notes.trim(), 'Describe the repair before requesting verification.');
        work.repairs.push({...work.draft, at, actorId: actor.id});
        work.draft = {notes: '', photos: []};
        history(work, at, actor, 'Repair submitted for verification', '', 'Pending Verification');
        return;
      case 'reject':
      case 'close':
        supervisor();
        check(work?.status === 'Pending Verification', 'Only repairs pending verification can be reviewed.');
        if (state.team && action.type === 'close') {
          check(!work.repairs.some(repair => repair.actorId === actor.id || repair.contributors?.includes(actor.id)), 'An independent supervisor must approve this repair.');
        }
        if (action.type === 'reject') history(work, at, actor, 'Repair returned for rework', required(value.notes, 'Rework reason'), 'In Progress');
        else {
          work.closedAt = at;
          history(work, at, actor, 'Repair verified and closed', String(value.notes ?? '').trim(), 'Closed');
        }
        return;
      default: throw new Error('This operation is unavailable.');
    }
  }
  function stats(state, siteId, days, today = workspaceDay(state), offset = 0) {
    const end = shift(today, -offset);
    const start = shift(end, 1 - days);
    const inRange = day => day >= start && day <= end;
    const eventDay = iso => iso ? zonedDay(new Date(iso),state.timeZone) : '';
    const belongs = record => !siteId || assetSite(state, record.assetId) === siteId;
    const inspections = state.inspections.filter(record => belongs(record) && inRange(record.due));
    const completed = inspections.filter(record => record.submittedAt && eventDay(record.submittedAt) <= end).length;
    const allWork = state.work.filter(belongs);
    const work = allWork.map(record => ({record, status: statusAt(record, end,state.timeZone)})).filter(item => item.status);
    const outstanding = work.filter(item => item.status !== 'Closed').map(item => item.record);
    const overdue = outstanding.filter(record => {
      const due = record.history.filter(entry => entry.due && eventDay(entry.at) <= end).at(-1)?.due || record.due;
      if (due < end) return true;
      if (!offset) return FP.ops?.responseLate(record);
      const target=record.history.filter(entry=>entry.respondBy&&eventDay(entry.at)<=end).at(-1)?.respondBy;
      return target&&eventDay(target)<=end&&statusAt(record,end,state.timeZone)==='Open';
    });
    const closed = work.filter(item => item.status === 'Closed' && inRange(eventDay(item.record.closedAt)));
    const distribution = statuses.map(status => status === 'Closed' ? closed.length : work.filter(item => item.status === status).length);
    const groups = Array.from({length: 6}, (_, index) => {
      const from = shift(start, Math.floor(index * days / 6));
      const to = shift(start, Math.floor((index + 1) * days / 6) - 1);
      const within = iso => iso && eventDay(iso) >= from && eventDay(iso) <= to;
      return {start: from, end: to, opened: allWork.filter(record => within(record.createdAt)).length, closed: allWork.filter(record => within(record.closedAt)).length};
    });
    return {start, end, inspections, completed, rate: inspections.length ? Math.round(completed / inspections.length * 100) : null,
      outstanding, overdue, resolved: closed.length, distribution, groups};
  }
  Object.assign(globalThis, {FP: {DAY, statuses, priorities, assetStates, roles, kinds, intervals, find, check, uid, localDay, asDate, shift,
    timestampDay, zonedDay, workspaceDay, validDate, chain, location, assetSite, event, open, isOverdue, empty, perform, stats, occurrence, makeInspection, addWork, statusAt}});
})();

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

(() => {
  const {empty, check, find, validDate, priorities, statuses, intervals, kinds, roles, assetStates, perform, uid} = FP;
  const DB_NAME = 'fieldproof-v1';
  const stateStore = 'workspace';
  const photoStore = 'photographs';
  const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel(DB_NAME) : null;
  const MAX_BACKUP = 300 * 1024 * 1024;
  let connection;
  function connect() {
    return connection ||= new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) return reject(new Error('This browser profile does not provide local database storage.'));
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(stateStore);
        request.result.createObjectStore(photoStore);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Close other FieldProof tabs and try again.'));
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }
  async function transaction(mode, prepare) {
    const database = await connect();
    return new Promise((resolve, reject) => {
      const tx = database.transaction([stateStore, photoStore],mode);
      const state = tx.objectStore(stateStore);
      const photos = tx.objectStore(photoStore);
      let result, failure;
      const accept = value => { result = value; };
      const read = (request, callback) => {
        request.onsuccess = () => {
          try { callback(request.result); }
          catch (error) { failure = error; tx.abort(); }
        };
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || tx.error || new Error('The local save was interrupted. Try again.'));
      try { prepare(state,photos,read,accept); }
      catch (error) { failure = error; tx.abort(); }
    });
  }
  function get() {
    return transaction('readonly',(store,photos,read,accept) => read(store.get('main'),accept));
  }
  function photo(id) {
    return transaction('readonly',(store,photos,read,accept) => read(photos.get(id),accept));
  }
  async function mutate(action) {
    const saved = await transaction('readwrite',(store,photos,read,accept) => {
      read(store.get('main'),state => {
        check(state, 'The workspace has not loaded.');
        if (action.workspaceKey) check(state.workspaceKey === action.workspaceKey, 'The workspace changed. Reload the record before saving.');
        const result = perform(state,action);
        const payload = action.fields;
        if (payload?.photo) photos.put(payload.photo,payload.photo.id);
        if (payload?.removePhoto) photos.delete(payload.removePhoto);
        if (action.type !== 'tick' || result) {
          state.revision++;
          store.put(state,'main');
        }
        accept({state,result});
      });
    });
    if (action.type !== 'tick' || saved.result) channel?.postMessage(saved.state.revision);
    return saved;
  }
  async function restore(state, images, revision = null) {
    validate(state,images);
    const result = await transaction('readwrite',(store,photos,read,accept) => {
      read(store.get('main'),current => {
        if (current && revision === null) { accept(current); return; }
        if (current && current.revision !== revision) throw new Error('The workspace changed. Review the backup and try again.');
        state.revision = (current?.revision || 0) + 1;
        state.workspaceKey = uid();
        photos.clear();
        for (const image of images) photos.put(image,image.id);
        store.put(state,'main');
        accept(state);
      });
    });
    channel?.postMessage(result.revision);
    return result;
  }
  async function backup() {
    return transaction('readonly',(store,photos,read,accept) => {
      read(store.get('main'),state => {
        read(photos.getAll(),images => accept({format:'FieldProof backup',version:1,exportedAt:new Date().toISOString(),state,images}));
      });
    });
  }
  async function readBackup(file) {
    check(file && file.size <= MAX_BACKUP,'Choose a FieldProof backup under 300 MB.');
    let contents;
    try { contents = JSON.parse(await file.text()); }
    catch { throw new Error('This file is not readable FieldProof backup JSON.'); }
    check(contents?.format === 'FieldProof backup' && contents.version === 1,'Choose a FieldProof v1 backup.');
    validate(contents.state,contents.images);
    return contents;
  }
  function validate(state, images) {
    const fail = 'Invalid backup. Check the file and try again.';
    const ok = condition => check(condition,fail);
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    const str = (value, max = 20000) => typeof value === 'string' && value.length <= max;
    const nonempty = value => str(value) && value.trim().length > 0;
    const time = value => str(value,40) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
    const when = value => value === '' || time(value);
    const unique = list => {
      ok(Array.isArray(list) && list.length <= 100000);
      ok(list.every(item => object(item) && str(item.id,159) && /^[a-zA-Z0-9-]+$/.test(item.id)));
      const index = new Map(list.map(item => [item.id,item]));
      ok(index.size === list.length);
      return index;
    };
    ok(object(state) && state.version === 1 && nonempty(state.workspace));
    const people = unique(state.people), places = unique(state.places), assets = unique(state.assets), templates = unique(state.templates);
    const inspections = unique(state.inspections), schedules = unique(state.schedules), work = unique(state.work), metadata = unique(state.evidence), photos = unique(images);
    const faults = unique(state.faults??[]);
    const usedPhotos = new Set();
    const forPerson = id => id === '' || people.has(id);
    const eventList = entries => Array.isArray(entries) && entries.every(entry => object(entry) && people.has(entry.actorId) &&
      time(entry.at) && nonempty(entry.title) && str(entry.note) && ['', ...statuses].includes(entry.status));
    const draft = data => {
      ok(object(data) && str(data.notes,4000) && Array.isArray(data.photos) && data.photos.length <= 12);
      for (const id of data.photos) {
        ok(metadata.has(id) && !usedPhotos.has(id));
        usedPhotos.add(id);
      }
    };
    const questions = list => {
      unique(list);
      ok(list.length > 0 && list.length <= 40 && list.every(q => nonempty(q.label) && str(q.criteria) && priorities.includes(q.priority)));
      for (const question of list) {
        if (question.kind==='measurement') FP.ops.questionFields(question);
        else ok(nonempty(question.criteria));
      }
    };
    ok(people.has(state.activeId) && state.people.some(p => ['Supervisor','Admin'].includes(p.role)));
    ok(state.people.every(p => nonempty(p.name) && roles.includes(p.role)));
    ok(object(state.settings) && forPerson(state.settings.defaultAssignee) && Number.isInteger(state.settings.correctiveDays) &&
      state.settings.correctiveDays >= 0 && state.settings.correctiveDays <= 365);
    if (state.settings.responseHours!==undefined) ok(object(state.settings.responseHours)&&priorities.every(priority=>{
      const value=state.settings.responseHours[priority];
      return Number.isInteger(value)&&value>=1&&value<=8760;
    }));
    ok(object(state.sequence) && ['inspection','work'].every(key => Number.isSafeInteger(state.sequence[key]) && state.sequence[key] >= 0));
    const sequences = (records,prefix,max) => records.every(item => new RegExp('^'+prefix+'\\d+$').test(item.id) && +item.id.slice(3) <= max);
    ok(sequences(state.work,'WO-',state.sequence.work) && sequences(state.inspections,'IN-',state.sequence.inspection));
    for (const place of places.values()) {
      const index = kinds.indexOf(place.kind);
      ok(index !== -1 && nonempty(place.name) && str(place.notes) &&
        (index === 0 ? place.parentId === '' : places.get(place.parentId)?.kind === kinds[index - 1]));
    }
    ok(new Set(state.assets.map(item => String(item.tag).toLowerCase())).size === assets.size);
    for (const asset of assets.values()) {
      ok(nonempty(asset.name) && nonempty(asset.tag) && nonempty(asset.type) && places.get(asset.areaId)?.kind === 'Area' &&
        assetStates.includes(asset.status) && time(asset.updatedAt) && eventList(asset.changes) &&
        ['manufacturer','model','serial','notes'].every(key => str(asset[key])));
    }
    for (const template of templates.values()) {
      ok(nonempty(template.name) && str(template.description) && typeof template.archived === 'boolean');
      questions(template.questions);
    }
    for (const schedule of schedules.values()) {
      ok(assets.has(schedule.assetId) && templates.has(schedule.templateId) && people.has(schedule.assigneeId) &&
        intervals.includes(schedule.interval) && validDate(schedule.start) && typeof schedule.paused === 'boolean' &&
        Number.isInteger(schedule.index) && schedule.index >= 0 && schedule.index < 100000);
    }
    for (const record of inspections.values()) {
      ok(nonempty(record.title) && assets.has(record.assetId) && templates.has(record.templateId) &&
        people.has(record.assigneeId) && validDate(record.due) && ['',...schedules.keys()].includes(record.scheduleId) &&
        ['Scheduled','Draft','Completed'].includes(record.status) && time(record.createdAt) && time(record.updatedAt) &&
        when(record.startedAt) && when(record.submittedAt) && forPerson(record.submittedBy) && object(record.results));
      questions(record.questions);
      ok(Object.keys(record.results).length === record.questions.length);
      ok(record.status === 'Completed' ? time(record.submittedAt) && people.has(record.submittedBy) : !record.submittedAt && !record.submittedBy);
      for (const question of record.questions) {
        const result = record.results[question.id];
        draft(result);
        ok(['','Pass','Fail'].includes(result.value) && when(result.at) && Boolean(result.at) === Boolean(result.value) &&
          (result.recordedBy === undefined || forPerson(result.recordedBy)));
        if (question.kind==='measurement') {
          const reading=result.reading;
          ok(reading==null ? !result.value : FP.ops.validNumber(reading)&&(FP.ops.within(question,reading)?'Pass':'Fail')===result.value);
        }
        if (record.status === 'Completed') ok(result.value && (result.value !== 'Fail' || result.notes.trim()));
      }
    }
    const sourcePairs = new Set();
    const sourceFaults = new Set();
    for (const fault of faults.values()) {
      ok(nonempty(fault.title)&&nonempty(fault.notes)&&assets.has(fault.assetId)&&people.has(fault.reporterId)&&
        priorities.includes(fault.priority)&&time(fault.createdAt)&&['Reported','Assigned','Declined'].includes(fault.status)&&
        when(fault.reviewedAt)&&forPerson(fault.reviewedBy)&&str(fault.reviewNote)&&str(fault.workId));
      ok(fault.status==='Reported'?!fault.reviewedAt&&!fault.reviewedBy:time(fault.reviewedAt)&&people.has(fault.reviewedBy));
      ok(fault.status==='Assigned'?work.get(fault.workId)?.assetId===fault.assetId:!fault.workId);
      draft(fault);
    }
    for (const order of work.values()) {
      ok(nonempty(order.title) && str(order.description) && assets.has(order.assetId) && forPerson(order.assigneeId) &&
        priorities.includes(order.priority) && statuses.includes(order.status) && validDate(order.due) &&
        time(order.createdAt) && when(order.closedAt) && eventList(order.history) && order.history[0]?.status === 'Open' &&
        order.history.filter(entry => entry.status).at(-1)?.status === order.status &&
        Boolean(order.closedAt) === (order.status === 'Closed') && Array.isArray(order.repairs));
      if (order.respondBy!==undefined) ok(time(order.respondBy));
      if (order.respondedAt!==undefined) ok(time(order.respondedAt));
      if (order.sources!==undefined) ok(Array.isArray(order.sources)&&order.sources.length>0);
      const sources=order.sources || (order.inspectionId?[{kind:'inspection',inspectionId:order.inspectionId,questionId:order.questionId,at:order.createdAt,actorId:order.history[0].actorId}]:[]);
      if (order.inspectionId) ok(sources.some(s=>s.kind==='inspection'&&s.inspectionId===order.inspectionId&&s.questionId===order.questionId));
      else ok(order.inspectionId === '' && order.questionId === '');
      for (const source of sources) {
        ok(object(source)&&time(source.at)&&people.has(source.actorId));
        if (source.kind==='inspection') {
          const record=inspections.get(source.inspectionId);
          const pair=source.inspectionId+'/'+source.questionId;
          ok(record?.status==='Completed'&&record.assetId===order.assetId&&record.results[source.questionId]?.value==='Fail'&&!sourcePairs.has(pair));
          sourcePairs.add(pair);
        } else {
          const fault=faults.get(source.reportId);
          ok(source.kind==='report'&&fault?.status==='Assigned'&&fault.workId===order.id&&fault.assetId===order.assetId&&!sourceFaults.has(fault.id));
          sourceFaults.add(fault.id);
        }
      }
      draft(order.draft);
      for (const repair of order.repairs) {
        draft(repair);
        ok(nonempty(repair.notes) && time(repair.at) && people.has(repair.actorId));
        if (repair.contributors !== undefined) ok(Array.isArray(repair.contributors) && repair.contributors.every(id=>people.has(id)));
      }
      if (['Pending Verification','Closed'].includes(order.status)) ok(order.repairs.length > 0);
    }
    for (const fault of faults.values()) if (fault.status==='Assigned') ok(sourceFaults.has(fault.id));
    for (const record of inspections.values()) {
      if (record.status === 'Completed') for (const question of record.questions) {
        if (record.results[question.id].value === 'Fail') ok(sourcePairs.has(record.id+'/'+question.id));
      }
    }
    ok(metadata.size === photos.size && metadata.size === usedPhotos.size);
    for (const image of photos.values()) {
      const meta = metadata.get(image.id);
      ok(meta && time(meta.at) && nonempty(meta.name) && meta.name === image.name && meta.at === image.at &&
        Number.isInteger(meta.w) && Number.isInteger(meta.h) && meta.w > 0 && meta.h > 0 &&
        meta.w <= 1600 && meta.h <= 1600 && meta.w === image.w && meta.h === image.h &&
        str(image.src,4000000) && /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(image.src));
    }
  }
  async function encodePhoto(file) {
    check(file && /^image\/(jpeg|png|webp|gif|avif|heic|heif|bmp)$/i.test(file.type), 'Choose a supported image, such as JPEG, PNG, or WebP.');
    check(file.size <= 28 * 1024 * 1024, 'Choose an image under 28 MB.');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      try { await image.decode(); }
      catch { throw new Error('This browser could not open the image. Try a JPEG or PNG.'); }
      const ratio = Math.min(1,1600 / Math.max(image.naturalWidth,image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1,Math.round(image.naturalWidth * ratio));
      canvas.height = Math.max(1,Math.round(image.naturalHeight * ratio));
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0,0,canvas.width,canvas.height);
      context.drawImage(image,0,0,canvas.width,canvas.height);
      const src = canvas.toDataURL('image/jpeg',.83);
      check(src.startsWith('data:image/jpeg;base64,'), 'Could not prepare this photo for offline storage.');
      return {id:uid(),name:file.name.slice(0,250) || 'Photograph',at:new Date().toISOString(),src,w:canvas.width,h:canvas.height};
    } finally { URL.revokeObjectURL(url); }
  }
  FP.storage = {get,photo,mutate,restore,backup,readBackup,encodePhoto,validate,channel,empty};
})();

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

(() => {
  const local=FP.storage;
  const {basis,preview,offlineActions,error}=FP.team;
  const DEVICE='fieldproof-team-device';
  const cacheStore='accounts';
  const imagesStore='images';
  let connection, account, info={online:true,pending:0,issue:null,expired:false,trusted:false}, running, lastETag='', lastRefresh=0, lastLeaseCheck=0;
  let lastOperation=new Map();
  const device=()=>localStorage.getItem(DEVICE)||'';
  const markDevice=id=>id?localStorage.setItem(DEVICE,id):localStorage.removeItem(DEVICE);
  function connect() {
    return connection ||= new Promise((resolve,reject)=>{
      const request=indexedDB.open('fieldproof-team-v2',1);
      request.onupgradeneeded=()=>{
        request.result.createObjectStore(cacheStore);
        request.result.createObjectStore(imagesStore);
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(new Error('Close the other FieldProof tab and try again.'));
    });
  }
  async function store(mode,callback) {
    const db=await connect();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction([cacheStore,imagesStore],mode);
      const accounts=tx.objectStore(cacheStore), images=tx.objectStore(imagesStore);
      let result,failure;
      const read=(request,done)=>{
        request.onsuccess=()=>{
          try {done(request.result);}
          catch (err) { failure=err; tx.abort(); }
        };
      };
      tx.oncomplete=()=>resolve(result);
      tx.onabort=()=>reject(failure||tx.error||new Error('The device could not save your offline changes.'));
      callback(accounts,images,read,value=>{result=value;});
    });
  }
  const getCache=(id=account?.id)=>id ? store('readonly',(accounts,images,read,done)=>read(accounts.get(id),done)) : null;
  function changeCache(id,change) {
    return store('readwrite',(accounts,images,read,done)=>read(accounts.get(id),existing=>{
      const next=change(existing);
      accounts.put(next,id);
      done(next);
    }));
  }
  function saveResponse(payload,{trusted,complete}={}) {
    const id=payload.account.id;
    return changeCache(id,old=>{
      const cached=old||{outbox:[],base:null,issue:null,trusted:false};
      if (complete) {
        cached.outbox=cached.outbox.filter(op=>op.opId!==complete);
        if (cached.issue?.opId===complete) cached.issue=null;
      }
      if (!cached.base||payload.state.revision>=cached.base.state.revision) {
        const {account,state,leaseUntil}=payload;
        cached.base={account,state,leaseUntil};
      }
      if (trusted!==undefined) cached.trusted=trusted;
      return cached;
    });
  }
  const leaseValid=cache=>cache?.trusted && cache.base.leaseUntil>Date.now();
  function updateInfo(cache,changes={}) {
    info={...info,...changes,pending:cache?.outbox.length||0,issue:cache?.issue||null,trusted:!!cache?.trusted};
  }
  function overlay(cache) {
    const state=structuredClone(cache.base.state);
    for (const command of cache.outbox) {
      if (command.generation!==state.workspaceKey||!offlineActions.has(command.action.type)) continue;
      if (basis(state,command.action)!==command.basis) continue;
      try { preview(state,{...command.action,localAt:command.localAt},cache.base.account.id); }
      catch { /* Rejected or outdated edits remain available in the outbox. */ }
    }
    return state;
  }
  async function request(path,{data,expected=account?.id,etag,timeout=6500}={}) {
    let response;
    try {
      response=await fetch('/api/'+path,{
        method:data===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',
        headers:{
          ...(data===undefined?{}:{'Content-Type':'application/json'}),
          ...(expected?{'X-FieldProof-Account':expected}:{}),
          ...(etag?{'If-None-Match':etag}:{})
        },
        ...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(timeout)
      });
    } catch { throw error(0,'FieldProof cannot reach the server.'); }
    if (response.status===304) return null;
    if (response.status>=500) throw error(0,'The FieldProof server is temporarily unavailable.');
    let result;
    try { result=await response.json(); }
    catch { throw error(0,'The FieldProof server did not return a response.'); }
    if (!response.ok) throw error(response.status,result.error||'Could not complete this operation.');
    if (path==='workspace') lastETag=response.headers.get('etag')||'';
    return result;
  }
  async function bootstrap() {
    try {
      const payload=await request('workspace',{expected:''});
      account=payload.account;
      const cache=await saveResponse(payload);
      markDevice(account.id);
      updateInfo(cache,{online:true,expired:false});
      return {state:overlay(cache)};
    } catch (failure) {
      if (failure.status===0) {
        const cache=await getCache(device());
        if (leaseValid(cache)) {
          account=cache.base.account;
          updateInfo(cache,{online:false,expired:false});
          return {state:overlay(cache)};
        }
        return {offline:true};
      }
      if (failure.status!==401) throw failure;
      markDevice('');
      return request('start',{expected:''});
    }
  }
  async function authenticate(mode,fields) {
    await request(mode,{data:fields,expected:''});
    const payload=await request('workspace',{expected:''});
    account=payload.account;
    const cache=await saveResponse(payload,{trusted:fields.trusted===true});
    markDevice(account.id);
    updateInfo(cache,{online:true,expired:false});
    return overlay(cache);
  }
  async function pull(force=false) {
    if (!force&&Date.now()-lastRefresh<3500) return getCache();
    const cached=await getCache();
    const renew=cached?.trusted&&cached.base.leaseUntil<Date.now()+86400_000&&Date.now()-lastLeaseCheck>3600000;
    if (renew) lastLeaseCheck=Date.now();
    const payload=await request('workspace',{etag:force||renew?'':lastETag});
    lastRefresh=Date.now();
    if (!payload) return getCache();
    const cache=await saveResponse(payload);
    account=cache.base.account;
    return cache;
  }
  async function runSync({force=false,retry=false}={}) {
    let cache=await getCache();
    if (!cache) throw error(401,'Sign in to FieldProof.');
    try {
      if (navigator.onLine===false) throw error(0,'You’re offline.');
      if (cache.issue&&!retry) {
        cache=await pull(force);
        updateInfo(cache,{online:true,expired:false});
        return overlay(cache);
      }
      while (cache.outbox.length) {
        const command=cache.outbox[0];
        try {
          const payload=await request('actions',{data:command});
          lastOperation.set(command.opId,{result:payload.result});
          if (lastOperation.size>60) lastOperation.delete(lastOperation.keys().next().value);
          cache=await saveResponse(payload,{complete:command.opId});
          account=cache.base.account;
        } catch (failure) {
          if (![400,403,409,413,415].includes(failure.status)) throw failure;
          cache=await changeCache(account.id,current=>{
            if (current.outbox.some(op=>op.opId===command.opId)) {
              current.issue={opId:command.opId,id:command.action.id,type:command.action.type,message:failure.message,status:failure.status};
            }
            return current;
          });
          if (cache.issue) break;
        }
      }
      if (cache.issue||force) cache=await pull(true);
      else if (!cache.outbox.length) cache=await pull();
      updateInfo(cache,{online:true,expired:false});
    } catch (failure) {
      if (failure.status===401) {
        markDevice('');
        updateInfo(cache,{online:true,expired:true});
      }
      else if (failure.status===0) updateInfo(cache,{online:false,expired:!leaseValid(cache)});
      else throw failure;
    }
    return overlay(cache);
  }
  async function sync(options={}) {
    if (!account) return null;
    if (running) {
      await running;
      if (!options.force&&!options.retry) {
        const cache=await getCache();
        return cache?overlay(cache):null;
      }
    }
    running=runSync(options);
    try { return await running; }
    finally {running=null;}
  }
  async function mutate(input) {
    if (!account) throw error(401,'Sign in to FieldProof.');
    const {type,id,questionId,fields={}}=input;
    const action={type,id,questionId,fields};
    const worksOffline=offlineActions.has(type);
    if (!worksOffline || info.expired) {
      await sync({force:true});
      if (info.expired) throw error(401,'Sign in as the account that owns these changes.');
      if (!info.online && !worksOffline) throw error(0,'Connect to the server to make this change.');
    }
    const opId=FP.uid();
    const command={opId,generation:input.workspaceKey,basis:input.basis,localAt:new Date().toISOString(),action};
    let cache=await changeCache(account.id,current=>{
      if (current.issue) throw error(409,'Resolve the queued sync issue before making more changes.');
      if (!info.online&&!leaseValid(current)) throw error(0,'Go online to sign in and prepare this device for offline work.');
      const state=overlay(current);
      const changed=state.workspaceKey!==command.generation||basis(state,action)!==command.basis;
      if (changed&&!worksOffline) throw error(409,'The record changed. Reopen it and try again.');
      FP.team.authorize(state,action,FP.find(state.people,account.id));
      if (worksOffline&&!changed) {
        FP.check(!state.pendingSubmissions?.includes(id),'This record is already queued for submission.');
        preview(state,{...action,localAt:command.localAt},account.id);
      }
      current.outbox.push(command);
      return current;
    });
    updateInfo(cache);
    if (input.background && worksOffline) {
      sync().catch(()=>{});
      return {state:overlay(cache),queued:true};
    }
    let state=await sync();
    cache=await getCache();
    if (cache.outbox.some(op=>op.opId===opId)&&info.online&&!info.issue&&!info.expired) {
      state=await sync({force:true});
      cache=await getCache();
    }
    if (cache.issue?.opId===opId&&!worksOffline) {
      const {status,message}=cache.issue;
      cache=await changeCache(account.id,current=>{
        current.outbox=current.outbox.filter(op=>op.opId!==opId);
        current.issue=null;
        return current;
      });
      updateInfo(cache);
      throw error(status,message);
    }
    const queued=cache.outbox.some(op=>op.opId===opId);
    return {state,result:lastOperation.get(opId)?.result,queued};
  }
  async function photo(id) {
    const cache=await getCache();
    if (!cache||!overlay(cache).evidence.some(meta=>meta.id===id)) return null;
    for (const command of cache.outbox) {
      if (command.action.fields?.photo?.id===id) return command.action.fields.photo;
    }
    const key=account.id+'/'+id;
    const existing=await store('readonly',(accounts,images,read,done)=>read(images.get(key),done));
    if (existing?.generation===cache.base.state.workspaceKey) return existing.photo;
    try {
      const result=await request('photos/'+id);
      if (cache.trusted) await store('readwrite',(accounts,images)=>images.put({generation:cache.base.state.workspaceKey,photo:result},key));
      return result;
    } catch (failure) {
      if ([0,401,404].includes(failure.status)) return null;
      throw failure;
    }
  }
  async function prepare() {
    await sync({force:true});
    if (!info.online||info.expired) throw error(0,'Connect and sign in to prepare this device.');
    const cache=await changeCache(account.id,current=>({...current,trusted:true}));
    updateInfo(cache);
    const state=overlay(cache);
    const ids=new Set();
    for (const record of state.inspections.filter(record=>record.assigneeId===account.id&&record.status!=='Completed')) {
      Object.values(record.results).forEach(answer=>answer.photos.forEach(id=>ids.add(id)));
    }
    for (const order of state.work.filter(order=>order.assigneeId===account.id&&FP.open(order))) {
      [order.draft,...order.repairs].forEach(draft=>draft.photos.forEach(id=>ids.add(id)));
      FP.find(state.inspections,order.inspectionId)?.results[order.questionId]?.photos.forEach(id=>ids.add(id));
    }
    const list=[...ids].slice(0,80);
    const copied=await Promise.all(list.map(id=>photo(id).catch(()=>null)));
    const sw=await navigator.serviceWorker?.getRegistration?.();
    const ready=!!sw?.active&&(!FP.pdfUnicode||!!await caches.match('/fonts/NotoSansSC-Regular.ttf'));
    return {total:ids.size,photos:copied.filter(Boolean).length,ready};
  }
  async function discard() {
    const cache=await changeCache(account.id,current=>{
      if (current.issue) current.outbox=current.outbox.filter(op=>op.opId!==current.issue.opId);
      current.issue=null;
      return current;
    });
    updateInfo(cache);
    return sync({force:true});
  }
  async function backup() { return request('backup',{timeout:120000}); }
  async function restore(backup,revision) {
    await sync({force:true});
    if (info.pending) throw error(409,'Resolve unsynced changes before restoring.');
    const payload=await request('restore',{data:{backup,revision},timeout:120000});
    const cache=await saveResponse(payload);
    updateInfo(cache);
    return overlay(cache);
  }
  async function logout() {
    await sync({force:true});
    if (info.pending) throw error(409,'Sync or resolve the pending changes before signing out.');
    await request('logout',{data:{}});
    const id=account.id;
    account=null;
    markDevice('');
    await store('readwrite',(accounts,images)=>{
      accounts.delete(id);
      images.delete(IDBKeyRange.bound(id+'/',id+'/\uffff'));
    });
  }
  function reauth() {
    account=null;
    markDevice('');
    lastETag='';
  }
  const label=()=>info.expired?'Sign-in required':info.issue?'Review sync issue':info.pending?
    (info.online?'':'Offline · ')+info.pending+' queued':info.online?'Up to date':'Offline';
  FP.teamStorage={boot:bootstrap,authenticate,request,mutate,sync,photo,prepare,discard,backup,restore,logout,reauth,label,
    info:()=>info,account:()=>account,exportPending:async()=>({format:'FieldProof unsynced changes',version:1,
      exportedAt:new Date().toISOString(),account:account?.email,commands:(await getCache())?.outbox||[]}),
    readBackup:local.readBackup,encodePhoto:local.encodePhoto};
})();

(() => {
  const pairs=`
Account|账户
Account status|账户状态
A supervisor can review this repair.|主管可以验收此维修。
A supervisor is required to verify repairs.|仅主管可验收维修。
Activate account|激活账户
Activate an account|激活账户
Activate your account|激活您的账户
Activation code|激活码
Activation code copied.|已复制激活码。
Activation code is invalid or expired.|激活码无效或已过期。
Activation expired|激活码已过期
Active|启用
Active profile|当前账户
Activity and verification history|操作与验收记录
Activity history|活动记录
Add|添加
Add 1 to 40 checks.|请添加 1 至 40 项检查。
Add 1 to 40 checklist questions.|请添加 1 至 40 项检查。
Add a site, a building, and an inspection area first.|请先添加站点、楼栋和巡检区域。
Add active equipment in Sites & Assets before reporting a fault.|请先在“站点与设备”中添加在用设备，再上报故障。
Add an active equipment record in|请先在
before scheduling an inspection.|中添加可用记录，然后安排巡检。
Create an active|请创建并启用
inspection template|巡检模板
Add asset|添加设备
Add check|添加检查项
Add equipment|添加设备
Add finding notes for each failed check.|请为每个不合格项补充现场说明。
Add finding notes for the failed check.|请为此不合格项补充现场说明。
Add location|添加位置
Add observations (required for a fail)|填写现场情况（不合格时必填）
Add photos|添加照片
Address or location notes|地址或位置说明
Admin|管理员
All sites|所有站点
All statuses|所有状态
All work orders|全部工单
An administrator is required.|仅管理员可执行此操作。
An administrator is required to change workspace settings.|只有管理员可以修改工作区设置。
An attached photograph is unavailable. Restore the workspace from a backup and try again.|某张附件照片不可用。请检查备份并重试。
An independent supervisor must approve this repair.|此维修必须由未参与维修的主管验收。
An independent supervisor must verify this repair.|此维修必须由未参与维修的主管验收。
Archived|已归档
Archive template|归档模板
Area|区域
Asset|设备
Asset / location|设备／位置
Asset name|设备名称
Asset registered|已登记设备
Asset tag|设备编号
Asset updated|已更新设备
Assign corrective action|分派整改工单
Assign corrective actions, record repairs, and verify completed work.|分派整改工单、记录维修过程、验收已完成的工作。
Assign this work order before starting.|请先分派此工单再开始维修。
Assign this work order before submitting a repair.|请先分派此工单再提交维修。
Assigned|已分派
Assigned to|负责人
Assigned to me|分派给我
Assignee|负责人
Assignment updated|已更新分派
Assignments, review requests, and overdue tasks will appear here.|工单分派、审核请求和逾期提醒将在这里显示。
Attached|附件上传于
Audit history|审计记录
Back to fault reports|返回故障上报
Back to list|返回列表
Back to sign in|返回登录
Back to team|返回团队
Backup downloaded.|已下载备份。
Backup file|备份文件
Backup restored with its photos and history.|已恢复备份、照片和历史记录。
Backups include photographs and notes. Store them somewhere private.|备份包含照片和现场说明。请妥善保管。
Blocked|已阻止
Browser storage is full. Export a backup and free space before saving again.|浏览器存储空间已满。请先导出备份并释放空间。
Building|楼栋
Cancel|取消
Change password|修改密码
Change saved on this device. Check Synchronization for its status.|更改已保存在本机。可在“同步”中查看状态。
Changes apply to future occurrences when they are generated.|更改将应用于之后生成的巡检。
Changes are waiting for review.|有更改需要处理。
Changes save to this device|更改将保存在本机
Changes saved.|已保存更改。
Check|检查项
Check type|检查类型
Checklist and findings|检查清单与发现
Checks|检查项
Choose a FieldProof backup.|请选择 FieldProof 备份。
Choose a FieldProof backup. Review its contents before replacing this workspace.|请选择 FieldProof 备份。替换前请核对内容。
Choose a FieldProof backup under 300 MB.|请选择小于 300 MB 的 FieldProof 备份。
Choose a FieldProof v1 backup.|请选择兼容的 FieldProof 备份。
Choose a corrective due time from 0 to 365 days.|请设置 0 至 365 天的整改期限。
Choose a priority.|请选择优先级。
Choose a priority for every question.|请为每个检查项选择优先级。
Choose a repair assignee.|请选择维修负责人。
Choose a role.|请选择角色。
Choose a supported image, such as JPEG, PNG, or WebP.|请选择受支持的图像，例如 JPEG、PNG 或 WebP。
Choose a valid due date.|请选择有效的截止日期。
Choose a valid start date.|请选择有效的开始日期。
Choose an account status.|请选择账户状态。
Choose an active team member.|请选择可用的团队成员。
Choose an image under 28 MB.|请选择小于 28 MB 的图片。
Choose an inspector or manager.|请选择巡检员或主管。
Choose Pass or Fail.|请选择合格或不合格。
Choose Pass or Fail for every check.|请为每个检查项选择合格或不合格。
Choose today or a future date for the new pattern.|请将新计划的开始日期设为今天或之后。
Choose today or a future start date.|请选择今天或之后的开始日期。
Close|关闭
Close dialog|关闭对话框
Close navigation|关闭导航
Close other FieldProof tabs and try again.|请关闭其他 FieldProof 标签页后重试。
Close the other FieldProof tab and try again.|请关闭其他 FieldProof 标签页后重试。
Closed|已关闭
Closed work orders cannot be edited.|已关闭的工单不能修改。
Completed|已完成
Confirm backup restore|确认恢复备份
Conflicting change removed. The server version is current.|已移除冲突更改。当前显示服务器版本。
Connect and sign in to prepare this device.|请联网并登录后准备离线使用。
Connect to the server to make this change.|进行此更改前请连接服务器。
Connect to the server to sign in.|请连接服务器后登录。
Connecting to the workspace…|正在连接工作区…
Copy code|复制激活码
Corrective action|整改工单
Corrective actions|整改工单
Corrective action report|整改报告
Could not complete this operation.|无法完成此操作。
Could not prepare this photo for offline storage.|无法将此照片保存以供离线使用。
Create a new work order|创建新工单
Create activation code|生成激活码
Create the first administrator account.|创建第一个管理员账户。
Create work order|创建工单
Create workspace|创建工作区
Created|创建时间
Created from an on-site report|由现场故障上报生成
Created from failed inspection check|由不合格检查项生成
Current backlog and period closures|当前未完成工单与本期已关闭工单
Current language|当前语言
Current password|当前密码
Current password is incorrect.|当前密码不正确。
Dashboard|概览
Data & offline|数据与离线
Date range|日期范围
Days until corrective action is due|整改期限（天）
Decline|驳回
Decline fault report|驳回故障报告
Decline report|驳回报告
Declined|已驳回
Default repair assignee|默认维修负责人
Defaults for new corrective actions.|新整改工单的默认设置。
Describe the repair and the operating check.|说明维修内容及运行测试结果。
Describe the repair before requesting verification.|请先填写维修说明，再申请验收。
Description|描述
Device capture|设备采集时间
Discard conflicting edit|舍弃冲突更改
Download a PDF with findings, timestamps, and evidence.|下载包含检查发现、时间和证据的 PDF。
Download PDF|下载 PDF
Draft|草稿
Draft saved|已保存草稿
Draft saved on this device|草稿已保存在本机
Due|截止日期
Due date|截止日期
Due today|今天到期
Edit|编辑
Edit asset|编辑设备
Edit assignment|编辑分派
Edit equipment|编辑设备
Edit inspection schedule|编辑巡检计划
Edit inspector|编辑巡检员
Edit location|编辑位置
Edit recurring schedule|编辑周期计划
Edit schedule|编辑计划
Edit template|编辑模板
Email|电子邮箱
Email address|电子邮箱
Email or password is incorrect, or the account is inactive.|邮箱或密码有误，或账户未启用。
Enable offline work only on a device you control.|仅在您控制的设备上启用离线工作。
Enable this account before issuing a code.|请先启用此账户再生成激活码。
Enabled|启用
English|英语
Enter a fault title and describe what you observed.|请填写故障标题及现场情况。
Enter a finite numerical measurement.|请输入有效的数值。
Enter a full name.|请输入姓名。
Enter a lead time from 0 to 365 days.|请输入 0 至 365 天的整改期限。
Enter a measurement to determine the check result.|请输入测量值以判定检查结果。
Enter a reason for declining the report.|请填写驳回原因。
Enter a unit for every measurement.|请为每项测量填写单位。
Enter a valid email address.|请输入有效的邮箱地址。
Enter at least one limit. Leave the other blank for a one-sided range.|请输入至少一个限值。单侧范围可留空另一侧。
Enter at least one valid measurement limit.|请输入至少一个有效的测量限值。
Enter the required measurement.|请输入所需的测量值。
Equipment|设备
Equipment / location|设备／位置
Equipment changes|设备变更
Equipment name|设备名称
Equipment record|设备档案
Equipment register|设备台账
Equipment type|设备类型
Evidence is missing from server storage.|服务器缺少此证据文件。
Evidence photo (optional)|现场照片（选填）
Every two weeks|每两周
Export a backup before replacing work records or transferring this workspace.|更换工作记录或迁移工作区前，请先导出备份。
Export backup|导出备份
Export unsynced changes|导出未同步更改
Fail|不合格
Fault|故障
Fault report|故障报告
Fault report assigned|故障报告已分派
Fault report assigned.|故障报告已分派。
Fault report declined|故障报告已驳回
Fault report declined.|故障报告已驳回。
Fault report needs review|有故障报告待审核
Fault report saved offline and queued.|故障报告已离线保存，等待同步。
Fault report sent for review.|故障报告已提交审核。
Fault report unavailable|故障报告不可用
Fault reports|故障上报
Fault title|故障标题
FieldProof cannot reach the server.|FieldProof 无法连接服务器。
FieldProof could not open this workspace|FieldProof 无法打开此工作区
Finding linked; verification reset|已关联新发现，维修需重新验收
Finding notes|现场说明
First-time setup|首次设置
Frequency|频率
Full name|姓名
Go online to sign in and prepare this device for offline work.|请联网登录并在此设备上启用离线工作。
High|高
In Progress|进行中
In service|在用
Inspection|巡检
Inspection unavailable|巡检不可用
Inspection area|巡检区域
Inspection assigned|已分派巡检
Inspection completion|巡检完成率
Inspection draft saved.|巡检草稿已保存。
Inspection draft saved on this device.|巡检草稿已保存在本机。
Inspection due today|巡检今天到期
Inspection finding|巡检发现
Inspection finding linked|已关联巡检发现
Inspection history|巡检记录
Inspection overdue|巡检逾期
Inspection progress|巡检进度
Inspection question not found.|未找到检查项。
Inspection report|巡检报告
Inspection saved. Submission is queued for synchronization.|巡检已保存，提交内容等待同步。
Inspection schedule|巡检计划
Inspection site|巡检站点
Inspection status|巡检状态
Inspection submitted.|巡检已提交。
Inspection template|巡检模板
Inspection templates|巡检模板
Inspections|巡检
Inspector|巡检员
Invalid backup. Check the file and try again.|备份文件无效，请检查后重试。
Invalid check.|检查项无效。
Invalid corrective action choices.|整改处理方式无效。
Invalid JPEG dimensions or color format.|JPEG 尺寸或颜色格式无效。
Invalid JPEG photograph.|JPEG 照片无效。
Invalid JSON request.|JSON 请求无效。
Invalid photo metadata.|照片信息无效。
Invalid photograph.|照片无效。
Invalid record identifier.|记录编号无效。
Invalid request body.|请求内容无效。
Invite member|邀请成员
Invite members, change access, and review account and workspace activity.|邀请成员、更改权限、查看账户与工作区活动。
Invited|已邀请
Issue a new activation code|重新生成激活码
It may belong to a different browser workspace.|该记录可能属于其他工作区。
Keep another active administrator before resetting this password.|重置密码前请保留另一位已启用的管理员。
Keep at least one active administrator.|请至少保留一位已启用的管理员。
Keep this tab online until the offline app finishes installing.|请保持此标签页在线，直至离线应用安装完成。
Language|语言
Last 14 days|最近 14 天
Last 30 days|最近 30 天
Last 60 days|最近 60 天
Last 90 days|最近 90 天
Latest 20 completed readings per check and unit.|按检查项和单位显示最近 20 次已完成的测量。
Link a matching issue or create a separate order. Every finding and photo will be kept.|选择关联同一问题或创建单独工单。所有发现和照片都会保留。
Link an open order for the same check, if available|如有同一检查项的未关闭工单，则关联该工单
Linked corrective actions|关联整改工单
Linked findings and fault reports|关联巡检发现与故障报告
Location|位置
Location type|位置类型
Locations|位置
Low|低
Main navigation|主导航
Maintenance|维修人员
Maintenance activity|维修活动
Manage|管理
Manage member|管理成员
Manage property locations and view linked equipment history.|管理物业位置并查看设备关联历史。
Manage shared workspace records and evidence.|管理共享工作区记录和证据。
Manage team access, workspace defaults, and backups.|管理团队权限、工作区默认值和备份。
Manufacturer|制造商
Maximum (inclusive)|上限（含）
Measurement|测量值
Measurement trend|测量趋势图
Measurement trends|测量趋势
Medium|中
Member activation code|成员激活码
Menu|菜单
Minimum (inclusive)|下限（含）
Model|型号
Monitor inspections, asset health, and corrective actions across your sites.|监控各站点的巡检、设备状态和整改进度。
Monthly|每月
My fault reports|我的故障报告
My Inspections|我的巡检
My Work|我的工单
My work queue|我的工单
Name|名称
New evidence on work order|工单有新证据
New inspection|新建巡检
New password|新密码
New recurring schedule|新建周期计划
New schedules use the latest template. Existing inspections keep their original checklist.|新计划使用最新模板。现有巡检保留原检查清单。
New template|新建模板
New work order|新建工单
Next new occurrence|下次生成日期
No description recorded.|暂无描述。
No draft change was supplied.|没有可保存的草稿更改。
No equipment in this location.|此位置暂无设备。
No fault reports yet.|暂无故障报告。
No history yet.|暂无记录。
No inspection templates yet.|暂无巡检模板。
No inspections for this asset.|此设备暂无巡检记录。
No matching records in this period.|此期间没有符合条件的记录。
No notifications yet|暂无通知
No prior-period comparison|暂无上期数据
No records match your filters.|没有符合筛选条件的记录。
No recurring schedules yet.|暂无周期计划。
No tasks in this group.|此组暂无任务。
No work orders to show.|暂无工单。
Notes|备注
Notifications|通知
Numerical measurement|数值测量
Occurrences are prepared when you open FieldProof. Existing occurrences retain their dates and checklist.|周期巡检由服务器生成。已生成的巡检保留原日期和检查清单。
Offline|离线
Offline preparation|离线准备
On-site report linked|已关联现场故障报告
Only JPEG evidence is accepted.|证据照片必须为 JPEG 格式。
Only managers can perform this action.|仅主管或管理员可执行此操作。
Only open work orders can be started.|只有待处理工单可以开始维修。
Only repairs pending verification can be reviewed.|只能审核待验收的维修。
Open|待处理
Open navigation|打开导航
Open work|未关闭工单
Open work orders|未关闭工单
Open your assigned work, add repair evidence, and send completed repairs for verification.|查看分派给您的工单、添加维修证据并申请验收。
Opened|新建
Operational status|运行状态
Operation not found.|未找到此操作。
Operations overview|运营概览
Out of service|停用
Outstanding and recently closed|未关闭及最近关闭的工单
Outstanding work, ordered by due date|按截止日期排序的未关闭工单
Overdue|已逾期
Overdue responses first, then by repair due date.|响应逾期优先，其余按维修截止日期排序。
Overdue work orders|逾期工单
Page not found.|未找到页面。
Parent location|上级位置
Pass|合格
Pass / Fail|合格／不合格
Pass criteria|合格标准
Password|密码
Password changed. Other sessions were signed out.|密码已更新，其他会话已退出。
Pause|暂停
Paused|已暂停
PDF language|PDF 语言
PDF report downloaded.|PDF 报告已下载。
Pending Verification|待验收
Performance indicators|绩效指标
Performance snapshot|绩效摘要
Photo removed from draft.|照片已从草稿移除。
Photograph unavailable offline|离线时无法查看此照片
Photographs must be 1,600 pixels or smaller.|照片最长边不能超过 1,600 像素。
Prepare for offline work|准备离线工作
Priority|优先级
Priority on failure|不合格时的优先级
Quarterly|每季度
Question|检查项
Question identifiers must be unique.|检查项编号必须唯一。
Queued|待同步
Reason|原因
Record|记录
Record not found|未找到记录
Record reports|记录报告
Record table|记录表
Record what changed and attach completion photos.|记录维修内容并添加完工照片。
Recorded|记录时间
Records changed after you reviewed the backup. Load it again before restoring.|您查看备份后记录已变更。请重新加载后再恢复。
Recurring|周期计划
Recurring occurrences keep their original due date. Change the recurring schedule for new dates.|已生成的巡检保留原截止日期。如需新日期，请修改周期计划。
Recurring schedule paused.|周期计划已暂停。
Recurring schedule resumed.|周期计划已恢复。
Recurring schedules|周期计划
Remove check|移除检查项
Remove photo|移除照片
Repair|维修
Repair evidence|维修证据
Repair is ready for supervisor verification.|维修已提交主管验收。
Repair notes|维修说明
Repair ready for review|维修待验收
Repair returned for rework|维修已退回返工
Repair returned for rework.|维修已退回返工。
Repair submitted for verification|维修已提交验收
Repair verified and closed|维修已验收，工单已关闭
Repair verified and work order closed.|维修已验收，工单已关闭。
Repeat|重复频率
Replace with backup|用备份替换
Report a fault|上报故障
Report unexpected equipment problems and track the review.|上报意外设备故障并跟踪审核进度。
Report type|报告类型
Reported|已上报
Reported by|上报人
Reported fault|已上报故障
Reports|报告
Request verification|申请验收
Reset password and revoke existing sessions|重置密码并退出所有现有会话
Resolve sync issue|处理同步问题
Resolve the queued sync issue before making more changes.|请先处理待同步的冲突，再继续修改。
Resolve unsynced changes before restoring.|恢复前请先处理未同步的更改。
Resolved this period|本期已解决
Response overdue|响应逾期
Response target|响应截止时间
Response targets (hours)|响应时限（小时）
Restore a backup|恢复备份
Restore backup|恢复备份
Result|结果
Resume|恢复
Retired|已报废
Return for rework|退回返工
Review corrective actions|确认整改处理方式
Review notes|审核备注
Review queue|待审核列表
Review site performance and export inspection and repair records.|查看站点绩效并导出巡检与维修记录。
Review sync issue|待处理同步问题
Review your due dates and continue inspections in the field.|查看截止日期并继续现场巡检。
Rework reason|返工原因
Role|角色
Save|保存
Save draft|保存草稿
Save member|保存成员
Save schedule|保存计划
Save settings|保存设置
Save template|保存模板
Saving draft…|正在保存草稿…
Schedule|计划
Schedule field checks, resume drafts, and manage reusable templates.|安排巡检、继续草稿、管理可复用模板。
Schedule inspection|安排巡检
Schedule not found.|未找到计划。
Scheduled|已安排
Scheduled inspection|已安排巡检
Search equipment|搜索设备
Search inspections|搜索巡检
Search work orders|搜索工单
Section views|分区视图
Select a location|选择位置
Select a location type.|请选择位置类型。
Select a priority.|请选择优先级。
Select a profile|选择成员
Select a recurrence interval.|请选择重复频率。
Select a role.|请选择角色。
Select a template|选择模板
Select a template, asset, and inspector.|请选择模板、设备和巡检员。
Select a valid assignee.|请选择有效的负责人。
Select a valid check type.|请选择有效的检查类型。
Select a valid parent location.|请选择有效的上级位置。
Select an active asset.|请选择在用设备。
Select an active inspection template.|请选择已启用的巡检模板。
Select an area|选择区域
Select an asset.|请选择设备。
Select an equipment status.|请选择设备状态。
Select an inspection area.|请选择巡检区域。
Select an inspector.|请选择巡检员。
Select equipment|选择设备
Send for review|提交审核
Send JSON.|请发送 JSON 数据。
Serial number|序列号
Server setup code|服务器设置码
Set a response target for each priority.|请为每个优先级设置响应时限。
Set each response target to 1–8,760 hours.|请将各响应时限设为 1 至 8760 小时。
Set up your workspace|设置工作区
Settings|设置
Setup code is invalid or the workspace already exists.|设置码无效，或工作区已存在。
Sign in|登录
Sign in as the account that owns these changes.|请登录保存这些更改的原账户。
Sign in to continue|登录后继续
Sign in to FieldProof|登录 FieldProof
Sign in to FieldProof.|请登录 FieldProof。
Sign in to resume synchronization.|请登录后继续同步。
Sign in to send changes saved on this device.|请登录以同步保存在本机的更改。
Sign in with the same account to retain your unsynced edits.|请用同一账户登录以保留未同步的更改。
Sign out|退出登录
Sign-in is busy. Try again in a moment.|登录服务繁忙，请稍后重试。
Sign-in required|需要登录
Site|站点
Sites & Assets|站点与设备
Skip to content|跳到内容
Someone changed this record after you opened it. Review the server version before applying your change again.|此记录已被其他人修改。请核对服务器版本再重新填写。
Something interrupted the operation. Try again.|操作中断，请重试。
Start date|开始日期
Start the work order before adding repair evidence.|请先开始此工单，再添加维修证据。
Start work|开始维修
Started|开始时间
Status|状态
Submission saved on this device. The shared workspace will update after it syncs.|提交已保存在本机。同步后将更新共享工作区。
Submit inspection|提交巡检
Submitted|提交时间
Submitted repairs|已提交的维修
Submitted repairs and completion evidence|已提交的维修和完工证据
Supervisor|主管
Suspended|已停用
Sync now|立即同步
Sync or resolve the pending changes before signing out.|请先同步或处理待处理的更改，再退出登录。
Synchronization|同步
Synchronization status|同步状态
System|系统
Team|团队
Team members|团队成员
Team workspace|团队工作区
Template|模板
Template name|模板名称
Templates|模板
That asset tag is already in use.|此设备编号已被使用。
That notification is unavailable.|此通知不可用。
That record could not be found.|未找到该记录。
The activation code is no longer available.|激活码已失效。
The assigned inspector or a supervisor can record results.|仅分派的巡检员或主管可以记录结果。
The assigned inspector or a supervisor can submit this inspection.|仅分派的巡检员或主管可以提交此巡检。
The assignee or a supervisor can record the repair.|仅负责人或主管可以记录维修。
The assignee or a supervisor can start this work.|仅负责人或主管可以开始此工单。
The browser granted persistent storage.|浏览器已允许持久存储。
The device could not save your offline changes.|设备无法保存离线更改。
The FieldProof server did not return a response.|FieldProof 服务器未返回响应。
The FieldProof server is temporarily unavailable.|FieldProof 服务器暂不可用。
The local save was interrupted. Try again.|本地保存中断，请重试。
The minimum measurement must be no greater than the maximum.|测量下限不得大于上限。
The offline app is ready.|离线应用已就绪。
The password changed during this request.|请求期间密码已更改，请重试。
The PDF font does not contain a Unicode character map.|PDF 字体缺少 Unicode 字符映射。
The PDF font is unavailable. Connect to download it and try again.|PDF 字体不可用。请联网下载后重试。
The record changed. Reopen it and try again.|记录已有变更，请重新打开后重试。
The request is too large.|请求文件过大。
The request origin does not match the FieldProof server address.|请求来源与 FieldProof 服务器地址不一致。
The selected work order is no longer open for this equipment. Review the current orders and try again.|所选工单已关闭或不适用于此设备。请查看当前工单后重试。
The server could not complete this request. Try again or contact your administrator.|服务器无法完成请求。请重试或联系管理员。
The shared workspace is up to date.|共享工作区已同步。
The workspace already exists.|工作区已存在。
The workspace has not loaded.|工作区尚未加载。
The workspace was restored. Export your unsynced changes before clearing them.|工作区已恢复。清除之前请导出未同步的更改。
This browser can clear cached data. Sync when you reconnect.|浏览器可能清除缓存。请在重新联网时同步。
This browser could not open the image. Try a JPEG or PNG.|浏览器无法打开此图片。请尝试 JPEG 或 PNG。
This browser profile does not provide local database storage.|此浏览器配置不支持本地数据库。
This check does not accept a measurement.|此检查项不接受测量值。
This device is enabled for offline work.|此设备已启用离线工作。
This email already has an account.|此邮箱已关联账户。
This fault report already exists.|此故障报告已存在。
This fault report has already been reviewed.|此故障报告已审核。
This field is required.|此字段为必填项。
This file is not readable FieldProof backup JSON.|此文件不是可读取的 FieldProof JSON 备份。
This inspection has already been completed.|此巡检已完成。
This inspection is already submitted.|此巡检已提交。
This member changed. Reopen their record and try again.|成员记录已变更，请重新打开后重试。
This operation identifier has already been used.|此操作编号已使用。
This operation is unavailable.|此操作不可用。
This photo is not cached on this device. Connect to the server to view it.|此照片未缓存在本机。联网后可查看。
This photograph is already attached.|此照片已添加。
This photograph is unavailable.|此照片不可用。
This record is already queued for submission.|此记录已进入提交队列。
This record is no longer assigned to your account or is unavailable.|此记录未分派给您或已不可用。
This removes the conflicting edit from this device. Export unsynced changes first if you need a copy.|这会从本机移除冲突更改。如需保留，请先导出未同步的更改。
This replaces work records for the entire team. Member accounts stay in place. Export the current workspace before continuing.|此操作会替换全团队的工作记录，保留成员账户。继续前请导出当前工作区。
Time from creation to starting work. Repair due dates are tracked separately.|从创建到开始维修的时间。维修完成期限单独计算。
Title|标题
Too many attempts. Try again in 15 minutes.|尝试次数过多，请在 15 分钟后重试。
Try again|重试
Unanswered|未填写
Unassigned|未分派
Unit|单位
Unknown workspace action.|未知工作区操作。
Unread|未读
Unsynced changes exported.|未同步的更改已导出。
Up to 12 photos can be attached here.|此处最多可附加 12 张照片。
Up to date|已同步
Upcoming|即将到期
Urgent|紧急
Use a password with 12 to 128 characters.|密码须为 12 至 128 个字符。
Use server version|使用服务器版本
Use the activation code from your administrator.|请输入管理员提供的激活码。
Use the server version|使用服务器版本
Use your work email and password.|使用工作邮箱和密码登录。
Verification notes (optional)|验收说明（选填）
Verification request saved. Waiting to sync.|验收申请已保存，等待同步。
Verification request saved on this device.|验收申请已保存在本机。
Verify and close|验收并关闭
View photograph|查看照片
View record|查看记录
View readings|查看测量记录
View work orders|查看工单
Weekly|每周
What did you observe?|现场发现了什么？
WORK ORDERS|工单
WORKSPACE|工作区
Work description|工作说明
Work order|工单
Work order unavailable|工单不可用
Equipment record unavailable|设备记录不可用
Work order assigned|已分派工单
Work order closed|工单已关闭
Work order created|已创建工单
Work order history|工单历史
Work order overdue|工单逾期
Work order register|工单台账
Work order site|工单站点
Work order started.|工单已开始。
Work order status|工单状态
Work Orders|工单
Work orders needing attention|待处理工单
Work orders opened and closed by date|按日期统计工单新建与关闭
Work orders opened and closed in this period|本期新建和关闭工单
Work queue|工单队列
Work started|已开始维修
Workspace|工作区
Workspace audit history|工作区审计记录
Workspace name|工作区名称
Workspace unavailable|工作区不可用
Workspace created|已创建工作区
Workspace restored|已恢复工作区
Workspace settings updated|已更新工作区设置
Signed in|已登录
Password changed|已修改密码
Member invited|已邀请成员
Member updated|已更新成员
Member activated|已激活成员
Administrator recovery|管理员账户恢复
Recurring inspection generated|已生成周期巡检
Recurring schedule saved|已保存周期计划
Recurring schedule status changed|已更改周期计划状态
Inspection schedule updated|已更新巡检计划
Inspection started|已开始巡检
Inspection result saved|已保存巡检结果
Inspection submitted|已提交巡检
Location saved|已保存位置
Asset saved|已保存设备
Template saved|已保存模板
Repair draft saved|已保存维修草稿
Fault reported|已上报故障
Notification read|已读通知
You are offline. Saved changes will sync after reconnecting.|当前处于离线状态。重新联网后将同步已保存的更改。
You’re offline.|您当前处于离线状态。
Your saved changes can sync after you sign in again with the same account.|用原账户重新登录后，可同步保存的更改。
Acceptable range|合格范围
Enter a valid value.|请输入有效值。
Valid email required.|请输入有效的邮箱地址。
Value is outside the permitted range.|数值超出允许范围。
FieldProof — Inspection & Corrective Action|FieldProof — 巡检与整改
  `;
  const dictionary=new Map(pairs.trim().split('\n').map(line=>line.trim().split('|')));
  const formats=[
    [/^Correct: (.+)$/,'整改：$1'],[/^(WO-\d+ · )Correct: (.+)$/,'$1整改：$2'],
    [/^Page (\d+) of (\d+)$/,'第 $1 页／共 $2 页'],[/^Check (\d+)$/,'检查项 $1'],
    [/^Repair attempt (\d+)$/,'第 $1 次维修'],[/^(\d+) of (\d+) checks$/,'已检查 $1／$2 项'],
    [/^(\d+) failed$/,'$1 项不合格'],[/^(\d+) tasks?$/,'$1 项任务'],
    [/^(\d+) records$/,'$1 条记录'],[/^(\d+) assets$/,'$1 台设备'],
    [/^(\d+) evidence sources$/,'$1 条证据来源'],[/^(\d+) of (\d+) due · (.+)$/,'已完成 $1／$2 项 · $3'],
    [/^([+-]?\d+)( pp)? vs previous period$/,'较上期 $1$2'],
    [/^Offline · (\d+) queued$/,'离线 · $1 项待同步'],[/^(\d+) queued$/,'$1 项待同步'],
    [/^(\d+) saved changes? (?:is|are) waiting to sync\.$/,'有 $1 项更改等待同步。'],
    [/^(\d+) of (\d+) assigned evidence photos are cached on this device\.$/,'已在此设备缓存 $1／$2 张分派记录中的证据照片。'],
    [/^(\d+) photo\(s\) saved\. (.+)$/,'已保存 $1 张照片。$2'],[/^(\d+) photos? saved on this device\.$/,'已在本机保存 $1 张照片。'],
    [/^Inspection submitted\. (\d+) linked corrective action\(s\)\.$/,'巡检已提交。已关联 $1 项整改工单。'],
    [/^(\d+) overdue work orders$/,'$1 项工单逾期'],
    [/^Work orders opened and closed by date$/,'按日期统计工单新建与关闭'],
    [/^(\d+) (opened|closed) · (.+) to (.+)$/,'$1 项$2 · $3 至 $4'],
    [/^(.+) through (.+)\. (\d+) opened, (\d+) closed$/,'$1 至 $2。新建 $3 项，关闭 $4 项'],
    [/^Marked (.+)$/,'标记于 $1'],[/^Recorded (.+)$/,'记录于 $1'],[/^Reviewed (.+)$/,'审核于 $1'],
    [/^Submitted (.+) by (.+)\.$/,'由 $2 提交于 $1。'],[/^Assigned to (.+)\.$/,'负责人：$1。'],
    [/^Switch to (.+) or a supervisor to record results\.$/,'请以 $1 或主管身份记录结果。'],
    [/^Switch to the assigned profile to start\.$/,'请使用负责人的账户开始维修。'],
    [/^((?:IN|WO)-\d+ · .+ · )Due (.+)$/,'$1截止 $2'],
    [/^Result for (.+)$/,'$1 的结果'],[/^Finding notes for (.+)$/,'$1 的现场说明'],
    [/^(.+) is required\.$/,'请填写$1。'],[/^Invalid (.+)\.$/,'$1无效。'],
    [/^Share this one-use code privately with$/,'请私下将此一次性激活码交给'],
    [/^The member should select$/,'。成员应在登录页面选择'],
    [/^on the sign-in page\. The code expires in 72 hours\.$/,'。激活码有效期为 72 小时。'],
    [/^contains (\d+) assets, (\d+) inspections, (\d+) work orders, and (\d+) photos\.$/,'含 $1 台设备、$2 次巡检、$3 个工单和 $4 张照片。'],
    [/^Assignee: (.+)$/,'负责人：$1'],[/^Priority: (.+)$/,'优先级：$1'],[/^Due: (.+)$/,'截止：$1']
  ];
  const aliases=new Map([['opened','新建'],['closed','关闭'],['name','名称'],['role','角色'],['priority','优先级'],
    ['email address','电子邮箱'],['photo filename','照片文件名'],['photograph','照片'],['edit version','编辑版本'],
    ['due','截止日期'],['start','开始日期'],['question','检查项'],['pass criteria','合格标准'],['title','标题'],
    ['activation code','激活码'],['setup code','设置码'],['description','描述'],['notes','说明']]);
  let language='en';
  try { if (localStorage.getItem('fieldproof-language')==='zh') language='zh'; } catch {}
  const locale=()=>language==='zh'?'zh-CN':'en-US';
  function chinese(input) {
    const direct=dictionary.get(input)||aliases.get(input);
    if (direct) return direct;
    for (const [pattern,replacement] of formats) {
      if (pattern.test(input)) return input.replace(pattern,(...items)=>{
        const matches=items.slice(1,-2);
        return replacement.replace(/\$(\d)/g,(_,number)=>{
          const value=matches[+number-1]||'';
          return value===' pp'?' 个百分点':dictionary.get(value)||aliases.get(value)||value.replace(/^([+-]?\d+)( pp)? vs previous period$/,(_,n,pp)=>'较上期 '+n+(pp?' 个百分点':''));
        });
      });
    }
    if (input.includes(' · ')) return input.split(' · ').map(piece=>dictionary.get(piece)||piece).join(' · ');
    return input;
  }
  function t(value,target=language) {
    if (target!=='zh'||typeof value!=='string') return value;
    const body=value.trim();
    return body?value.replace(body,chinese(body)):value;
  }
  const report=target=>value=>{
    if (target==='both') {
      const translated=t(value,'zh');
      return translated===value?value:value+' / '+translated;
    }
    return t(value,target||language);
  };
  const switcher=()=>`<label class="language-control"><select data-language aria-label="Language" title="Language"><option value="en" lang="en" translate="no"${language==='en'?' selected':''}>EN</option><option value="zh" lang="zh-CN" translate="no"${language==='zh'?' selected':''}>中文</option></select></label>`;
  function set(next) {
    language=next==='zh'?'zh':'en';
    try { localStorage.setItem('fieldproof-language',language); } catch {}
    document.documentElement.lang=locale();
    document.title=t('FieldProof — Inspection & Corrective Action');
    const skip=document.querySelector('.skip');
    if (skip) skip.textContent=t('Skip to content');
  }
  function apply(root) {
    if (language!=='zh'||!root) return;
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node=walker.currentNode;
      if (node.parentElement?.closest('[translate="no"], textarea, script, style')) continue;
      node.nodeValue=t(node.nodeValue);
    }
    for (const element of [root,...root.querySelectorAll('[aria-label],[placeholder],[title]')]) {
      if (element.closest?.('[translate="no"]')) continue;
      for (const attr of ['aria-label','placeholder','title']) if (element.hasAttribute?.(attr)) element.setAttribute(attr,t(element.getAttribute(attr)));
    }
  }
  FP.i18n={t,apply,locale,report,set,switcher};
  set(language);
})();

(() => {
  const paths = {
    logo:'<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V3h6v2M8.5 12l2.5 2.5 4.5-5"/>',
    dashboard:'<rect x="3" y="3" width="7" height="8" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/>',
    clip:'<rect x="5" y="4" width="14" height="17" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 11h6m-6 4h6"/>',
    wrench:'<path d="M14.2 6.2a5.1 5.1 0 0 0-6.4 6.4L3 17.4a2.5 2.5 0 1 0 3.6 3.5l4.8-4.8a5.1 5.1 0 0 0 6.4-6.4l-3.2 3.2-3.6-3.6z" transform="translate(1,-2)"/>',
    layers:'<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',
    chart:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m6 15 4-4 3 2 4-5"/>',
    gear:'<path d="M10 2h4l.5 2.4 2.1 1.2 2.4-.7 2 3.4-1.9 1.7v2.6l1.9 1.7-2 3.4-2.4-.7-2.1 1.2L14 21h-4l-.5-2.8-2.1-1.2-2.4.7-2-3.4L5 12.6V10L3 8.3l2-3.4 2.4.7 2.1-1.2z"/><circle cx="12" cy="11.6" r="3"/>',
    plus:'<path d="M12 5v14M5 12h14"/>', chevron:'<path d="m9 6 6 6-6 6"/>', down:'<path d="m6 9 6 6 6-6"/>', back:'<path d="m12 6-6 6 6 6M6 12h13"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    pin:'<path d="M20 10c0 5-8 10-8 10s-8-5-8-10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    check:'<path d="m5 12 4 4 10-10"/>', circle:'<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
    warning:'<path d="M10.3 4.5a2 2 0 0 1 3.4 0l7.1 12.2a2 2 0 0 1-1.7 3H4.9a2 2 0 0 1-1.7-3zM12 9v4m0 3h.01"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    trend:'<path d="m3 17 6-6 4 4 7-8m-6 0h6v6"/>',
    computer:'<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8m-4-4v4"/>',
    menu:'<path d="M4 6h16M4 12h16M4 18h16"/>', x:'<path d="m6 6 12 12M6 18 18 6"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    file:'<path d="M7 3h7l4 4v14H6V4a1 1 0 0 1 1-1zm7 0v5h4M9 12h6m-6 4h6"/>',
    building:'<path d="M3 21h18M5 21V7l7-4v18m0-12h7v12M8 9h1m-1 4h1m-1 4h1m6-4h1m-1 4h1"/>',
    box:'<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5M12 12v9"/>',
    camera:'<path d="M4 6h4l1.5-2h5L16 6h4a1 1 0 0 1 1 1v12H3V7a1 1 0 0 1 1-1Z"/><circle cx="12" cy="12.5" r="3"/>',
    edit:'<path d="m4 16 12-12 4 4L8 20H4v-4Zm10-10 4 4"/>',
    download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
    upload:'<path d="M12 15V3m-4 4 4-4 4 4M4 16v4h16v-4"/>',
    repeat:'<path d="M4 10V6h15l-3-3m3 3-3 3M20 14v4H5l3 3m-3-3 3-3"/>',
    arrow:'<path d="M4 12h15m-5-5 5 5-5 5"/>',
    bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-2 7-2 9h16c0-2-2-2-2-9m-8 12a2 2 0 0 0 4 0"/>'
  };
  const {find,localDay,asDate,shift,stats,location,assetSite,open,isOverdue,occurrence} = FP;
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = (name,size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
  const locale=()=>FP.i18n?.locale()||'en-US';
  const date = day => day ? asDate(day).toLocaleDateString(locale(),{month:'short',day:'numeric',year:'numeric'}) : '—';
  const shortDate = day => asDate(day).toLocaleDateString(locale(),{month:'short',day:'numeric'});
  const stamp = iso => iso ? new Date(iso).toLocaleString(locale(),{dateStyle:'medium',timeStyle:'short'}) : '—';
  const slug = value => value.toLowerCase().replaceAll(' ','-');
  const tag = label => `<span class="tag tag-${slug(label)}">${esc(label)}</span>`;
  const btn = (label,action,{id='',symbol='',style='',attrs=''}={}) =>
    `<button type="button" class="btn ${style}" data-action="${action}"${id ? ` data-id="${esc(id)}"`:''} ${attrs}>${symbol ? icon(symbol,17):''}${esc(label)}</button>`;
  const link = (label,route,{style='link',symbol='',attrs=''}={}) =>
    `<a class="${style}" href="#${esc(route)}" ${attrs}>${symbol ? icon(symbol,17):''}${esc(label)}</a>`;
  const items = values => values.map(value => Array.isArray(value) ? value : [value,value]);
  const opts = (values,active) => items(values).map(([value,label]) =>
    `<option value="${esc(value)}"${String(value) === String(active) ? ' selected':''}>${esc(label)}</option>`).join('');
  const select = (value,choices,label,key,symbol='') => `<label class="filter">${symbol ? icon(symbol,16):''}<select aria-label="${esc(label)}" data-filter="${key}">${opts(choices,value)}</select>${icon('down',14)}</label>`;
  const search = (value,label,key) => `<label class="filter search">${icon('search',17)}<input type="search" aria-label="${label}" placeholder="${label}" data-search="${key}" value="${esc(value)}"></label>`;
  const siteOptions = state => [['','All sites'],...state.places.filter(p=>p.kind === 'Site').map(p=>[p.id,p.name])];
  const person = (state,id) => find(state.people,id)?.name || 'Unassigned';
  const asset = (state,id) => find(state.assets,id);
  const title = (heading,description='',actions='',back='') => `<header class="page-head"><div>${back}<h1>${esc(heading)}</h1>${description ? `<p>${esc(description)}</p>`:''}</div>${actions ? `<div class="actions">${actions}</div>`:''}</header>`;
  const pane = (name,sub='',controls='') => `<div class="pane-head"><div><h2>${esc(name)}</h2>${sub ? `<p>${esc(sub)}</p>`:''}</div>${controls}</div>`;
  const empty = (heading,text='',symbol='clip') => `<div class="empty"><span>${icon(symbol,23)}</span><strong>${esc(heading)}</strong>${text ? `<p>${esc(text)}</p>`:''}</div>`;
  const cell = (main,secondary='') => main + (secondary ? `<small>${esc(secondary)}</small>`:'');
  const table = (headers,rows,emptyText='No records match your filters.') => rows.length ?
    `<div class="table-scroll" tabindex="0" aria-label="Record table"><table><thead><tr>${headers.map(h=>`<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty(emptyText);
  const tabs = (choices,active) => `<nav class="tabs" aria-label="Section views">${choices.map(([href,label])=>link(label,href,{style:active === href ? 'selected':'',attrs:active === href ? 'aria-current="page"':''})).join('')}</nav>`;
  const toolbar = (...fields) => `<div class="toolbar">${fields.join('')}</div>`;
  const files = (state,ids,remove='') => ids.length ? `<div class="photos">${ids.map(id => {
    const image = find(state.evidence,id);
    if (!image) return '';
    return `<figure><button type="button" data-action="photo" data-id="${esc(id)}" title="View photograph"><img data-photo="${esc(id)}" alt="${esc(image.name)}"></button><figcaption>${esc(image.name)}</figcaption>${remove ? btn('Remove photo','remove-photo',{symbol:'x',style:'icon-only remove-photo',attrs:`aria-label="Remove photo" data-photo-id="${esc(id)}" ${remove}`}) : ''}</figure>`;
  }).join('')}</div>` : '';
  const addPhoto = attrs => `<label class="btn photo-input">${icon('camera',17)} Add photos<input type="file" accept="image/*" multiple data-photo-input ${attrs}></label>`;
  const names = [
    ['dashboard','Dashboard','dashboard'],['inspections','Inspections','clip'],['work','Work Orders','wrench'],
    ['assets','Sites & Assets','layers'],['reports','Reports','chart'],['settings','Settings','gear']
  ];
  function layout(state,route,content) {
    const account = find(state.people,state.activeId);
    const manager = !state.team || FP.team.manages(account.role);
    const teamSync = state.team ? FP.teamStorage.info() : null;
    const entries = (manager ? names.filter(([path])=>path!=='settings'||!state.team||account.role==='Admin') :
      [['inspections/mine','My Inspections','clip'],['work','My Work','wrench'],['assets','Sites & Assets','layers']]).slice();
    if (state.team) entries.splice(manager?3:2,0,['faults','Fault reports','warning']);
    const unread=state.notices?.filter(row=>!row.read).length||0;
    const home = manager ? 'dashboard' : (account.role==='Maintenance'?'work':'inspections/mine');
    const syncLabel = teamSync ? FP.teamStorage.label() : '';
    const overdue = state.work.filter(record => isOverdue(record,FP.workspaceDay(state))||FP.ops?.responseLate(record)).length;
    const section = (route[1]==='mine'?'My Inspections':entries.find(([path])=>path.split('/')[0] === route[0])?.[1]) || 'Dashboard';
    const initials = account.name.split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase();
    return `<aside class="sidebar" id="sidebar"><a class="brand" href="#${home}"><span>${icon('logo',24)}</span>FieldProof</a><nav aria-label="Main navigation"><div class="nav-label">WORKSPACE</div>${entries.map(([path,label,symbol])=>
      `<a href="#${path}"${path.split('/')[0] === route[0] ? ' class="active" aria-current="page"':''}>${icon(symbol,19)}<span>${label}</span>${path==='work' && overdue ? `<b title="${overdue} overdue work orders">${overdue}</b>`:''}</a>`).join('')}</nav>
      <div class="local"><div class="local-icon">${icon('computer',19)}</div><div><strong>${state.team?'Team workspace':'Local workspace'}</strong><span><i></i>${state.team ? esc(syncLabel) : 'Data saved on this device'}</span></div></div></aside>
      <button id="nav-shade" class="nav-shade" type="button" data-action="menu" aria-label="Close navigation"></button>
      <div class="workspace"><header class="topbar"><div class="crumb">${btn('Menu','menu',{symbol:'menu',style:'icon-only mobile-menu',attrs:'aria-label="Open navigation" aria-expanded="false" aria-controls="sidebar"'})}<span class="crumb-brand">${esc(state.workspace)}</span><span class="crumb-divider">/</span><strong>${section}</strong></div>
      <div class="top-controls">${state.team ? btn(syncLabel,'sync-status',{symbol:'repeat',style:'sync-button '+(teamSync.issue?'attention':''),attrs:'aria-label="Synchronization status"'})+
        `<button class="btn icon-only inbox-trigger" type="button" data-action="inbox" aria-label="Notifications" title="Notifications">${icon('bell',17)}${unread?`<span>${unread>99?'99+':unread}</span>`:''}</button>` +
        FP.i18n.switcher() : ''}<button class="profile" data-action="profile" aria-label="${state.team?'Account':'Switch local profile'}" type="button"><span class="avatar">${esc(initials)}</span><span class="profile-name"><span translate="no">${esc(account.name)}</span><small>${esc(account.role)}</small></span>${icon('down',15)}</button></div></header>
      ${teamSync?.issue ? `<div class="sync-notice" role="status">Changes are waiting for review. ${btn('Resolve sync issue','sync-status',{style:'subtle'})}</div>` : ''}
      ${teamSync?.expired ? `<div class="sync-notice" role="status">Sign in to resume synchronization. ${btn('Sign in','reauth',{style:'subtle'})}</div>` : ''}
      <main id="main" tabindex="-1">${content}</main></div>`;
  }
  function workRows(state,records,compact = false) {
    return table(['Work order','Asset / location','Priority','Due date','Status'],records.map(work => {
      const machine = asset(state,work.assetId);
      const responseLate=FP.ops?.responseLate(work);
      const late = isOverdue(work,FP.workspaceDay(state));
      return [cell(link(work.title,'work/'+work.id),work.id + (compact ? ' · '+person(state,work.assigneeId):'')),
        cell(esc(machine.name),location(state,machine)),tag(work.priority),`<span class="${late ? 'late':''}">${date(work.due)}</span>${late ? '<small class="late">Overdue</small>':''}`,tag(work.status)+(responseLate?'<small class="late">Response overdue</small>':'')];
    }), 'No work orders to show.');
  }
  const colors = ['#2465bf','#f0af31','#30b4cc','#a7d8f2'];
  function chart(data) {
    const chartMax = Math.max(4,...data.groups.flatMap(g=>[g.opened,g.closed]));
    const step = Math.ceil(chartMax / 4);
    const rounded = step * 4;
    return `<div class="bar-chart" role="group" aria-label="Work orders opened and closed by date">
       <div class="axis-labels">${[4,3,2,1,0].map(n=>`<span>${n*step}</span>`).join('')}</div>
       <div class="plot"><div class="grid-lines" aria-hidden="true">${Array.from({length:5},()=>'<i></i>').join('')}</div>
       ${data.groups.map(group=>`<div class="bar-group" aria-label="${shortDate(group.start)} through ${shortDate(group.end)}. ${group.opened} opened, ${group.closed} closed">
       <div class="bars">${['opened','closed'].map(key=>`<span class="bar ${key}" style="height:${group[key]/rounded*100}%" title="${group[key]} ${key} · ${shortDate(group.start)} to ${shortDate(group.end)}"></span>`).join('')}</div><small>${shortDate(group.start)}</small></div>`).join('')}</div>
       </div><div class="legend bar-legend"><span><i style="--swatch:#2465bf"></i>Opened</span><span><i style="--swatch:#9cd6f2"></i>Closed</span></div>`;
  }
  function donut(data) {
    const total = data.distribution.reduce((a,b)=>a+b,0);
    let cumulative = 0;
    const stops = data.distribution.map((value,index)=>{
      const start = cumulative;
      cumulative += 100 * value / (total || 1);
      return `${colors[index]} ${start}% ${cumulative}%`;
    });
    return `<div class="donut-wrap"><div class="donut" style="--donut:${total ? `conic-gradient(${stops.join(',')})`:'#e7edf5'}"><div><strong>${total}</strong><span>WORK ORDERS</span></div></div></div>
      <div class="legend status-legend">${FP.statuses.map((status,index)=>`<span><i style="--swatch:${colors[index]}"></i>${status}<b>${data.distribution[index]}</b></span>`).join('')}</div>`;
  }
  function dashboard(state,filters,report = false) {
    const days = +filters.days;
    const summary = stats(state,filters.site,days);
    const prior = stats(state,filters.site,days,FP.workspaceDay(state),days);
    const delta = (current,previous,suffix='') => {
      if (current === null || previous === null) return 'No prior-period comparison';
      const change = current - previous;
      return (change > 0 ? '+' : '')+change+suffix+' vs previous period';
    };
    const metrics = [
      ['circle','green',summary.rate === null ? '—':summary.rate+'%','Inspection completion',summary.completed+' of '+summary.inspections.length+' due · '+delta(summary.rate,prior.rate,' pp')],
      ['wrench','blue',summary.outstanding.length,'Open work orders',delta(summary.outstanding.length,prior.outstanding.length)],
      ['warning','red',summary.overdue.length,'Overdue work orders',delta(summary.overdue.length,prior.overdue.length)],
      ['check','teal',summary.resolved,'Resolved this period',delta(summary.resolved,prior.resolved)]
    ];
    const attention = summary.outstanding.slice().sort((a,b)=>Number(!!FP.ops?.responseLate(b))-Number(!!FP.ops?.responseLate(a))||
      a.due.localeCompare(b.due) || FP.priorities.indexOf(a.priority)-FP.priorities.indexOf(b.priority)).slice(0,6);
    const actions = select(filters.site,siteOptions(state),'Site','site','pin')+(report ? '' : btn('New inspection','new-inspection',{symbol:'plus',style:'primary'}));
    return title(report ? 'Reports':'Operations overview',report ? 'Review site performance and export inspection and repair records.' : 'Monitor inspections, asset health, and corrective actions across your sites.',actions)+
      `<div class="section-head"><div><h2>Performance snapshot</h2><p>${shortDate(summary.start)} – ${date(summary.end)}</p></div>${select(filters.days,[[14,'Last 14 days'],[30,'Last 30 days'],[60,'Last 60 days'],[90,'Last 90 days']],'Date range','days','calendar')}</div>
       <section class="metrics" aria-label="Performance indicators">${metrics.map(([symbol,tone,num,label,change])=>`<div class="metric surface"><span class="metric-icon ${tone}">${icon(symbol,24)}</span><div><strong>${num}</strong><h3>${label}</h3><p>${change}</p></div></div>`).join('')}</section>
       <div class="charts"><section class="surface chart-pane">${pane('Maintenance activity','Work orders opened and closed in this period')}${chart(summary)}</section>
       <section class="surface chart-pane status-pane">${pane('Work order status','Current backlog and period closures')}${donut(summary)}</section></div>`+
       (report ? reportTable(state,summary,filters) : `<section class="surface">${pane('Work orders needing attention',state.team?'Overdue responses first, then by repair due date.':'Outstanding work, ordered by due date',link('View work orders','work',{style:'btn subtle',symbol:'arrow'}))}${workRows(state,attention,true)}</section>`);
  }
  function reportTable(state,summary,filters) {
    const filteredWork = state.work.filter(work => (!filters.site || assetSite(state,work.assetId)===filters.site));
    const reportIn = summary.inspections.filter(item=>item.status === 'Completed');
    const reportWork = filteredWork.filter(item=>[item.createdAt,item.closedAt].some(iso=>{
      const day=iso&&FP.zonedDay(new Date(iso),state.timeZone);
      return day>=summary.start&&day<=summary.end;
    }));
    const rows = (filters.reportKind === 'work' ? reportWork : reportIn).sort((a,b)=>(b.closedAt||b.submittedAt||b.createdAt).localeCompare(a.closedAt||a.submittedAt||a.createdAt));
    return `<section class="surface">${pane('Record reports','Download a PDF with findings, timestamps, and evidence.',`<div class="row-actions">${select(filters.reportKind,[['inspection','Inspections'],['work','Corrective actions']],'Report type','reportKind')}
      ${state.team?select(filters.pdfLanguage,[['','Current language'],['en','English'],['zh','简体中文'],['both','English + 简体中文']],'PDF language','pdfLanguage'):''}</div>`)}${table(['Record','Asset','Status','PDF'],rows.map(item=>[
      cell(link(item.title,(filters.reportKind==='work'?'work/':'inspections/run/')+item.id),item.id),esc(asset(state,item.assetId).name),tag(item.status),
      btn('Download PDF','pdf',{id:item.id,symbol:'download',attrs:`data-kind="${filters.reportKind}" data-language="${esc(filters.pdfLanguage||'')}"`})
    ]),'No matching records in this period.')}</section>`;
  }
  const matches = (term,...values) => !term || values.some(value => String(value ?? '').toLowerCase().includes(term.trim().toLowerCase()));
  function inspections(state,route,filters) {
    const tab = route[1] || '';
    if (tab === 'run') return inspectionDetail(state,find(state.inspections,route[2]));
    const manager = !state.team || FP.team.manages(find(state.people,state.activeId).role);
    if (state.team && (tab==='mine'||!manager)) {
      const own=state.inspections.filter(item=>item.assigneeId===state.activeId);
      return title('My Inspections','Review your due dates and continue inspections in the field.')+
        (manager?tabs([['inspections','Schedule'],['inspections/mine','My Inspections'],['inspections/templates','Templates'],['inspections/recurring','Recurring']],'inspections/mine'):'')+
        taskSections(state,own,'inspection');
    }
    const heading = title('Inspections','Schedule field checks, resume drafts, and manage reusable templates.',
      btn(tab==='templates'?'New template':tab==='recurring'?'New recurring schedule':'New inspection',tab==='templates'?'template':tab==='recurring'?'recurrence':'new-inspection',{symbol:'plus',style:'primary'}));
    const nav = tabs([['inspections','Schedule'],...(state.team?[['inspections/mine','My Inspections']]:[]),['inspections/templates','Templates'],['inspections/recurring','Recurring']],route.join('/'));
    if (tab==='templates') return heading+nav+`<section class="surface">${pane('Inspection templates','New schedules use the latest template. Existing inspections keep their original checklist.')}${table(['Template','Checks','Status',''],state.templates.map(item=>
      [cell(esc(item.name),item.description),item.questions.length,tag(item.archived?'Archived':'Active'),btn('Edit template','template',{id:item.id,symbol:'edit'})]),'No inspection templates yet.')}</section>`;
    if (tab==='recurring') return heading+nav+`<section class="surface">${pane('Recurring schedules','Occurrences are prepared when you open FieldProof. Existing occurrences retain their dates and checklist.')}${table(['Inspection','Assigned to','Frequency','Next new occurrence','Status',''],state.schedules.map(item=>{
      const template=find(state.templates,item.templateId), unit=asset(state,item.assetId);
      return [cell(esc(template.name),unit.name),esc(person(state,item.assigneeId)),esc(item.interval),item.paused ? '—':date(occurrence(item.start,item.interval,item.index)),
        tag(item.paused?'Paused':template.archived||unit.status==='Retired'?'Blocked':'Active'),`<div class="row-actions">${btn('Edit','recurrence',{id:item.id,symbol:'edit'})}${btn(item.paused?'Resume':'Pause','pause',{id:item.id})}</div>`];
    }),'No recurring schedules yet.')}</section>`;
    const records = state.inspections.filter(item=>(!filters.inspectionStatus||item.status===filters.inspectionStatus) &&
      (!filters.inspectionSite||assetSite(state,item.assetId)===filters.inspectionSite) &&
      matches(filters.inspectionQuery,item.title,item.id,asset(state,item.assetId).name,person(state,item.assigneeId)));
    records.sort((a,b)=>Number(a.status==='Completed')-Number(b.status==='Completed') || (a.status==='Completed' ? b.submittedAt.localeCompare(a.submittedAt) : a.due.localeCompare(b.due)));
    return heading+nav+toolbar(search(filters.inspectionQuery,'Search inspections','inspectionQuery'),
      select(filters.inspectionSite,siteOptions(state),'Inspection site','inspectionSite','pin'),
      select(filters.inspectionStatus,[['','All statuses'],'Scheduled','Draft','Completed'],'Inspection status','inspectionStatus'))+
      `<section class="surface">${pane('Inspection schedule',records.length+' records')}${table(['Inspection','Equipment / location','Assigned to','Due date','Status'],records.map(item=>{
      const machine=asset(state,item.assetId);
      return [cell(link(item.title,'inspections/run/'+item.id),item.id+(item.scheduleId?' · Recurring':'')),cell(esc(machine.name),location(state,machine)),esc(person(state,item.assigneeId)),date(item.due),tag(item.status)];
    }))}</section>`;
  }
  function taskSections(state,records,kind) {
    const today=FP.workspaceDay(state), inspection=kind==='inspection';
    const closed=record=>inspection?record.status==='Completed':record.status==='Closed';
    const active=records.filter(record=>!closed(record)).sort((a,b)=>a.due.localeCompare(b.due));
    const late=item=>item.due<today||(!inspection&&FP.ops?.responseLate(item));
    const groups=[['Overdue',active.filter(late)],
      ['Due today',active.filter(item=>!late(item)&&item.due===today)],
      ['Upcoming',active.filter(item=>!late(item)&&item.due>today)],
      ['Completed',records.filter(closed).sort((a,b)=>(b.submittedAt||b.closedAt).localeCompare(a.submittedAt||a.closedAt)).slice(0,12)]];
    return `<div class="field-queues">${groups.map(([label,list])=>`<section class="surface task-section">${pane(label,list.length+(list.length===1?' task':' tasks'))}
      ${list.length ? list.map(item=>`<a class="task-row" href="#${inspection?'inspections/run/':'work/'}${esc(item.id)}"><div><strong>${esc(item.title)}</strong><small>${esc(asset(state,item.assetId).name)}</small><small>${esc(location(state,asset(state,item.assetId)))}</small></div>
        <div class="task-due"><small>${date(item.due)}</small>${tag(state.pendingSubmissions?.includes(item.id)?'Queued':item.status)}
        ${!inspection&&FP.ops?.responseLate(item)?'<small class="late">Response overdue</small>':''}${icon('chevron',14)}</div></a>`).join('') :
        '<p class="task-empty">No tasks in this group.</p>'}</section>`).join('')}</div>`;
  }
  function inspectionDetail(state,record) {
    if (!record) return missing('Inspection','inspections');
    const active = find(state.people,state.activeId);
    const machine = asset(state,record.assetId);
    const done = record.status==='Completed';
    const manager=!state.team?active.role==='Supervisor':FP.team.manages(active.role);
    const queued=state.pendingSubmissions?.includes(record.id);
    const taken=state.team && FP.teamStorage.info().expired;
    const editable = !done && !queued && !taken && (active.id===record.assigneeId||manager);
    const answered=Object.values(record.results).filter(result=>result.value).length;
    const failed=Object.values(record.results).filter(result=>result.value==='Fail').length;
    const currentWork = state.team?state.issueLinks?.filter(item=>item.inspectionId===record.id)||[]:state.work.filter(item=>item.inspectionId===record.id);
    const tools = done ? btn('Download PDF','pdf',{id:record.id,symbol:'download',attrs:'data-kind="inspection"'}) :
      (!state.team&&record.scheduleId) || (state.team&&!manager)? '' : btn(record.scheduleId?'Edit inspector':'Edit schedule','reschedule',{id:record.id,symbol:'edit'});
    return `<div class="detail-wrap">${title(record.title,record.id+' · '+person(state,record.assigneeId)+' · Due '+date(record.due),tools,link(state.team&&!manager?'My Inspections':'Inspections',state.team&&!manager?'inspections/mine':'inspections',{style:'back-link',symbol:'back'}))}
       <section class="surface inspection-meta"><div class="equipment"><div class="metric-icon blue">${icon('box',22)}</div><div>${link(machine.name,'assets/item/'+machine.id)}<p>${esc(location(state,machine))}</p></div></div>${tag(queued?'Queued':record.status)}</section>
       <div class="progress-head"><strong id="check-progress">${answered} of ${record.questions.length} checks</strong><span id="failure-progress">${failed} failed</span></div><progress value="${answered}" max="${record.questions.length}" aria-label="Inspection progress"></progress>
       ${done ? `<p class="inline-info">Submitted ${stamp(record.submittedAt)} by ${esc(person(state,record.submittedBy))}.</p>` :
         queued ? '<p class="inline-info">Submission saved on this device. The shared workspace will update after it syncs.</p>' :
         !editable && !taken ? `<p class="inline-info">Assigned to ${esc(person(state,record.assigneeId))}.</p>`:''}
       <div class="check-list">${record.questions.map((question,index)=>{
        const result=record.results[question.id];
        const data=`data-id="${record.id}" data-question="${esc(question.id)}" data-kind="inspection"`;
        const related=currentWork.find(order=>order.questionId===question.id);
        const numeric=FP.ops?.isReading(question);
        const reading=numeric?FP.fieldUI.measurement(question,result,data,editable):'';
        const resultButtons=numeric?reading:`<div class="choices" aria-label="Result for ${esc(question.label)}">${['Pass','Fail'].map(value=>btn(value,'answer',{symbol:value==='Pass'?'check':'x',style:'choice '+slug(value),attrs:`${data} data-value="${value}" aria-pressed="${result.value===value}"`})).join('')}</div>`;
        return `<section class="surface check-card"><div class="check-title"><span>${index+1}</span><div><h2 translate="no">${esc(question.label)}</h2>${question.criteria?`<p translate="no">${esc(question.criteria)}</p>`:''}</div></div>
          ${editable ? `${resultButtons}
          <label class="field">Finding notes<textarea rows="2" maxlength="4000" placeholder="Add observations (required for a fail)" aria-label="Finding notes for ${esc(question.label)}" data-draft ${data}>${esc(result.notes)}</textarea></label>
          <div class="evidence-tools">${addPhoto(data)}<small>${result.at ? 'Marked '+stamp(result.at):''}</small></div>${files(state,result.photos,data)}` :
          `${reading}<div class="record-result">${tag(result.value||'Unanswered')} ${result.at ? esc(stamp(result.at)):''}</div>${result.notes ? `<p class="body-copy" translate="no">${esc(result.notes)}</p>`:''}${files(state,result.photos)}`}
          ${related ? `<div class="linked-record">${icon('wrench',16)}${find(state.work,related.id) ? link(related.id+' · '+related.title,'work/'+related.id):`<strong>${esc(related.id+' · '+related.title)}</strong>`}${tag(related.status)}</div>`:''}</section>`;
       }).join('')}</div>
       ${editable ? `<div class="inspection-footer"><span id="draft-state">${record.status==='Draft'?'Draft saved on this device':'Scheduled inspection'}</span><div class="actions">${btn('Save draft','save-draft',{id:record.id})}${btn('Submit inspection','submit',{id:record.id,style:'primary',symbol:'check'})}</div></div>`:''}</div>`;
  }
  const missing = (label,route) => title(label+' unavailable','',link('Back to list',route,{style:'btn',symbol:'back'}))+empty('Record not found','It may belong to a different browser workspace.');
  function timeline(state,events) {
    return events.length ? `<ol class="timeline">${events.slice().reverse().map(event=>`<li><strong>${esc(event.title)}</strong><small>${stamp(event.at)} · ${esc(person(state,event.actorId))}</small>${event.note ? `<p>${esc(event.note)}</p>`:''}</li>`).join('')}</ol>` : empty('No history yet.');
  }
  function workPage(state,route,filters) {
    const manager=!state.team||FP.team.manages(find(state.people,state.activeId).role);
    const records=state.work.filter(item=>(!filters.workSite||assetSite(state,item.assetId)===filters.workSite) &&
      (!filters.workStatus || (filters.workStatus==='overdue' ? isOverdue(item,FP.workspaceDay(state))||FP.ops?.responseLate(item):filters.workStatus==='assigned' ? item.assigneeId===state.activeId && open(item):item.status===filters.workStatus)) &&
      matches(filters.workQuery,item.title,item.id,asset(state,item.assetId).name,person(state,item.assigneeId)))
      .sort((a,b)=>Number(!open(a))-Number(!open(b))||a.due.localeCompare(b.due));
    if (route[1]) {
      const record=find(state.work,route[1]);
      if (!record) return missing('Work order','work');
      return title(manager?'Work Orders':'My Work','',manager?btn('New work order','new-work',{symbol:'plus',style:'primary'}):'',link(manager?'All work orders':'My work queue','work',{style:'back-link',symbol:'back'}))+
        `<div class="work-split"><aside class="surface work-list">${pane('Work queue','Outstanding and recently closed')}${[record,...records.filter(item=>item.id!==record.id)].slice(0,16).map(item=>
          `<a class="queue-item ${item.id===record.id ? 'chosen':''}" href="#work/${item.id}"><div><strong>${esc(item.title)}</strong><span>${esc(item.id)} · ${date(item.due)}</span>${tag(item.status)}</div>${icon('chevron',15)}</a>`).join('')}</aside>${workDetail(state,record)}</div>`;
    }
    if (!manager) return title('My Work','Open your assigned work, add repair evidence, and send completed repairs for verification.')+taskSections(state,state.work,'work');
    return title('Work Orders','Assign corrective actions, record repairs, and verify completed work.',btn('New work order','new-work',{symbol:'plus',style:'primary'}))+
      toolbar(search(filters.workQuery,'Search work orders','workQuery'),select(filters.workSite,siteOptions(state),'Work order site','workSite','pin'),
        select(filters.workStatus,[['','All statuses'],['overdue','Overdue'],['assigned','Assigned to me'],...FP.statuses],'Work order status','workStatus'))+
      `<section class="surface">${pane('Work order register',records.length+' records')}${workRows(state,records,true)}</section>`;
  }
  function workDetail(state,record) {
    const machine=asset(state,record.assetId);
    const active=find(state.people,state.activeId);
    const finding=find(state.inspections,record.inspectionId)?.results[record.questionId];
    const manager=state.team?FP.team.manages(active.role):active.role==='Supervisor';
    const queued=state.pendingSubmissions?.includes(record.id);
    const inProgress=record.status === 'In Progress' && !queued && (active.id===record.assigneeId||manager);
    const data=`data-id="${record.id}" data-kind="work"`;
    const owner = active.id===record.assigneeId||manager;
    const selfRepair=state.team&&record.repairs.some(repair=>repair.actorId===active.id||repair.contributors?.includes(active.id));
    const phase = queued ? '<span class="hint">Verification request saved. Waiting to sync.</span>' : record.status === 'Open' ? (record.assigneeId && owner ? btn('Start work','start-work',{id:record.id,symbol:'wrench',style:'primary'}) :
      `<span class="hint">${record.assigneeId ? 'Switch to the assigned profile to start.' : 'Assign this work order before starting.'}</span>`) :
      record.status === 'Pending Verification' ? (manager ?
        btn('Return for rework','review',{id:record.id,attrs:'data-value="reject"'})+(selfRepair?'<span class="hint">An independent supervisor must verify this repair.</span>':btn('Verify and close','review',{id:record.id,symbol:'circle',style:'primary',attrs:'data-value="close"'})) :
        '<span class="hint">A supervisor can review this repair.</span>') : '';
    const findingPanel = state.team&&FP.ops.sources(record).length ? FP.fieldUI.sourcePanel(state,record) : `<section class="surface">${pane(finding ? 'Inspection finding' : 'Work description','',finding ? link(record.inspectionId,'inspections/run/'+record.inspectionId):'')}
      <div class="section-body"><p class="body-copy" ${record.description?'translate="no"':''}>${esc(record.description||'No description recorded.')}</p>${finding ? `<small class="hint">Recorded ${stamp(finding.at)}</small>${files(state,finding.photos)}`:''}</div></section>`;
    const repairPanel = record.repairs.length ? `<section class="surface">${pane('Submitted repairs')}${record.repairs.slice().reverse().map((repair,index)=>`<div class="section-body repair"><strong>Repair attempt ${record.repairs.length-index}</strong><small>${stamp(repair.at)} · ${esc(person(state,repair.actorId))}</small><p class="body-copy" translate="no">${esc(repair.notes)}</p>${files(state,repair.photos)}</div>`).join('')}</section>`:'';
    const compareEvidence = (finding||FP.ops?.sources(record).length) && repairPanel && !inProgress;
    return `<div class="work-detail"><section class="surface">${pane(record.title,record.id,tag(queued?'Queued':record.status))}
      <div class="section-body"><div class="facts"><div><small>Equipment</small>${link(machine.name,'assets/item/'+machine.id)}<span>${esc(location(state,machine))}</span></div>
        <div><small>Assignee</small><strong>${esc(person(state,record.assigneeId))}</strong></div>
        <div><small>Priority</small>${tag(record.priority)}</div><div><small>Due date</small><strong class="${isOverdue(record,FP.workspaceDay(state)) ? 'late':''}">${date(record.due)}</strong></div>
        ${record.respondBy?`<div><small>Response target</small><strong class="${FP.ops.responseLate(record)?'late':''}">${stamp(record.respondBy)}</strong>${FP.ops.responseLate(record)?'<span class="late">Response overdue</span>':''}</div>`:''}</div>
        <div class="actions detail-actions">${open(record)&&(!state.team||manager)?btn('Edit assignment','assign',{id:record.id,symbol:'edit'}):''}${btn('Download PDF','pdf',{id:record.id,symbol:'download',attrs:'data-kind="work"'})}${phase}</div></div></section>
      ${compareEvidence ? `<div class="evidence-grid">${findingPanel}${repairPanel}</div>` : findingPanel}
      ${inProgress ? `<section class="surface">${pane('Repair evidence','Record what changed and attach completion photos.')}
        <div class="section-body"><label class="field">Repair notes<textarea rows="3" maxlength="4000" data-draft ${data} placeholder="Describe the repair and the operating check.">${esc(record.draft.notes)}</textarea></label>
        <div class="evidence-tools">${addPhoto(data)}<small id="draft-state">Changes save to this device</small></div>${files(state,record.draft.photos,data)}
        <div class="actions detail-actions">${btn('Request verification','request-review',{id:record.id,symbol:'check',style:'primary'})}</div></div></section>`:''}
      ${compareEvidence ? '' : repairPanel}
      <section class="surface">${pane('Activity history')}${timeline(state,record.history)}</section></div>`;
  }
  function sitesTree(state,selected='',parent='') {
    return state.places.filter(item=>item.parentId===parent).map(item=>`<div class="tree-node"><a class="${selected===item.id?'selected':''}" href="#assets/place/${esc(item.id)}">${icon(item.kind==='Area'?'pin':'building',16)}<span>${esc(item.name)}</span></a><div>${sitesTree(state,selected,item.id)}</div></div>`).join('');
  }
  function assetsPage(state,route,filters) {
    const manager=!state.team||FP.team.manages(find(state.people,state.activeId).role);
    const detail=route[1]==='item' ? asset(state,route[2]):null;
    const place=route[1]==='place' ? find(state.places,route[2]):null;
    if ((route[1]==='item'&&!detail)||(route[1]==='place'&&!place)) return missing('Equipment record','assets');
    const records=state.assets.filter(item=>(!place||FP.chain(state,item.areaId).some(p=>p.id===place.id)) &&
      matches(filters.assetQuery,item.name,item.tag,item.type,location(state,item)));
    const controls=manager?btn('Add location','place',{symbol:'plus',attrs:place ? `data-parent="${esc(place.id)}"`:''})+btn('Add asset','asset',{symbol:'plus',style:'primary',attrs:place?.kind==='Area'?`data-parent="${esc(place.id)}"`:''}):'';
    if (detail) {
      const inspections=state.inspections.filter(item=>item.assetId===detail.id).sort((a,b)=>b.due.localeCompare(a.due));
      const work=state.work.filter(item=>item.assetId===detail.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      const outstanding=work.filter(open);
      return title(detail.name,location(state,detail),manager?btn('Edit asset','asset',{id:detail.id,symbol:'edit'})+
        btn('New inspection','new-inspection',{symbol:'plus',style:'primary',attrs:`data-asset="${esc(detail.id)}"`}):'',link('Sites & Assets','assets',{style:'back-link',symbol:'back'}))+
        `<section class="surface asset-summary">${pane('Equipment record',detail.tag,tag(detail.status))}<div class="section-body"><div class="facts">
        ${[['Equipment type',detail.type],['Manufacturer',detail.manufacturer],['Model',detail.model],['Serial number',detail.serial],
          ['Open work orders',outstanding.length]].map(([label,value])=>`<div><small>${label}</small><strong>${esc(value||value===0?value:'—')}</strong></div>`).join('')}</div>
        ${detail.notes?`<p class="body-copy">${esc(detail.notes)}</p>`:''}</div></section>
        ${state.team?FP.fieldUI.trends(inspections,state.timeZone):''}<section class="surface stack">${pane('Inspection history')}${table(['Inspection','Due date','Status'],inspections.map(item=>[cell(link(item.title,'inspections/run/'+item.id),item.id),date(item.due),tag(item.status)]),'No inspections for this asset.')}</section>
        <section class="surface stack">${pane('Work order history','',manager?btn('New work order','new-work',{symbol:'plus',attrs:`data-asset="${esc(detail.id)}"`}):'')}${workRows(state,work)}</section>
        ${detail.changes.length?`<section class="surface stack">${pane('Equipment changes')}${timeline(state,detail.changes)}</section>`:''}`;
    }
    return title('Sites & Assets','Manage property locations and view linked equipment history.',controls)+
      `<div class="site-split"><aside class="surface site-tree">${pane('Locations','',manager?btn('Add','place',{symbol:'plus'}):'')}<nav aria-label="Locations"><a class="all-equipment ${place?'':'selected'}" href="#assets">${icon('layers',16)} All equipment</a>${sitesTree(state,place?.id)}</nav></aside>
      <section class="surface">${pane(place?.name||'Equipment register',place?.notes||records.length+' assets',place&&manager ? btn('Edit location','place',{id:place.id,symbol:'edit'}):'')}
      ${toolbar(search(filters.assetQuery,'Search equipment','assetQuery'))}${table(['Equipment','Location','Status','Open work'],records.map(item=>[
        cell(link(item.name,'assets/item/'+item.id),item.tag+' · '+item.type),esc(location(state,item)),tag(item.status),
        state.work.filter(order=>order.assetId===item.id&&open(order)).length
      ]),'No equipment in this location.')}</section></div>`;
  }
  function settings(state) {
    return title('Settings',state.team?'Manage team access, workspace defaults, and backups.':'Manage this device’s workspace, profiles, and backups.')+
      `<div class="settings-grid"><section class="surface">${pane('Workspace','Defaults for new corrective actions.')}`
      + `<form class="section-body form-grid" data-form="settings"><label class="field wide">Workspace name<input name="workspace" required maxlength="100" value="${esc(state.workspace)}"></label>
      <label class="field">Default repair assignee<select name="defaultAssignee">${opts([['','Unassigned'],...state.people.filter(p=>p.available!==false||state.settings.defaultAssignee===p.id).map(p=>[p.id,p.name+(p.available===false?' · Inactive':'')])],state.settings.defaultAssignee)}</select></label>
      <label class="field">Days until corrective action is due<input type="number" min="0" max="365" required name="correctiveDays" value="${state.settings.correctiveDays}"></label>
      ${state.team?`<div class="wide"><strong>Response targets (hours)</strong><p class="hint">Time from creation to starting work. Repair due dates are tracked separately.</p></div>
       ${FP.priorities.map(priority=>`<label class="field">${priority}<input type="number" name="target-${priority}" min="1" max="8760" required value="${FP.ops.responseHours(state,priority)}"></label>`).join('')}`:''}
      <div class="actions wide"><button class="btn primary" type="submit">Save settings</button></div></form></section>
      <section class="surface">${pane('Data & offline',state.team?'Manage shared workspace records and evidence.':'Records and photos are stored in this browser profile.')}`
      + `<div class="section-body"><p class="body-copy">${state.team?'Export a backup before replacing work records or transferring this workspace.':'Export a backup before clearing browser data, switching devices, or moving between the hosted and downloaded app.'}</p><div class="settings-buttons">
      ${btn('Export backup','backup',{symbol:'download',style:'primary'})}${btn('Restore backup','restore',{symbol:'upload'})}${state.team?btn('Synchronization','sync-status',{symbol:'repeat'}):btn('Protect browser storage','persist',{symbol:'computer'})+btn('Start a blank workspace','reset',{symbol:'plus'})}</div>
      <p class="hint">Backups include photographs and notes. Store them somewhere private.</p></div></section></div>`+
      (state.team ? `<section class="surface stack">${pane('Team','Invite members, change access, and review account and workspace activity.')}
      <div class="section-body actions detail-actions">${btn('Team members','members',{symbol:'plus',style:'primary'})}${btn('Audit history','audit',{symbol:'file'})}</div></section>`:
      `<section class="surface stack">${pane('Local profiles','Switch profiles to record who inspected, repaired, or verified work on this device.',btn('Add profile','person',{symbol:'plus'}))}
      ${table(['Name','Role','Active profile',''],state.people.map(item=>[esc(item.name),esc(item.role),item.id===state.activeId?tag('Active'):'',btn('Edit','person',{id:item.id,symbol:'edit'})]))}</section>`);
  }
  FP.UI={esc,icon,date,stamp,tag,btn,link,opts,person,asset,title,pane,empty,files,table,layout,dashboard,inspections,workPage,assetsPage,settings};
})();

(() => {
  const {esc,icon,tag,stamp,btn,link,title,pane,empty,files,table}=FP.UI;
  const {find}=FP;
  const readingRange=q=>(q.min==null?'≤ '+q.max:q.max==null?'≥ '+q.min:q.min+' – '+q.max)+' '+q.unit;
  const num=value=>new Intl.NumberFormat(FP.i18n.locale(),{maximumSignificantDigits:15}).format(value);
  const displayReading=(q,result)=>typeof result.reading==='number'?num(result.reading)+' '+q.unit:'—';
  function measurement(q,result,data,editable) {
    const input=editable ? `<label class="field numeric-field">Measurement<input type="number" inputmode="decimal" step="any" value="${result.reading??''}" data-draft data-field="reading" ${data}></label>` :
      `<strong translate="no">${esc(displayReading(q,result))}</strong>`;
    return `<div class="numeric-row">${input}<div><small>Acceptable range</small><strong translate="no">${esc(readingRange(q))}</strong></div>
      ${editable?`<span class="numeric-outcome">${tag(result.value||'Unanswered')}</span>`:''}</div>`;
  }
  function sourcePanel(state,record) {
    const sources=FP.ops.sources(record);
    return `<section class="surface">${pane(sources.length===1&&sources[0].kind==='inspection'?'Inspection finding':'Linked findings and fault reports',
      sources.length+' evidence sources')}${sources.map(source=>{
      if (source.kind==='report') {
        const fault=find(state.faults||[],source.reportId);
        if (!fault) return '';
        return `<article class="section-body source-record"><strong>Fault report</strong> ${link(fault.title,'faults/'+fault.id)}
          <p class="hint"><span translate="no">${esc(stamp(fault.createdAt))}</span> · <span translate="no">${esc(FP.UI.person(state,fault.reporterId))}</span></p>
          <p class="body-copy" translate="no">${esc(fault.notes)}</p>${files(state,fault.photos)}</article>`;
      }
      const inspection=find(state.inspections,source.inspectionId);
      const result=inspection?.results[source.questionId];
      if (!result) return '';
      const question=find(inspection.questions,source.questionId);
      return `<article class="section-body source-record"><strong>Inspection</strong> ${link(inspection.id,'inspections/run/'+inspection.id)}
        <p translate="no">${esc(question?.label)}</p><p class="hint">Recorded ${stamp(result.at)}</p>
        ${FP.ops.isReading(question)?measurement(question,result,'',false):''}
        <p class="body-copy" translate="no">${esc(result.notes)}</p>${files(state,result.photos)}</article>`;
    }).join('')}</section>`;
  }
  function trends(records,timeZone) {
    const groups=new Map();
    for (const record of records.filter(record=>record.status==='Completed')) for (const q of record.questions.filter(FP.ops.isReading)) {
      const result=record.results[q.id];
      if (typeof result.reading!=='number') continue;
      const key=record.templateId+'/'+q.id+'/'+q.unit;
      if (!groups.has(key)) groups.set(key,{q,points:[]});
      groups.get(key).points.push({record,q,result,value:result.reading});
    }
    if (!groups.size) return '';
    return `<section class="surface stack">${pane('Measurement trends','Latest 20 completed readings per check and unit.')}${[...groups.values()].map(({q,points})=>{
      const sorted=points.sort((a,b)=>a.record.submittedAt.localeCompare(b.record.submittedAt)).slice(-20);
      const min=Math.min(...sorted.map(point=>point.value));
      const max=Math.max(...sorted.map(point=>point.value));
      const day=point=>FP.zonedDay(new Date(point.record.submittedAt),timeZone);
      const firstDay=day(sorted[0]), lastDay=day(sorted.at(-1));
      const y=value=>max===min?45:76-61*(value-min)/(max-min);
      const x=index=>sorted.length===1?250:61+(381*index/(sorted.length-1));
      const chart=`<svg class="reading-trend" viewBox="0 0 456 98" role="img" aria-label="Measurement trend">
        <path d="M61 15H442 M61 45H442 M61 76H442" fill="none" stroke="#dce5f0"/>
        <g font-size="10" fill="#546780">${[...new Set([max,min])].map(value=>`<text x="53" y="${y(value)+3}" text-anchor="end">${esc(num(value))}</text>`).join('')}
          <text x="61" y="91">${esc(FP.UI.date(firstDay))}</text>
          ${firstDay!==lastDay?`<text x="442" y="91" text-anchor="end">${esc(FP.UI.date(lastDay))}</text>`:''}</g>
        <polyline points="${sorted.map((point,i)=>x(i)+','+y(point.value)).join(' ')}" fill="none" stroke="#195cbb" stroke-width="2.5"/>
        ${sorted.map((point,i)=>`<circle cx="${x(i)}" cy="${y(point.value)}" r="4.5" fill="${point.result.value==='Fail'?'#b53042':'#195cbb'}"><title>${esc(stamp(point.record.submittedAt)+' · '+displayReading(point.q,point.result))}</title></circle>`).join('')}</svg>`;
      return `<div class="section-body trend-item"><div class="trend-title"><strong translate="no">${esc(q.label)}</strong><span translate="no">${esc(q.unit)}</span></div>${chart}
        <details><summary>View readings</summary>${table(['Inspection','Recorded','Measurement','Acceptable range','Result'],sorted.slice().reverse().map(item=>[
          link(item.record.id,'inspections/run/'+item.record.id),esc(stamp(item.result.at)),esc(displayReading(item.q,item.result)),esc(readingRange(item.q)),tag(item.result.value)
        ]))}</details></div>`;
    }).join('')}</section>`;
  }
  const equipment=(state,id)=>find(state.assets,id)||find(state.equipmentDirectory||[],id);
  function faults(state,id) {
    const manager=FP.team.manages(find(state.people,state.activeId).role);
    if (!id) {
      const items=(state.faults||[]).filter(item=>manager||item.reporterId===state.activeId).sort((a,b)=>Number(a.status!=='Reported')-Number(b.status!=='Reported')||b.createdAt.localeCompare(a.createdAt));
      return title('Fault reports','Report unexpected equipment problems and track the review.',btn('Report a fault','new-fault',{style:'primary',symbol:'plus'}))+
        `<section class="surface">${pane(manager?'Review queue':'My fault reports')}${table(['Fault','Equipment','Priority','Reported','Status'],items.map(item=>[
          link(item.title,'faults/'+item.id),esc(equipment(state,item.assetId)?.name),tag(item.priority),esc(stamp(item.createdAt)),tag(item.status)
        ]),'No fault reports yet.')}</section>`;
    }
    const fault=find(state.faults||[],id);
    if (!fault) return title('Fault report unavailable','',link('Back to fault reports','faults',{style:'btn'}))+empty('Record not found');
    const order=find(state.work,fault.workId);
    const machine=equipment(state,fault.assetId);
    const actions=manager&&fault.status==='Reported'&&!fault.localOnly ?
      btn('Decline','review-fault',{id,value:'decline',attrs:'data-value="decline"'})+btn('Assign corrective action','review-fault',{id,style:'primary',attrs:'data-value="approve"'}):'';
    return title(fault.title,'',actions,link('Fault reports','faults',{style:'back-link',symbol:'back'}))+
      `<section class="surface">${pane('Reported fault','',tag(fault.localOnly?'Queued':fault.status))}
        <div class="section-body"><div class="facts"><div><small>Equipment</small>${find(state.assets,machine?.id)?link(machine.name,'assets/item/'+machine.id):esc(machine?.name)}</div>
        <div><small>Reported by</small><strong translate="no">${esc(FP.UI.person(state,fault.reporterId))}</strong></div>
        <div><small>Reported</small><strong>${stamp(fault.createdAt)}</strong></div><div><small>Priority</small>${tag(fault.priority)}</div></div>
        <p class="body-copy" translate="no">${esc(fault.notes)}</p>${files(state,fault.photos)}
        ${fault.reviewedAt?`<p class="hint stack">Reviewed ${stamp(fault.reviewedAt)} · ${esc(FP.UI.person(state,fault.reviewedBy))}</p>`:''}
        ${fault.reviewNote?`<p class="body-copy" translate="no">${esc(fault.reviewNote)}</p>`:''}
        ${fault.workId?`<div class="linked-record"><strong>Corrective action</strong> ${order?link(fault.workId,'work/'+fault.workId):esc(fault.workId)}</div>`:''}
        </div></section>`;
  }
  function inbox(state) {
    const values=state.notices||[];
    return values.length ? `<div class="member-list">${values.map(message=>`<div class="member-row notice-row"><div>
      <strong>${esc(message.kind)}${message.read?'':' <span class="notice-dot" aria-label="Unread"></span>'}</strong><small>${esc(message.title)}</small>
      <small>${stamp(message.at)}</small></div>${btn('View record','notice-open',{id:message.id,symbol:'chevron'})}</div>`).join('')}</div>` :
      empty('No notifications yet','Assignments, review requests, and overdue tasks will appear here.','bell');
  }
  FP.fieldUI={measurement,readingRange,sourcePanel,trends,faults,inbox};
})();

(() => {
  const encoder=new TextEncoder();
  const hex=(number,width=4)=>number.toString(16).padStart(width,'0');
  const utf16=text=>Array.from({length:text.length},(_,index)=>hex(text.charCodeAt(index))).join('');
  let loaded;
  async function load() {
    const response=await fetch('/fonts/NotoSansSC-Regular.ttf');
    if (!response.ok) throw new Error('The PDF font is unavailable. Connect to download it and try again.');
    const bytes=await response.arrayBuffer();
    const view=new DataView(bytes);
    const u16=offset=>view.getUint16(offset);
    const i16=offset=>view.getInt16(offset);
    const u32=offset=>view.getUint32(offset);
    const table={};
    const decoder=new TextDecoder();
    for (let index=0;index<u16(4);index++) {
      const p=12+16*index;
      table[decoder.decode(new Uint8Array(bytes,p,4))]=u32(p+8);
    }
    const head=table.head, hhea=table.hhea;
    const unit=u16(head+18);
    const scale=value=>Math.round(value*1000/unit);
    const widths=Math.max(1,u16(hhea+34));
    const scalars=[];
    for (let n=0;n<u16(table.cmap+2);n++) {
      const pos=table.cmap+4+n*8;
      const offset=table.cmap+u32(pos+4);
      if (u16(offset)===12) scalars.push(offset);
    }
    const cmap=scalars[0];
    if (cmap===undefined) throw new Error('The PDF font does not contain a Unicode character map.');
    function glyph(code) {
      let low=0,high=u32(cmap+12)-1;
      while (low<=high) {
        const middle=(low+high)>>>1;
        const entry=cmap+16+12*middle;
        if (code<u32(entry)) high=middle-1;
        else if (code>u32(entry+4)) low=middle+1;
        else return u32(entry+8)+code-u32(entry);
      }
      return 0;
    }
    const advance=char=>scale(u16(table.hmtx+4*Math.min(widths-1,glyph(char.codePointAt(0)))));
    const font=typeof CompressionStream==='function' ?
      new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer()) : new Uint8Array(bytes);
    return {glyph,advance,font,length:bytes.byteLength,compressed:typeof CompressionStream==='function',
      bbox:[36,38,40,42].map(offset=>scale(i16(head+offset))),ascent:scale(i16(hhea+4)),descent:scale(i16(hhea+6))};
  }
  async function face() {
    const data=await (loaded ||= load().catch(error=>{loaded=null;throw error;}));
    const chars=new Map();
    function encode(value) {
      let out='';
      for (const char of value) {
        if (!chars.has(char)) chars.set(char,chars.size+1);
        out+=hex(chars.get(char));
      }
      return '<'+out+'>';
    }
    function embed(put,fontObject) {
      const stream=(body,extra='')=>{
        const bytes=typeof body==='string'?encoder.encode(body):body;
        return put('<< /Length '+bytes.length+' '+extra+' >>\nstream\n',bytes,'\nendstream');
      };
      const program=stream(data.font,'/Length1 '+data.length+(data.compressed?' /Filter /FlateDecode':''));
      const descriptor=put(`<< /Type /FontDescriptor /FontName /NotoSansSC-Regular /Flags 4 /FontBBox [${data.bbox.join(' ')}]
        /ItalicAngle 0 /Ascent ${data.ascent} /Descent ${data.descent} /CapHeight 733 /StemV 85 /FontFile2 ${program} 0 R >>`);
      const entries=[...chars.keys()];
      const mapping=new Uint8Array((entries.length+1)*2);
      const mappingView=new DataView(mapping.buffer);
      entries.forEach((char,index)=>mappingView.setUint16((index+1)*2,data.glyph(char.codePointAt(0))));
      const map=stream(mapping);
      const cid=put(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /NotoSansSC-Regular
        /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>
        /FontDescriptor ${descriptor} 0 R /DW 1000 /W [1 [${entries.map(data.advance).join(' ')}]] /CIDToGIDMap ${map} 0 R >>`);
      const blocks=[];
      for (let index=0;index<entries.length;index+=90) {
        const lines=entries.slice(index,index+90).map((char,position)=>'<'+hex(index+position+1)+'> <'+utf16(char)+'>');
        blocks.push(lines.length+' beginbfchar\n'+lines.join('\n')+'\nendbfchar');
      }
      const unicode=stream('/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /FieldProofUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n'+
        blocks.join('\n')+'\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n');
      fontObject(`<< /Type /Font /Subtype /Type0 /BaseFont /NotoSansSC-Regular /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${unicode} 0 R >>`);
    }
    return {encode,embed,measure:(text,size)=>[...text].reduce((total,char)=>total+data.advance(char),0)*size/1000};
  }
  FP.pdfUnicode=face;
})();

(() => {
  const {find,location} = FP;
  const {person} = FP.UI;
  const encoder = new TextEncoder();
  const width = 595.28, height = 841.89, margin = 46;
  const bodyWidth = width - 2 * margin;
  const alternate = {'–':'-','—':'-','’':"'",'‘':"'",'“':'"','”':'"','…':'...','→':'->'};
  const latin = value => String(value ?? '').replace(/[–—’‘“”…→]/g,char=>alternate[char]).replace(/[^\x0a\x20-\x7e\xa0-\xff]/gu,'?');
  const literal = text => latin(text).replace(/[\\()]/g,char=>'\\'+char)
    .replace(/[\xa0-\xff]/g,char=>'\\'+char.charCodeAt(0).toString(8).padStart(3,'0'));
  const estimate = (text,size) => [...text].reduce((total,char)=>total+(/[ il.,'!:I]/.test(char)?.27:/[MW@%]/.test(char)?.83:/[A-Z0-9]/.test(char)?.62:.53)*size,0);
  function wrap(value,size,available,measure=estimate,clean=latin) {
    return clean(value).split('\n').flatMap(paragraph=>{
      const lines=[];
      let line='';
      for (const token of paragraph.split(/\s+/).filter(Boolean)) {
        if (line && measure(line+' '+token,size)>available) { lines.push(line); line=''; }
        if (measure(token,size)>available) {
          for (const char of token) {
            if (measure(line+char,size)>available) { lines.push(line); line=''; }
            line+=char;
          }
        } else line += (line?' ':'')+token;
      }
      lines.push(line);
      return lines;
    });
  }
  function writer(recordId,workspace,unicode,translate,stamp) {
    const objects = [];
    const pages = [];
    const imageObjects = new Map();
    const put = (...parts) => objects.push(parts);
    const catalog = put('');
    const tree = put('');
    const normal = put(unicode?'':'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const bold = unicode?normal:put('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const clean=unicode?value=>String(value??'').replace(/\r/g,''):latin;
    const measure=unicode?.measure||estimate;
    let page, y;
    const command = text => page.commands.push(text);
    const textAt = (text,x,top,size=10,strong=false,color='0.15 0.22 0.32') => {
      const code=unicode?unicode.encode(text):'('+literal(text)+')';
      const mode=unicode&&strong?'2 Tr':'0 Tr';
      command(`q 0.22 w ${color} RG BT /${strong?'F2':'F1'} ${size} Tf ${color} rg ${mode} 1 0 0 1 ${x.toFixed(2)} ${(height-top).toFixed(2)} Tm ${code} Tj ET Q`);
    };
    function line(top,color='0.85 0.89 0.94') {
      command(`${color} RG 0.7 w ${margin} ${height-top} m ${width-margin} ${height-top} l S`);
    }
    function newPage() {
      page={commands:[],images:new Map()};
      pages.push(page);
      command(`0.05 0.12 0.23 rg 0 ${height-9} ${width} 9 re f`);
      textAt('FieldProof',margin,40,15,true,'0.07 0.27 0.56');
      textAt(recordId,452,39,10,true);
      textAt(wrap(workspace,9,bodyWidth,measure,clean)[0],margin,57,9);
      line(67);
      y=90;
    }
    const room = amount => { if (y+amount>774) newPage(); };
    function paragraph(value,{size=10,strong=false,color,after=8}={}) {
      const gap=size*1.43;
      for (const row of wrap(value,size,bodyWidth-4,measure,clean)) {
        room(gap);
        textAt(row,margin,y,size,strong,color);
        y+=gap;
      }
      y+=after;
    }
    function section(label) {
      room(62);
      y+=15;
      line(y-13);
      paragraph(translate(label),{size:12,strong:true,color:'0.07 0.27 0.56',after:5});
    }
    function pair(label,value) { paragraph(translate(label)+': '+(value===0?0:value||'—'),{after:2}); }
    function image(photo) {
      const pictureWidth=Math.min(bodyWidth-4,320,240*photo.w/photo.h);
      const pictureHeight=pictureWidth*photo.h/photo.w;
      room(pictureHeight+50);
      if (!imageObjects.has(photo.id)) {
        const bytes=Uint8Array.from(atob(photo.src.split(',')[1]),char=>char.charCodeAt(0));
        const ref=put(`<< /Type /XObject /Subtype /Image /Width ${photo.w} /Height ${photo.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`,bytes,'\nendstream');
        imageObjects.set(photo.id,{ref,name:'Im'+(imageObjects.size+1)});
      }
      const {ref,name}=imageObjects.get(photo.id);
      page.images.set(name,ref);
      command(`q ${pictureWidth.toFixed(2)} 0 0 ${pictureHeight.toFixed(2)} ${margin} ${(height-y-pictureHeight).toFixed(2)} cm /${name} Do Q`);
      y+=pictureHeight+13;
      paragraph(photo.name+' · '+translate('Attached')+' '+stamp(photo.at),{size:8,after:13});
    }
    newPage();
    function finish() {
      const references=pages.map((current,index)=>{
        page=current;
        line(793);
        textAt('FieldProof  /  '+recordId,margin,810,8);
        const footer=translate('Page '+(index+1)+' of '+pages.length);
        textAt(footer,width-margin-measure(footer,8),810,8);
        const bytes=encoder.encode(current.commands.join('\n'));
        const contents=put(`<< /Length ${bytes.length} >>\nstream\n`,bytes,'\nendstream');
        const images=[...current.images].map(([name,ref])=>`/${name} ${ref} 0 R`).join(' ');
        return put(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${normal} 0 R /F2 ${bold} 0 R >> /XObject << ${images} >> >> /Contents ${contents} 0 R >>`);
      });
      if (unicode) unicode.embed(put,value=>{objects[normal-1]=[value];});
      objects[catalog-1]=[`<< /Type /Catalog /Pages ${tree} 0 R >>`];
      objects[tree-1]=[`<< /Type /Pages /Count ${references.length} /Kids [${references.map(ref=>ref+' 0 R').join(' ')}] >>`];
      const metadata=put(`<< /Title (FieldProof ${literal(recordId)}) /Producer (FieldProof) >>`);
      const chunks=[];
      let position=0;
      const append = part => {
        const bytes=typeof part==='string'?encoder.encode(part):part;
        chunks.push(bytes);
        position+=bytes.length;
      };
      append('%PDF-1.4\n');
      append(Uint8Array.of(37,226,227,207,211,10));
      const offsets=objects.map((parts,index)=>{
        const offset=position;
        append((index+1)+' 0 obj\n');
        parts.forEach(append);
        append('\nendobj\n');
        return offset;
      });
      const xref=position;
      append(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`);
      offsets.forEach(offset=>append(String(offset).padStart(10,'0')+' 00000 n \n'));
      append(`trailer\n<< /Size ${objects.length+1} /Root ${catalog} 0 R /Info ${metadata} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
      return new Blob(chunks,{type:'application/pdf'});
    }
    return {paragraph,section,pair,image,finish};
  }
  FP.pdf = async (state,kind,id,getPhoto,language='') => {
    const inspection = kind==='inspection';
    const record=find(inspection?state.inspections:state.work,id);
    FP.check(record,'That record could not be found.');
    const asset=find(state.assets,record.assetId);
    const translate=FP.i18n?.report(language)||(value=>value);
    const unicode=state.team&&FP.pdfUnicode?await FP.pdfUnicode():null;
    const locale=language==='en'?'en-US':language==='zh'?'zh-CN':FP.i18n?.locale()||'en-US';
    const stamp=iso=>iso?new Date(iso).toLocaleString(locale,{dateStyle:'medium',timeStyle:'short'}):'—';
    const date=day=>day?FP.asDate(day).toLocaleDateString(locale,{year:'numeric',month:'short',day:'numeric'}):'—';
    const {paragraph,section,pair,image,finish}=writer(id,state.workspace,unicode,translate,stamp);
    const orderSources=order=>FP.ops?.sources(order)|| (order.inspectionId?[{kind:'inspection',inspectionId:order.inspectionId,questionId:order.questionId}]:[]);
    const outcome=value=>translate(value||'Unanswered');
    const readingDetails=(q,result)=>{
      if (q?.kind!=='measurement') return;
      if (typeof result.reading==='number') pair('Measurement',result.reading+' '+q.unit);
      pair('Acceptable range',(q.min==null?'≤ '+q.max:q.max==null?'≥ '+q.min:q.min+'–'+q.max)+' '+q.unit);
    };
    const photos = async ids => {
      for (const photoId of ids) {
        const photo=await getPhoto(photoId);
        FP.check(photo,'An attached photograph is unavailable. Restore the workspace from a backup and try again.');
        image(photo);
      }
    };
    paragraph(translate(inspection?'Inspection report':'Corrective action report'),{size:23,strong:true});
    const workTitle=order=>order.inspectionId&&order.title.startsWith('Correct: ')?translate('Corrective action')+' · '+order.title.slice(9):order.title;
    paragraph(inspection?record.title:workTitle(record),{size:14,strong:true,after:14});
    pair('Equipment',asset.name+' ('+asset.tag+')');
    pair('Location',location(state,asset));
    pair('Status',translate(record.status));
    pair('Assigned to',person(state,record.assigneeId));
    pair('Due',date(record.due));
    pair('Created',stamp(record.createdAt));
    if (inspection) {
      if (record.startedAt) pair('Started',stamp(record.startedAt));
      if (record.submittedAt) pair('Submitted',stamp(record.submittedAt)+' · '+person(state,record.submittedBy));
      section('Checklist and findings');
      for (const [index,q] of record.questions.entries()) {
        const result=record.results[q.id];
        paragraph((index+1)+'. '+q.label+' — '+outcome(result.value),{strong:true});
        if (q.criteria) pair('Pass criteria',q.criteria);
        readingDetails(q,result);
        if (result.at) pair('Recorded',stamp(result.at)+(result.recordedBy?' · '+person(state,result.recordedBy):''));
        if (result.capturedAt&&Math.abs(Date.parse(result.capturedAt)-Date.parse(result.at))>=60000) pair('Device capture',stamp(result.capturedAt));
        if (result.notes) paragraph(result.notes,{after:9});
        await photos(result.photos);
      }
      const orders=state.work.filter(work=>orderSources(work).some(source=>source.inspectionId===record.id));
      const links=(state.issueLinks||[]).filter(link=>link.inspectionId===record.id&&!find(orders,link.id));
      if (orders.length||links.length) {
        section('Linked corrective actions');
        for (const link of new Map(links.map(link=>[link.id,link])).values()) pair(link.id,(FP.i18n?.t(link.title)||link.title)+' · '+translate(link.status));
        for (const order of orders) {
          paragraph(order.id+' · '+workTitle(order)+' · '+translate(order.status),{strong:true});
          order.history.forEach(entry=>pair(stamp(entry.at),translate(entry.title)+' · '+person(state,entry.actorId)+(entry.note?' · '+entry.note:'')));
          for (const repair of order.repairs) {
            paragraph(translate('Repair')+' · '+stamp(repair.at)+' · '+person(state,repair.actorId),{strong:true});
            paragraph(repair.notes);
            await photos(repair.photos);
          }
        }
      }
    } else {
      pair('Priority',translate(record.priority));
      if (record.respondBy) pair('Response target',stamp(record.respondBy));
      if (record.respondedAt) pair('Work started',stamp(record.respondedAt));
      if (record.closedAt) pair('Closed',stamp(record.closedAt));
      const sources=orderSources(record);
      section(sources.length?'Linked findings and fault reports':'Work description');
      if (!sources.length) paragraph(record.description||translate('No description recorded.'));
      for (const item of sources) {
        if (item.kind==='report') {
          const fault=find(state.faults||[],item.reportId);
          if (!fault) continue;
          pair('Fault report',fault.title);
          pair('Reported by',person(state,fault.reporterId)+' · '+stamp(fault.createdAt));
          paragraph(fault.notes);
          if (fault.reviewNote) pair('Review notes',fault.reviewNote);
          await photos(fault.photos);
          continue;
        }
        const source=find(state.inspections,item.inspectionId);
        const result=source?.results[item.questionId];
        if (!result) continue;
        const question=find(source.questions,item.questionId);
        pair('Inspection',source.id+' · '+source.title);
        pair('Check',question?.label);
        pair('Recorded',stamp(result.at)+(result.recordedBy?' · '+person(state,result.recordedBy):''));
        if (result.capturedAt&&Math.abs(Date.parse(result.capturedAt)-Date.parse(result.at))>=60000) pair('Device capture',stamp(result.capturedAt));
        readingDetails(question,result);
        paragraph(result.notes);
        await photos(result.photos);
      }
      if (record.repairs.length) {
        section('Submitted repairs and completion evidence');
        for (const [index,repair] of record.repairs.entries()) {
          paragraph(translate('Repair attempt '+(index+1))+' · '+stamp(repair.at)+' · '+person(state,repair.actorId),{strong:true});
          paragraph(repair.notes);
          await photos(repair.photos);
        }
      }
      section('Activity and verification history');
      for (const entry of record.history) {
        paragraph(translate(entry.title),{strong:true,after:2});
        paragraph(stamp(entry.at)+' · '+person(state,entry.actorId),{size:9,after:4});
        if (entry.note) paragraph(entry.note);
      }
    }
    return finish();
  };
})();

(() => {
  const {find,localDay,shift,location,kinds,roles,intervals,assetStates,priorities} = FP;
  const {esc,icon,opts,person,btn,empty} = FP.UI;
  const teamMode = Boolean(FP.teamStorage);
  const storage = FP.teamStorage || FP.storage;
  const app = document.querySelector('#app');
  const dialog = document.querySelector('#dialog');
  const content = document.querySelector('#dialog-content');
  const toast = document.querySelector('#toast');
  const filters = {site:'',days:30,reportKind:'inspection',inspectionStatus:'',inspectionSite:'',inspectionQuery:'',
    workStatus:'',workSite:'',workQuery:'',assetQuery:'',pdfLanguage:''};
  const auditLabels={
    'workspace-setup':'Workspace created','sign-in':'Signed in','password-changed':'Password changed',
    'account-invited':'Member invited','account-updated':'Member updated','account-activated':'Member activated',
    'admin-recovery':'Administrator recovery','workspace-restore':'Workspace restored','recurring-inspection':'Recurring inspection generated',
    settings:'Workspace settings updated',place:'Location saved',asset:'Asset saved',template:'Template saved',inspection:'Inspection assigned',
    recurrence:'Recurring schedule saved',pause:'Recurring schedule status changed',reschedule:'Inspection schedule updated',
    startInspection:'Inspection started',result:'Inspection result saved',submit:'Inspection submitted',
    work:'Work order created',assign:'Assignment updated',startWork:'Work started',repairDraft:'Repair draft saved',
    requestReview:'Repair submitted for verification',reject:'Repair returned for rework',close:'Repair verified and closed',
    reportFault:'Fault reported',approveFault:'Fault report assigned',declineFault:'Fault report declined',readNotice:'Notification read'
  };
  const pending = new Map();
  const imageCache = new Map();
  let state, route, modal, busy = false, savingNotes = 0, noteTimer, toastTimer, dialogOpener, externalRevision = 0, loadedDay = '';
  let queue = Promise.resolve();
  let authMode='login', canSetup=false, authOffline=false, toastMessage='';
  const role=()=>find(state?.people||[],state?.activeId)?.role;
  const manager=()=>!teamMode||FP.team.manages(role());
  const url = () => {
    const parts = window.location.hash.slice(1).split('/');
    const fallback=manager()?['dashboard']:role()==='Maintenance'?['work']:['inspections','mine'];
    if (!manager()&&['dashboard','reports','settings'].includes(parts[0])) return fallback;
    if (teamMode&&parts[0]==='settings'&&role()!=='Admin') return fallback;
    return ['dashboard','inspections','work','assets','reports','settings',...(teamMode?['faults']:[])].includes(parts[0]) ? parts : fallback;
  };
  const go = path => { if (locationHash() !== '#' + path) window.location.hash = path; else render(); };
  const locationHash = () => window.location.hash;
  function notify(message,type = 'success') {
    clearTimeout(toastTimer);
    toastMessage=message;
    toast.textContent = FP.i18n?.t(message)||message;
    toast.dataset.type = type;
    toast.hidden = false;
    if (type !== 'error') toastTimer = setTimeout(()=>toast.hidden=true,4500);
  }
  function fail(error) {
    notify(error?.name === 'QuotaExceededError' ? 'Browser storage is full. Export a backup and free space before saving again.' :
      error?.message || 'Something interrupted the operation. Try again.','error');
  }
  function download(filename,blob) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'),{href:url,download:filename});
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  function render(keepSearch = '') {
    if (!state) return;
    if (teamMode && storage.info().expired) {
      app.innerHTML=`<main id="main" class="auth-shell"><section class="auth-card surface"><div class="auth-brand"><span>${icon('logo',24)}</span>FieldProof</div>
        <h1>Sign in to continue</h1><p>Your saved changes can sync after you sign in again with the same account.</p>
        <div class="row-actions stack">${btn('Sign in','reauth',{style:'primary'})}${FP.i18n?.switcher()||''}</div></section></main>`;
      FP.i18n?.apply(app);
      return;
    }
    route = url();
    const ui = FP.UI;
    const pages = {
      dashboard:()=>ui.dashboard(state,filters), inspections:()=>ui.inspections(state,route,filters),
      work:()=>ui.workPage(state,route,filters), assets:()=>ui.assetsPage(state,route,filters),
      reports:()=>ui.dashboard(state,filters,true), settings:()=>ui.settings(state),faults:()=>FP.fieldUI.faults(state,route[1])
    };
    const focused = document.activeElement;
    const focusKey = focused?.dataset.action;
    const focusValue = focused?.dataset.value;
    const focusQuestion = focused?.dataset.question;
    const focusId = focused?.dataset.id;
    app.innerHTML = ui.layout(state,route,pages[route[0]]());
    for (const entry of pending.values()) {
      const field = [...app.querySelectorAll('[data-draft]')].find(el=>key(el.dataset)===key(entry));
      if (field) field.value=entry.patch.reading??entry.patch.notes??'';
    }
    FP.i18n?.apply(app);
    if (keepSearch) {
      const field = app.querySelector('[data-search="'+keepSearch+'"]');
      field?.focus({preventScroll:true});
      field?.setSelectionRange(field.value.length,field.value.length);
    } else if (focusKey && !dialog.open) {
      const control = [...app.querySelectorAll('[data-action]')].find(el=>el.dataset.action===focusKey &&
        el.dataset.value===focusValue && el.dataset.question===focusQuestion && el.dataset.id===focusId);
      control?.focus({preventScroll:true});
    }
    for (const img of app.querySelectorAll('img[data-photo]')) {
      photograph(img.dataset.photo).then(photo=>{
        if (img.isConnected && photo) img.src = photo.src;
        if (img.isConnected && !photo) {
          img.alt=FP.i18n?.t('Photograph unavailable offline')||'Photograph unavailable offline';
          imageCache.delete(img.dataset.photo);
        }
      }).catch(fail);
    }
  }
  function photograph(id) {
    if (!imageCache.has(id)) {
      if (imageCache.size >= 24) imageCache.delete(imageCache.keys().next().value);
      const promise = storage.photo(id).catch(error=>{
        imageCache.delete(id);
        throw error;
      });
      imageCache.set(id,promise);
    }
    return imageCache.get(id);
  }
  function commit(action, snapshot=state) {
    const actorId = action.actorId || state.activeId;
    const workspaceKey = action.workspaceKey || snapshot.workspaceKey;
    const guard=teamMode?(action.basis??FP.team.basis(snapshot,action)):undefined;
    const job = queue.then(()=>storage.mutate({...action,actorId,workspaceKey,basis:guard})).then(saved=>{
      state = saved.state;
      if (action.fields?.removePhoto) imageCache.delete(action.fields.removePhoto);
      updateSyncLabels();
      return saved.queued ? {queued:true} : saved.result;
    });
    queue = job.catch(()=>{});
    return job;
  }
  const key = data => [data.kind,data.id,data.question||'',data.field||'notes'].join('/');
  const draftAction = (data,fields) => ({type:data.kind==='work'?'repairDraft':'result',id:data.id,
    questionId:data.question,actorId:data.actorId,workspaceKey:data.workspaceKey,basis:data.basis,fields});
  async function flush() {
    clearTimeout(noteTimer);
    const entries = [...pending.entries()];
    for (const [id,entry] of entries) {
      if (pending.get(id) !== entry) continue;
      pending.delete(id);
      savingNotes++;
      try { await commit({...draftAction(entry,entry.patch),background:teamMode}); }
      catch (error) { if (!pending.has(id)) pending.set(id,entry); throw error; }
      finally { savingNotes--; }
    }
    const label = document.querySelector('#draft-state');
    if (label && entries.length) label.textContent = FP.i18n?.t('Draft saved') || (teamMode ? 'Draft saved' : 'Draft saved on this device');
  }
  const field = (name,label,value='',settings={}) => {
    const {type='text',required=false,max=180,min='',wide=false,placeholder='',readonly=false} = settings;
    const attrs = `name="${name}" ${required?'required':''} ${readonly?'readonly':''} maxlength="${max}" placeholder="${esc(placeholder)}"`;
    return `<label class="field ${wide?'wide':''}">${esc(label)}${type==='textarea' ?
      `<textarea ${attrs} rows="3">${esc(value)}</textarea>` : `<input ${attrs} type="${type}" value="${esc(value)}"${type==='number'?' step="any"':''}${min?` min="${esc(min)}"`:''}>`}</label>`;
  };
  const pick = (name,label,options,value='',settings={}) =>
    `<label class="field ${settings.wide?'wide':''}">${esc(label)}<select name="${name}"${settings.required?' required':''}>${opts(options,value)}</select></label>`;
  const selectPerson = (label,selected,optional=false,preferred='') => {
    const ordered = state.people.filter(p=>!teamMode||p.id===selected||(p.available!==false&&(preferred!=='Inspector'||p.role!=='Maintenance')))
      .sort((a,b)=>Number(b.role===preferred)-Number(a.role===preferred));
    return pick('assigneeId',label,[['',optional?'Unassigned':'Select a profile'],...ordered.map(p=>[p.id,p.name+' · '+p.role])],selected,{required:!optional});
  };
  const selectAsset = (selected,retired=false) => pick('assetId','Equipment',[['','Select equipment'],...state.assets
    .filter(item=>retired||item.status!=='Retired'||item.id===selected).map(item=>[item.id,item.name+' · '+item.tag])],selected,{required:true,wide:true});
  const selectTemplate = selected => pick('templateId','Inspection template',[['','Select a template'],...state.templates
    .filter(item=>!item.archived||item.id===selected).map(item=>[item.id,item.name])],selected,{required:true,wide:true});
  const areaChoices = () => state.places.filter(item=>item.kind==='Area').map(item=>[item.id,FP.chain(state,item.id).map(p=>p.name).join(' / ')]);
  const prerequisites = () => !state.assets.some(item=>item.status!=='Retired') ?
    `<p class="inline-info">Add an active equipment record in ${FP.UI.link('Sites & Assets','assets')} before scheduling an inspection.</p>` :
    !state.templates.some(item=>!item.archived) ? `<p class="inline-info">Create an active ${FP.UI.link('inspection template','inspections/templates')} before scheduling an inspection.</p>` : '';
  function show(name,body,{form='',id='',submit='Save',danger=false}={}) {
    if (!dialog.open) dialogOpener = document.activeElement;
    modal={form,id,snapshot:state};
    content.innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${esc(name)}</h2>${btn('Close','cancel',{symbol:'x',style:'icon-only',attrs:'aria-label="Close dialog"'})}</div>` +
      (form ? `<form class="dialog-form" data-form="${form}" data-id="${esc(id)}"><div class="form-grid">${body}</div>
      <p class="form-error" role="alert" hidden></p><div class="dialog-foot">${btn('Cancel','cancel')}<button class="btn ${danger?'danger':'primary'}" type="submit">${esc(submit)}</button></div></form>` :
        `<div class="dialog-body">${body}</div>`);
    FP.i18n?.apply(content);
    if (!dialog.open) dialog.showModal();
  }
  function closeDialog() { if (dialog.open) dialog.close(); }
  dialog.addEventListener('close',()=>{ modal=null; dialogOpener?.focus?.({preventScroll:true}); });
  const requireSetup = (title,body) => show(title,body);
  function renderAuth(message='') {
    const invite=authMode==='activate', setup=authMode==='setup';
    const heading=setup?'Set up your workspace':invite?'Activate your account':'Sign in to FieldProof';
    const password=`<label class="field wide">Password<input type="password" name="password" required maxlength="128" ${setup||invite?'minlength="12" autocomplete="new-password"':'autocomplete="current-password"'}></label>`;
    app.innerHTML=`<main id="main" class="auth-shell"><div class="auth-card surface"><a class="auth-brand" href="/"><span>${icon('logo',24)}</span>FieldProof</a>
      <h1>${heading}</h1><p>${authOffline?'Connect to the server to sign in.':setup?'Create the first administrator account.':invite?'Use the activation code from your administrator.':'Use your work email and password.'}</p>
      <form class="form-grid" data-form="team-auth">
      ${setup?field('workspace','Workspace name','',{required:true,wide:true,max:100})+field('name','Full name','',{required:true,wide:true,max:100}):''}
      ${field('email','Email address','',{type:'email',required:true,wide:true,max:254})}
      ${setup||invite?field('code',setup?'Server setup code':'Activation code','',{required:true,wide:true,max:128}):''}
      ${password}
      <label class="checkbox wide"><input type="checkbox" name="trusted"> Prepare this trusted device for offline work</label>
      <p class="form-error wide" role="alert"${message?'':' hidden'}>${esc(message)}</p><button class="btn primary wide" type="submit">${setup?'Create workspace':invite?'Activate account':'Sign in'}</button></form>
      <div class="actions auth-links">${FP.i18n?.switcher()||''}${setup||invite?btn('Back to sign in','auth-view',{style:'subtle',attrs:'data-value="login"'}):
        canSetup?btn('First-time setup','auth-view',{style:'subtle',attrs:'data-value="setup"'}):btn('Activate an account','auth-view',{style:'subtle',attrs:'data-value="activate"'})}</div>
      </div></main>`;
    FP.i18n?.apply(app);
  }
  function updateSyncLabels() {
    if (!teamMode) return;
    const sync=storage.info();
    const label=FP.i18n?.t(storage.label())||storage.label();
    const button=app.querySelector('button.sync-button');
    if (button) {
      button.lastChild.textContent=label;
      button.classList.toggle('attention',!!sync.issue);
    }
    const sidebar=app.querySelector('.local span');
    if (sidebar) sidebar.lastChild.textContent=label;
  }
  function showSync() {
    const status=storage.info();
    const line=status.issue ? status.issue.message : status.expired ? 'Sign in to send changes saved on this device.' :
      status.pending ? status.pending+' saved change'+(status.pending===1?' is':'s are')+' waiting to sync.' :
        status.online?'The shared workspace is up to date.':'You are offline. Saved changes will sync after reconnecting.';
    show('Synchronization',`<p>${esc(line)}</p>${status.issue?`<p class="form-error">${esc(status.issue.id||'Workspace')} · ${esc(status.issue.type)}</p>`:''}
      <div class="row-actions stack">${btn('Sync now','sync-now',{symbol:'repeat',style:'primary'})}
      ${btn('Prepare for offline work','prepare',{symbol:'download'})}
      ${status.pending?btn('Export unsynced changes','export-unsynced',{symbol:'download'}):''}
      ${status.issue?btn('Use server version','discard-sync'):''}
      ${status.expired?btn('Sign in','reauth'):''}</div><p class="hint stack">${status.trusted?'This device is enabled for offline work.':'Enable offline work only on a device you control.'}</p>`);
  }
  async function showMembers() {
    const members=await storage.request('members');
    show('Team members',`<div class="row-actions">${btn('Invite member','team-member',{symbol:'plus',style:'primary'})}</div>
      <div class="member-list">${members.map(user=>`<div class="member-row"><div><strong>${esc(user.name)}</strong><small>${esc(user.email)} · ${esc(user.role)} · ${!user.enabled?'Suspended':user.activated?'Active':user.invited?'Invited':'Activation expired'}</small></div>
      ${btn('Manage','team-member',{id:user.id,symbol:'edit'})}</div>`).join('')}</div>`);
    modal.members=members;
  }
  function showMember(user) {
    show(user?'Manage member':'Invite member',
      field('name','Full name',user?.name,{required:true,wide:true,max:100})+
      field('email','Email',user?.email,{type:'email',required:true,readonly:!!user,wide:true,max:254})+
      pick('role','Role',roles,user?.role||'Inspector')+
      (user?pick('enabled','Account status',[['yes','Enabled'],['no','Suspended']],user.enabled?'yes':'no'):'')+
      (user?'<label class="checkbox wide"><input type="checkbox" name="reissue"> '+(user.activated?'Reset password and revoke existing sessions':'Issue a new activation code')+'</label>':''),
      {form:'team-member',id:user?.id||'',submit:user?'Save member':'Create activation code'});
    modal.member=user;
  }
  function templateQuestion(question={},index=0) {
    const numeric=FP.ops?.isReading(question);
    return `<fieldset class="question-editor" data-question-row data-qid="${esc(question.id||'')}"><legend>Check ${index+1}</legend>
      ${field('question','Question',question.label,{required:true,wide:true})}
      ${teamMode?pick('checkType','Check type',[['check','Pass / Fail'],['measurement','Numerical measurement']],numeric?'measurement':'check'):''}
      ${field('criteria','Pass criteria',question.criteria,{required:!numeric,wide:true,max:550,type:'textarea'})}
      ${teamMode?`<div class="form-grid measurement-fields"${numeric?'':' hidden'}>${field('unit','Unit',question.unit,{wide:true,max:30,required:numeric})}
        ${field('min','Minimum (inclusive)',question.min??'',{type:'number'})}${field('max','Maximum (inclusive)',question.max??'',{type:'number'})}
        <p class="hint wide">Enter at least one limit. Leave the other blank for a one-sided range.</p></div>`:''}
      <div class="row-actions">${pick('priority','Priority on failure',priorities,question.priority||'Medium')}
      ${btn('Remove check','remove-question',{style:'subtle',symbol:'x'})}</div></fieldset>`;
  }
  function formFor(action,data) {
    const {id='',parent='',asset:assetId='',value=''} = data;
    const today = FP.workspaceDay(state);
    if (action === 'new-inspection') {
      const message = prerequisites();
      if (message) return requireSetup('New inspection',message);
      show('New inspection',selectTemplate('')+selectAsset(assetId)+selectPerson('Inspector','','','Inspector')+
        field('due','Due date',today,{required:true,type:'date'}),{form:'inspection',submit:'Schedule inspection'});
    }
    if (action === 'reschedule') {
      const record = find(state.inspections,id);
      show('Edit inspection schedule',selectPerson('Inspector',record.assigneeId,false,'Inspector')+
        field('due','Due date',record.due,{required:true,type:'date',readonly:!!record.scheduleId}),{form:'reschedule',id});
    }
    if (action === 'recurrence') {
      const current=find(state.schedules,id);
      if (!current && prerequisites()) return requireSetup('New recurring schedule',prerequisites());
      show(current?'Edit recurring schedule':'New recurring schedule',selectTemplate(current?.templateId)+selectAsset(current?.assetId)+
        selectPerson('Inspector',current?.assigneeId,false,'Inspector')+pick('interval','Repeat',intervals,current?.interval||'Weekly')+
        field('start','Start date',current?.start||today,{required:true,type:'date',min:current?'':today})+
        (current?'<p class="inline-info wide">Changes apply to future occurrences when they are generated.</p>':''),{form:'recurrence',id,submit:'Save schedule'});
    }
    if (action === 'template') {
      const current=find(state.templates,id);
      show(current?'Edit template':'New template',field('name','Template name',current?.name,{required:true,wide:true})+
        field('description','Description',current?.description,{type:'textarea',max:1200,wide:true})+
        `<div class="wide" id="template-questions">${(current?.questions||[{}]).map(templateQuestion).join('')}</div>
        <div class="wide row-actions">${btn('Add check','add-question',{symbol:'plus'})}${current?`<label class="checkbox"><input type="checkbox" name="archived"${current.archived?' checked':''}> Archive template</label>`:''}</div>`,
        {form:'template',id,submit:'Save template'});
    }
    if (action === 'place') {
      const current=find(state.places,id);
      const parentPlace=find(state.places,parent);
      const kind=current?.kind||({Site:'Building',Building:'Area',Area:'Area'}[parentPlace?.kind])||'Site';
      const parentId=current?.parentId||(parentPlace?.kind==='Area'?parentPlace.parentId:parent)||'';
      const eligible = kinds.filter((type,index)=>index===0 || state.places.some(p=>p.kind===kinds[index-1]));
      const parentPick=(type,selected)=>pick('parentId','Parent location',[['','Select a location'],...state.places
        .filter(p=>p.kind===kinds[kinds.indexOf(type)-1]).map(p=>[p.id,p.name])],selected,{wide:true,required:type!=='Site'});
      show(current?'Edit location':'Add location',(current ? field('kind','Location type',kind,{readonly:true}) : pick('kind','Location type',eligible,kind))+
        field('name','Name',current?.name,{required:true})+`<div class="wide" id="place-parent"${kind==='Site'||current?' hidden':''}>${kind==='Site'||current?'':parentPick(kind,parentId)}</div>`+
        field('notes','Address or location notes',current?.notes,{type:'textarea',wide:true,max:1400}),{form:'place',id});
      if (!current) content.querySelector('[name=kind]').addEventListener('change',event=>{
        const target=content.querySelector('#place-parent');
        target.hidden = event.target.value==='Site';
        target.innerHTML=target.hidden?'':parentPick(event.target.value,'');
      });
    }
    if (action === 'asset') {
      const current=find(state.assets,id);
      if (!areaChoices().length) return requireSetup('Add asset',`<p class="inline-info">Add a site, a building, and an inspection area first.</p>${btn('Add location','place',{symbol:'plus',style:'primary'})}`);
      show(current?'Edit equipment':'Add equipment',field('name','Equipment name',current?.name,{required:true,wide:true})+
        field('tag','Asset tag',current?.tag,{required:true})+field('type','Equipment type',current?.type,{required:true})+
        pick('areaId','Inspection area',[['','Select an area'],...areaChoices()],current?.areaId||parent,{required:true,wide:true})+
        pick('status','Operational status',assetStates,current?.status||'In service')+field('manufacturer','Manufacturer',current?.manufacturer)+
        field('model','Model',current?.model)+field('serial','Serial number',current?.serial)+
        field('notes','Notes',current?.notes,{type:'textarea',max:2000,wide:true}),{form:'asset',id});
    }
    if (action === 'person') {
      const current=find(state.people,id);
      show(current?'Edit local profile':'Add local profile',field('name','Full name',current?.name,{required:true,wide:true})+
        pick('role','Role',roles,current?.role||'Inspector',{wide:true}),{form:'person',id});
    }
    if (action === 'new-work') {
      if (!state.assets.length) return requireSetup('New work order',`<p class="inline-info">Add equipment in ${FP.UI.link('Sites & Assets','assets')} before creating a work order.</p>`);
      show('New work order',field('title','Title','',{required:true,wide:true})+selectAsset(assetId,true)+
        selectPerson('Assignee',state.settings.defaultAssignee,true,'Maintenance')+pick('priority','Priority',priorities,'Medium')+
        field('due','Due date',shift(today,state.settings.correctiveDays),{type:'date',required:true})+
        field('description','Description','',{type:'textarea',wide:true,max:4000}),{form:'work',submit:'Create work order'});
    }
    if (action === 'assign') {
      const order=find(state.work,id);
      show('Edit assignment',selectPerson('Assignee',order.assigneeId,true,'Maintenance')+
        pick('priority','Priority',priorities,order.priority)+field('due','Due date',order.due,{type:'date',required:true}),{form:'assign',id});
    }
    if (action === 'review') {
      const label = value==='close'?'Verify and close':'Return for rework';
      show(label,field('notes',value==='close'?'Verification notes (optional)':'Rework reason','',{type:'textarea',required:value==='reject',wide:true,max:4000}),
        {form:value,id,submit:label,danger:value==='reject'});
    }
  }
  const forms = new Set(['new-inspection','reschedule','recurrence','template','place','asset','person','new-work','assign','review']);
  async function saveForm(form) {
    const type=form.dataset.form;
    const id=form.dataset.id;
    const fields=Object.fromEntries(new FormData(form));
    if (type==='team-auth') {
      fields.trusted=fields.trusted==='on';
      state=await storage.authenticate(authMode,fields);
      window.history.replaceState(null,'','#'+(manager()?'dashboard':role()==='Maintenance'?'work':'inspections/mine'));
      render();
      if (fields.trusted) storage.prepare().then(updateSyncLabels).catch(()=>{});
      sync().catch(fail);
      return;
    }
    if (type==='team-member') {
      const result=await storage.request('members',{data:{...fields,id,version:modal.member?.version,enabled:fields.enabled==='yes',reissue:fields.reissue==='on'}});
      state=await storage.sync({force:true});
      render();
      if (result.code) return show('Member activation code',`<p>Share this one-use code privately with ${esc(result.member.email)}. The member should select <strong>Activate an account</strong> on the sign-in page. The code expires in 72 hours.</p>
        <label class="field">Activation code<input id="activation-code" readonly value="${esc(result.code)}"></label><div class="row-actions stack">${btn('Copy code','copy-code',{style:'primary'})}${btn('Back to team','members')}</div>`);
      return showMembers();
    }
    if (type==='confirm-discard') {
      state=await storage.discard();
      closeDialog();
      render();
      return notify('Conflicting change removed. The server version is current.');
    }
    if (type==='team-password') {
      await storage.request('password',{data:fields});
      closeDialog();
      return notify('Password changed. Other sessions were signed out.');
    }
    if (type==='template') {
      fields.questions=[...form.querySelectorAll('[data-question-row]')].map(row=>{
        const val=name=>row.querySelector('[name='+name+']').value;
        const number=name=>val(name)===''?null:Number(val(name));
        const full={id:row.dataset.qid,label:val('question'),criteria:val('criteria'),priority:val('priority')};
        return teamMode&&val('checkType')==='measurement'?{...full,kind:'measurement',unit:val('unit'),min:number('min'),max:number('max')}:full;
      });
    }
    if (teamMode&&type==='settings') {
      fields.responseHours=Object.fromEntries(priorities.map(priority=>[priority,Number(fields['target-'+priority])]));
    }
    if (type==='submission-decisions') {
      await submitInspection(id,fields);
      closeDialog();
      return;
    }
    if (type==='reportFault') {
      if (fields.photoFile?.size) fields.photo=await storage.encodePhoto(fields.photoFile);
      delete fields.photoFile;
      const result=await commit({type,id,fields});
      closeDialog();
      go('faults/'+id);
      return notify(result?.queued?'Fault report saved offline and queued.':'Fault report sent for review.');
    }
    if (type==='recurrence') fields.paused=find(state.schedules,id)?.paused ?? false;
    if (type==='profile') {
      await commit({type,id:fields.profile});
      closeDialog();
      render();
      return notify('Switched to '+person(state,state.activeId)+'.');
    }
    if (type==='reset') {
      state=await storage.restore(FP.empty(),[],state.revision);
      imageCache.clear();
      closeDialog();
      go('settings');
      return notify('Blank workspace created.');
    }
    if (type==='confirmed-restore') {
      state=teamMode?await storage.restore(modal.backup,modal.revision):await storage.restore(modal.backup.state,modal.backup.images,modal.revision);
      imageCache.clear();
      if (!teamMode) await commit({type:'tick'});
      closeDialog();
      go('dashboard');
      return notify('Backup restored with its photos and history.');
    }
    const result=await commit({type,id,fields},modal?.snapshot||state);
    closeDialog();
    if (result?.queued) {
      render();
      return notify('Change saved on this device. Check Synchronization for its status.','info');
    }
    const redirects={inspection:'inspections/run/',work:'work/',asset:'assets/item/',place:'assets/place/'};
    if (redirects[type]) go(redirects[type]+result);
    else render();
    notify(type==='reject'?'Repair returned for rework.':type==='close'?'Repair verified and work order closed.':
      type==='approveFault'?'Fault report assigned.':type==='declineFault'?'Fault report declined.':'Changes saved.');
  }
  async function submitInspection(id,decisions) {
    const work=await commit({type:'submit',id,fields:decisions?{decisions}:undefined});
    render();
    if (work?.queued) return notify('Inspection saved. Submission is queued for synchronization.','info');
    const count=work?.length||0;
    notify(count ? (teamMode?'Inspection submitted. '+count+' linked corrective action(s).':'Inspection submitted. '+count+' corrective work order'+(count===1?'':'s')+' created.'):'Inspection submitted.');
  }
  function faultForm() {
    const directory=state.equipmentDirectory||state.assets;
    if (!directory.length) return show('Report a fault','<p>Add active equipment in Sites &amp; Assets before reporting a fault.</p>');
    show('Report a fault',pick('assetId','Equipment',[['','Select equipment'],...directory.map(item=>[item.id,item.name+' · '+item.tag])],'',{wide:true,required:true})+
      field('title','Fault title','',{required:true,wide:true})+
      pick('priority','Priority',priorities,'Medium',{wide:true})+
      field('notes','What did you observe?','',{type:'textarea',required:true,max:4000,wide:true})+
      '<label class="field wide">Evidence photo (optional)<input type="file" name="photoFile" accept="image/*"></label>',
      {form:'reportFault',id:FP.uid(),submit:'Send for review'});
  }
  function reviewFault(id,value) {
    const fault=find(state.faults,id);
    if (!fault) return;
    if (value==='decline') return show('Decline fault report',field('notes','Reason','',{type:'textarea',required:true,wide:true,max:4000}),
      {form:'declineFault',id,submit:'Decline report',danger:true});
    const candidates=(state.issueCandidates||[]).filter(order=>order.assetId===fault.assetId);
    show('Assign corrective action',
      (candidates.length?pick('workId','Corrective action',[['','Create a new work order'],...candidates.map(order=>[order.id,order.id+' · '+order.title])],'',{wide:true}):'')+
      `<div class="wide form-grid" id="new-fault-assignment">${selectPerson('Assignee',state.settings.defaultAssignee,false,'Maintenance')}
        ${pick('priority','Priority',priorities,fault.priority)}
        ${field('due','Due date',shift(FP.workspaceDay(state),state.settings.correctiveDays),{type:'date',required:true})}</div>`+
      field('notes','Review notes','',{type:'textarea',wide:true,max:4000}),{form:'approveFault',id,submit:'Assign corrective action'});
  }
  async function action(name,data,control) {
    const {id,question,kind,value}=data;
    if (teamMode&&name==='auth-view') {authMode=value;renderAuth();return;}
    if (teamMode&&storage.info().expired&&name==='reauth') {
      await flush().catch(()=>{});
      storage.reauth();
      pending.clear();
      state=null;
      imageCache.clear();
      closeDialog();
      authMode='login';
      return renderAuth('Sign in with the same account to retain your unsynced edits.');
    }
    if (name==='cancel') return closeDialog();
    if (name==='menu') {
      const visible=app.classList.toggle('nav-open');
      app.querySelector('.mobile-menu')?.setAttribute('aria-expanded',String(visible));
      if (visible) app.querySelector('.sidebar nav a')?.focus();
      else app.querySelector('.mobile-menu')?.focus();
      return;
    }
    if (name==='add-question'||name==='remove-question') {
      const group=content.querySelector('#template-questions');
      if (name==='add-question' && group.children.length<40) {
        group.insertAdjacentHTML('beforeend',templateQuestion({},group.children.length));
        FP.i18n?.apply(group.lastElementChild);
        group.lastElementChild.querySelector('input').focus();
      }
      if (name==='remove-question' && group.children.length>1) control.closest('fieldset').remove();
      [...group.children].forEach((row,index)=>row.querySelector('legend').textContent=FP.i18n?.t('Check '+(index+1))||'Check '+(index+1));
      return;
    }
    await flush();
    if (forms.has(name)) return formFor(name,data);
    switch(name) {
      case 'profile':
        if (teamMode) {
          const user=storage.account();
          return show('Account',`<p><strong>${esc(user.name)}</strong></p><p>${esc(user.email)} · ${esc(user.role)}</p>
            <div class="row-actions stack">${btn('Synchronization','sync-status',{symbol:'repeat'})}${btn('Change password','team-password')}${btn('Sign out','team-logout')}</div>`);
        }
        return show('Switch local profile',pick('profile','Acting as',state.people.map(p=>[p.id,p.name+' · '+p.role]),state.activeId,{wide:true})+
          '<p class="hint wide">Profiles identify activity on this device.</p>',{form:'profile',submit:'Switch profile'});
      case 'answer':
        await commit(draftAction({id,question,kind},{value}));
        render();
        return;
      case 'photo': {
        const photo=await photograph(id);
        if (photo) show(photo.name,`<img class="large-photo" src="${esc(photo.src)}" alt="${esc(photo.name)}"><p class="hint">Attached ${FP.UI.stamp(photo.at)}</p>`);
        else notify('This photo is not cached on this device. Connect to the server to view it.','info');
        return;
      }
      case 'remove-photo':
        await commit(draftAction({id,question,kind},{removePhoto:data.photoId}));
        render();
        return notify('Photo removed from draft.');
      case 'save-draft':
        await commit({type:'startInspection',id});
        render();
        return notify(teamMode?'Inspection draft saved.':'Inspection draft saved on this device.');
      case 'submit': {
        const record=find(state.inspections,id);
        const invalid=record.questions.find(q=>!record.results[q.id].value||(record.results[q.id].value==='Fail'&&!record.results[q.id].notes.trim()));
        if (invalid) {
          const fields=[...app.querySelectorAll('[data-question]')];
          fields.find(el=>el.dataset.question===invalid.id && (record.results[invalid.id].value?el.matches('textarea'):el.matches('button,input[data-field=reading]')))?.focus();
          throw new Error(record.results[invalid.id].value ? 'Add finding notes for the failed check.' : FP.ops?.isReading(invalid)?'Enter the required measurement.':'Choose Pass or Fail for every check.');
        }
        const failed=record.questions.filter(q=>record.results[q.id].value==='Fail');
        const choices=(state.issueCandidates||[]).filter(order=>order.assetId===record.assetId);
        if (teamMode&&failed.length&&choices.length) return show('Review corrective actions',
          '<p class="hint wide">Link a matching issue or create a separate order. Every finding and photo will be kept.</p>'+
          failed.map(q=>pick(q.id,q.label,[['auto','Link an open order for the same check, if available'],['new','Create a new work order'],
            ...choices.map(order=>[order.id,order.id+' · '+order.title])],'auto',{wide:true})).join(''),
          {form:'submission-decisions',id,submit:'Submit inspection'});
        return submitInspection(id);
      }
      case 'pause': {
        const paused=await commit({type:'pause',id});
        render();
        return notify(paused?'Recurring schedule paused.':'Recurring schedule resumed.');
      }
      case 'start-work':
        await commit({type:'startWork',id});
        render();
        return notify('Work order started.');
      case 'request-review':
        {const result=await commit({type:'requestReview',id});
        render();
        return notify(result?.queued?'Verification request saved on this device.':'Repair is ready for supervisor verification.');}
      case 'pdf': {
        const blob=await FP.pdf(state,kind,id,photograph,data.language);
        download('FieldProof-'+id+'.pdf',blob);
        return notify('PDF report downloaded.');
      }
      case 'backup': {
        const backup=await storage.backup();
        const blob=new Blob([JSON.stringify(backup)],{type:'application/json'});
        download('FieldProof-backup-'+localDay()+'.json',blob);
        return notify('Backup downloaded.');
      }
      case 'restore':
        show('Restore a backup','<p>Choose a FieldProof backup. Review its contents before replacing this workspace.</p><label class="field">Backup file<input id="backup-file" type="file" accept=".json,application/json"></label>');
        return;
      case 'reset':
        return show('Start a blank workspace','<p class="inline-info wide">This replaces all records and photographs in this browser. Export a backup first if you need them.</p>',
          {form:'reset',submit:'Replace workspace',danger:true});
      case 'persist': {
        const saved=await navigator.storage?.persist?.();
        return notify(saved?'The browser granted persistent storage.':'The browser has not granted persistent storage. Keep a separate backup.',saved?'success':'info');
      }
      case 'sync-status': return showSync();
      case 'sync-now':
        state=await storage.sync({force:true,retry:true});
        render();
        return showSync();
      case 'prepare': {
        const result=await storage.prepare();
        const persistence=await navigator.storage?.persist?.().catch(()=>false);
        render();
        return show('Offline preparation',`<p>${result.ready?'The offline app is ready.':'Keep this tab online until the offline app finishes installing.'}</p>
          <p class="stack">${result.photos} of ${result.total} assigned evidence photos are cached on this device.</p>
          <p class="hint stack">${persistence?'The browser granted persistent storage.':'This browser can clear cached data. Sync when you reconnect.'}</p>`);
      }
      case 'export-unsynced':
        download('FieldProof-unsynced-'+localDay()+'.json',new Blob([JSON.stringify(await storage.exportPending())],{type:'application/json'}));
        return notify('Unsynced changes exported.');
      case 'discard-sync':
        return show('Use the server version','<p class="inline-info wide">This removes the conflicting edit from this device. Export unsynced changes first if you need a copy.</p>',
          {form:'confirm-discard',submit:'Discard conflicting edit',danger:true});
      case 'reauth':
      case 'team-logout':
        if (name==='team-logout') await storage.logout();
        else storage.reauth();
        state=null;
        imageCache.clear();
        closeDialog();
        authMode='login';
        return renderAuth(name==='reauth'?'Sign in with the same account to retain your unsynced edits.':'');
      case 'members': return showMembers();
      case 'new-fault': return faultForm();
      case 'review-fault': return reviewFault(id,value);
      case 'inbox': return show('Notifications',FP.fieldUI.inbox(state));
      case 'notice-open': {
        const notice=find(state.notices||[],id);
        if (!notice) return;
        if (!notice.read&&storage.info().online) await commit({type:'readNotice',id});
        closeDialog();
        return go(notice.route);
      }
      case 'team-member': return showMember(modal?.members?.find(account=>account.id===id));
      case 'copy-code': {
        const field=document.querySelector('#activation-code');
        field.select();
        await navigator.clipboard.writeText(field.value);
        return notify('Activation code copied.');
      }
      case 'team-password':
        return show('Change password',field('current','Current password','',{type:'password',required:true,max:128,wide:true})+
          field('password','New password','',{type:'password',required:true,max:128,wide:true}),{form:'team-password',submit:'Change password'});
      case 'audit': {
        const records=await storage.request('audit');
        return show('Workspace audit history',`<div class="member-list">${records.map(entry=>
          `<div class="member-row"><div><strong>${esc(auditLabels[entry.action]||entry.action)}${entry.target?' · '+esc(entry.target):''}</strong><small>${FP.UI.stamp(entry.at)} · ${esc(entry.actor==='system'?'System':person(state,entry.actor))}</small></div></div>`).join('')}</div>`);
      }
    }
  }
  async function guarded(handler,control) {
    if (busy) return;
    busy=true;
    if (control?.tagName==='BUTTON') control.disabled=true;
    try { await handler(); }
    catch (error) {
      const inline=(dialog.open&&dialog.querySelector('.form-error'))||app.querySelector('[data-form="team-auth"] .form-error');
      if (inline) { inline.hidden=false; inline.textContent=FP.i18n?.t(error.message)||error.message; }
      else fail(error);
    } finally { busy=false; if (control?.tagName==='BUTTON') control.disabled=false; }
  }
  document.addEventListener('click',event=>{
    if (event.target.closest('[data-action="reload"]')) {
      window.location.reload();
      return;
    }
    if (event.target.closest('.skip')) {
      event.preventDefault();
      document.querySelector('#main')?.focus();
      return;
    }
    const node=event.target.closest('[data-action]');
    if (node && (state||node.dataset.action==='auth-view')) {
      const data={...node.dataset};
      guarded(()=>action(data.action,data,node),node);
    }
    const anchor=event.target.closest('a[href^="#"]');
    if (anchor) {
      if (dialog.open) closeDialog();
      app.classList.remove('nav-open');
      app.querySelector('.mobile-menu')?.setAttribute('aria-expanded','false');
    }
  });
  document.addEventListener('submit',event=>{
    const form=event.target.closest('[data-form]');
    if (!form) return;
    event.preventDefault();
    guarded(async()=>{ await flush(); await saveForm(form); },event.submitter);
  });
  document.addEventListener('input',event=>{
    const {dataset,value}=event.target;
    event.target.setCustomValidity?.('');
    if (dataset.search) { filters[dataset.search]=value; render(dataset.search); }
    if ('draft' in dataset) {
      if (event.target.validity?.badInput) return;
      const numeric=dataset.field==='reading';
      const patch=numeric?{reading:value===''?null:Number(value)}:{notes:value};
      const guard=teamMode?FP.team.basis(state,draftAction(dataset,patch)):undefined;
      pending.set(key(dataset),{...dataset,patch,actorId:state.activeId,workspaceKey:state.workspaceKey,basis:guard});
      if (numeric) {
        const q=find(find(state.inspections,dataset.id)?.questions||[],dataset.question);
        const outcome=patch.reading===null?'Unanswered':FP.ops.within(q,patch.reading)?'Pass':'Fail';
        const tag=event.target.closest('.numeric-row').querySelector('.numeric-outcome');
        tag.innerHTML=FP.UI.tag(outcome);
        FP.i18n?.apply(tag);
        const record=find(state.inspections,dataset.id);
        const values=record.questions.map(check=>{
          const pendingReading=pending.get(key({...dataset,question:check.id}))?.patch.reading;
          return pendingReading===null?'':typeof pendingReading==='number'?
            (FP.ops.within(check,pendingReading)?'Pass':'Fail'):record.results[check.id].value;
        });
        const completed=values.filter(Boolean).length;
        const progress=app.querySelector('progress');
        if (progress) progress.value=completed;
        const translate=FP.i18n?.t||(x=>x);
        app.querySelector('#check-progress').textContent=translate(completed+' of '+values.length+' checks');
        app.querySelector('#failure-progress').textContent=translate(values.filter(result=>result==='Fail').length+' failed');
      }
      const label=document.querySelector('#draft-state');
      if (label) label.textContent=FP.i18n?.t('Saving draft…')||'Saving draft…';
      clearTimeout(noteTimer);
      noteTimer=setTimeout(()=>flush().catch(fail),320);
    }
  });
  document.addEventListener('change',event=>{
    const {dataset,value,files}=event.target;
    event.target.setCustomValidity?.('');
    if ('language' in dataset) {
      FP.i18n.set(value);
      if (!toast.hidden) toast.textContent=FP.i18n.t(toastMessage);
      if (state) render(); else renderAuth();
      const next=app.querySelector('[data-language]');
      next?.focus({preventScroll:true});
    }
    if (event.target.name==='checkType') {
      const row=event.target.closest('[data-question-row]');
      const numeric=value==='measurement';
      row.querySelector('.measurement-fields').hidden=!numeric;
      row.querySelector('[name=unit]').required=numeric;
      row.querySelector('[name=criteria]').required=!numeric;
    }
    if (event.target.name==='workId'&&modal?.form==='approveFault') {
      const box=content.querySelector('#new-fault-assignment');
      box.hidden=!!value;
      for (const input of box.querySelectorAll('input,select')) input.disabled=!!value;
    }
    if (dataset.filter) { filters[dataset.filter]=value; render(); app.querySelector('[data-filter="'+dataset.filter+'"]')?.focus(); }
    if ('photoInput' in dataset && files?.length) {
      const selection=Array.from(files);
      event.target.value='';
      guarded(async()=>{
        await flush();
        let saved=0;
        const errors=[];
        for (const file of selection) {
          try {
            const photo=await storage.encodePhoto(file);
            await commit(draftAction(dataset,{photo}));
            saved++;
          } catch(error) { errors.push(error); }
        }
        render();
        if (errors.length) throw new Error((saved?saved+' photo(s) saved. ':'')+errors[0].message);
        notify(saved+' photo'+(saved===1?'':'s')+' saved on this device.');
      });
    }
    if (event.target.id==='backup-file' && files?.length) {
      guarded(async()=>{
        const backup=await storage.readBackup(files[0]);
        const data=backup.state;
        show('Confirm backup restore',`<p class="wide"><strong>${esc(data.workspace)}</strong> contains ${data.assets.length} assets, ${data.inspections.length} inspections, ${data.work.length} work orders, and ${backup.images.length} photos.</p>
          <p class="inline-info wide">${teamMode?'This replaces work records for the entire team. Member accounts stay in place. Export the current workspace before continuing.':'Restoring replaces this browser’s current workspace. Export the current workspace first if you need a copy.'}</p>`,
          {form:'confirmed-restore',submit:'Replace with backup',danger:true});
        modal.backup=backup;
        modal.revision=state.revision;
      });
    }
  });
  document.addEventListener('invalid',event=>{
    if (FP.i18n?.locale()!=='zh-CN'||!event.target.validity) return;
    const validity=event.target.validity;
    const message=validity.valueMissing?'This field is required.':
      validity.typeMismatch&&event.target.type==='email'?'Valid email required.':
      validity.rangeOverflow||validity.rangeUnderflow?'Value is outside the permitted range.':'Enter a valid value.';
    event.target.setCustomValidity(FP.i18n.t(message));
  },true);
  window.addEventListener('hashchange',()=>{
    flush().catch(fail).finally(()=>{
      render();
      window.scrollTo(0,0);
      document.querySelector('#main')?.focus({preventScroll:true});
    });
  });
  window.addEventListener('beforeunload',event=>{
    if (pending.size || savingNotes) { event.preventDefault(); event.returnValue=''; }
  });
  window.addEventListener('keydown',event=>{
    if (event.key==='Escape' && app.classList.contains('nav-open')) action('menu',{},null);
  });
  async function sync() {
    if (!state || busy || pending.size || dialog.open) return;
    if (teamMode) {
      const before=JSON.stringify(storage.info());
      const revision=state.revision;
      const notices=(state.notices||[]).map(n=>n.id+':'+n.read).join(',');
      const latest=await storage.sync();
      if (latest&&state&&!busy&&!pending.size&&!dialog.open&&latest.revision>=state.revision) {
        if (latest.workspaceKey!==state.workspaceKey) imageCache.clear();
        state=latest;
        if (before!==JSON.stringify(storage.info())||revision!==state.revision||notices!==(state.notices||[]).map(n=>n.id+':'+n.read).join(',')||app.querySelector('.sync-button')?.textContent!==(FP.i18n?.t(storage.label())||storage.label())) {
          if (document.activeElement?.matches('[data-draft], [data-form=settings] input, [data-form=settings] select')) updateSyncLabels();
          else render();
        }
      }
      return;
    }
    if (externalRevision>state.revision) {
      const latest=await storage.get();
      if (latest?.revision>state.revision) {
        state=latest;
        imageCache.clear();
        render();
      }
    }
    if (loadedDay!==localDay()) {
      loadedDay=localDay();
      await commit({type:'tick'});
      render();
    }
  }
  storage.channel?.addEventListener('message',event=>{
    externalRevision=Math.max(externalRevision,event.data);
    sync().catch(fail);
  });
  document.addEventListener('visibilitychange',()=>{
    if (document.hidden) flush().catch(fail);
    else sync().catch(fail);
  });
  window.addEventListener('online',()=>sync().catch(fail));
  window.addEventListener('offline',()=>sync().catch(fail));
  setInterval(()=>sync().catch(fail),teamMode?4500:30000);
  async function boot() {
    if (teamMode) {
      navigator.serviceWorker?.register('/sw.js').catch(()=>{});
      const session=await storage.boot();
      if (session.state) {
        state=session.state;
        render();
        sync().catch(fail);
      } else {
        canSetup=session.setup;
        authOffline=!!session.offline;
        authMode=canSetup?'setup':'login';
        renderAuth();
        if (authOffline) window.addEventListener('online',()=>{if (!state) window.location.reload();},{once:true});
      }
      return;
    }
    state=await storage.get();
    if (!state) {
      const demo=FP.demo();
      const images=[];
      if (FP.demoPhoto) {
        const finding=find(demo.state.inspections,demo.photoTarget.inspectionId).results[demo.photoTarget.questionId];
        const photo={...FP.demoPhoto,id:'demo-pump-photo',at:finding.at,name:'Pump seal seepage (demo).jpg'};
        const {src,...meta}=photo;
        images.push(photo);
        demo.state.evidence.push(meta);
        finding.photos.push(meta.id);
      }
      state=await storage.restore(demo.state,images);
    }
    await sync();
    if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
      navigator.serviceWorker.register('./sw.js').catch(()=>{});
    }
  }
  boot().catch(error=>{
    app.innerHTML=`<main class="load-error"><h1>FieldProof could not open this workspace</h1>${empty('Workspace unavailable',error.message,'warning')}<button class="btn primary" type="button" data-action="reload">Try again</button></main>`;
    FP.i18n?.apply(app);
  });
})();
