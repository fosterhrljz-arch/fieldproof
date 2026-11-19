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
