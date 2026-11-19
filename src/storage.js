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
