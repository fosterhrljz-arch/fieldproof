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
