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
