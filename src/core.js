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
