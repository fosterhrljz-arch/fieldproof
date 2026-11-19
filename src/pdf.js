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
