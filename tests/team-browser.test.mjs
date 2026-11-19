import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {startFieldProof} from '../server.mjs';
import {act,createTeam,createEquipment,schedule,setupCode,testPassword,people} from './team-fixtures.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const temp=await mkdtemp(join(tmpdir(),'fieldproof-team-'));
const downloads=join(temp,'downloads');
await mkdir(downloads);
const chrome=process.env.FIELDPROOF_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const server=await startFieldProof({port:0,file:join(temp,'team.sqlite'),setupCode});
const e2e=[];
const submit='dialog button[type=submit]';
const authSubmit='form[data-form=team-auth] button[type=submit]';
const question=id=>'[data-question="'+id+'"]';

async function waitFor(check,label,timeout=18000) {
  const end=Date.now()+timeout;
  while (Date.now()<end) {
    if (await check()) return;
    await delay(80);
  }
  throw new Error('Timed out waiting for '+label);
}
async function launch(label,{width=1440,height=1000,mobile=false}={}) {
  const process=spawn(chrome,['--headless=new','--remote-debugging-pipe','--disable-background-networking','--no-first-run',
    '--no-default-browser-check','--no-proxy-server','--user-data-dir='+join(temp,'profile-'+label),'about:blank'],
  {stdio:['ignore','ignore','pipe','pipe','pipe'],windowsHide:true});
  const commands=new Map(), errors=[];
  let counter=0, buffer='', sessionId, stderr='';
  process.stderr.on('data',chunk=>stderr=(stderr+chunk.toString()).slice(-3000));
  process.on('error',error=>commands.forEach(item=>item.reject(error)));
  process.on('exit',code=>commands.forEach(item=>item.reject(new Error('Chromium exited '+code+' '+stderr))));
  process.stdio[4].setEncoding('utf8').on('data',chunk=>{
    buffer+=chunk;
    let end;
    while ((end=buffer.indexOf('\0'))>=0) {
      const message=JSON.parse(buffer.slice(0,end));
      buffer=buffer.slice(end+1);
      if (message.id) {
        const pending=commands.get(message.id);
        commands.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error.message)); else pending?.resolve(message.result);
      }
      if (message.method==='Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
    }
  });
  const send=(method,params={},outer=false)=>new Promise((resolve,reject)=>{
    const id=++counter;
    commands.set(id,{resolve,reject});
    process.stdio[3].write(JSON.stringify({id,method,params,...(sessionId&&!outer?{sessionId}:{})})+'\0');
  });
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  ({sessionId}=await send('Target.attachToTarget',{targetId,flatten:true}));
  for (const domain of ['Page','Runtime','DOM','Network']) await send(domain+'.enable');
  await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads},true);
  await send('Emulation.setDeviceMetricsOverride',{width,height,mobile,deviceScaleFactor:1});
  const evaluate=async expression=>{
    const data=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if (data.exceptionDetails) throw new Error(data.exceptionDetails.exception?.description||data.exceptionDetails.text);
    return data.result.value;
  };
  const selector=rule=>'document.querySelector('+JSON.stringify(rule)+')';
  const visible=rule=>waitFor(()=>evaluate('Boolean('+selector(rule)+')').catch(()=>false),label+' '+rule);
  const text=(rule,expected)=>waitFor(()=>evaluate(selector(rule)+'?.textContent?.includes('+JSON.stringify(expected)+')').catch(()=>false),
    label+' '+rule+' containing '+expected);
  const click=async rule=>{await visible(rule);return evaluate(selector(rule)+'.click()');};
  const fill=(rule,value,event='input')=>evaluate(`(()=>{const node=${selector(rule)};node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('${event}',{bubbles:true}));})()`);
  const navigate=async(hash='')=>{await send('Page.navigate',{url:server.origin+'/'+hash});await visible('#main');};
  const route=hash=>evaluate('location.hash='+JSON.stringify(hash));
  const offline=state=>send('Network.emulateNetworkConditions',{offline:state,latency:0,downloadThroughput:state?0:-1,uploadThroughput:state?0:-1});
  const attach=async(rule,filename)=>{
    const {root:doc}=await send('DOM.getDocument');
    const {nodeId}=await send('DOM.querySelector',{nodeId:doc.nodeId,selector:rule});
    assert.ok(nodeId);
    await send('DOM.setFileInputFiles',{nodeId,files:[resolve(root,filename)]});
  };
  const snap=async(name)=>{
    const shot=await send('Page.captureScreenshot',{format:'png',fromSurface:true});
    await writeFile(resolve(root,'screenshots',name+'.png'),Buffer.from(shot.data,'base64'));
  };
  const close=async()=>{
    const closed=new Promise(done=>process.once('close',done));
    await send('Browser.close',{},true).catch(()=>{});
    await closed;
  };
  const page={send,evaluate,visible,text,click,fill,navigate,route,offline,attach,snap,close,errors};
  e2e.push(page);
  return page;
}
async function signIn(page,key,trusted=false) {
  await page.navigate();
  await page.text('h1','Sign in to FieldProof');
  await page.fill('[name=email]',people[key].email);
  await page.fill('[name=password]',testPassword);
  if (trusted) await page.click('[name=trusted]');
  await page.click(authSubmit);
  await page.visible('.sync-button');
  assert.match(await page.evaluate('document.title'),/^FieldProof/);
}
const status='.work-detail .pane-head .tag';
const cert=async(page,value,note)=>{
  await page.click('[data-action=review][data-value='+value+']');
  await page.visible('dialog[open] textarea');
  await page.fill('dialog textarea',note);
  await page.click(submit);
};
async function fillRepair(page,note) {
  await page.visible('textarea[data-kind=work]');
  await page.fill('textarea[data-kind=work]',note);
  await page.attach('input[data-photo-input][data-kind=work]','tests/pump-after-repair.jpg');
  await page.text('#toast','1 photo saved');
  await page.click('[data-action=request-review]');
  await page.text(status,'Pending Verification');
}
const inspectPhoto='.check-card img[data-photo]';
function unicodeText(pdf) {
  const mapping=new Map();
  for (const block of pdf.matchAll(/\d+ beginbfchar\n([\s\S]*?)\nendbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-f]+)> <([0-9a-f]+)>/g)) {
      mapping.set(pair[1],String.fromCharCode(...pair[2].match(/.{4}/g).map(unit=>parseInt(unit,16))));
    }
  }
  return [...pdf.matchAll(/<([0-9a-f]+)> Tj/g)].map(match=>
    match[1].match(/.{4}/g).map(cid=>mapping.get(cid)||'').join('')).join('\n');
}
try {
  const {profiles,members}=await createTeam(server.origin);
  const equipment=await createEquipment(profiles.admin,members);
  const overdue=await schedule(profiles.admin,equipment,members.inspector,FP.shift(FP.localDay(),-2));
  const upcoming=await schedule(profiles.admin,equipment,members.inspector,FP.shift(FP.localDay(),3));
  await schedule(profiles.admin,equipment,members.unrelated,FP.localDay());
  const inspection=(await profiles.inspector('workspace')).state.inspections.find(item=>item.id===overdue);
  const [seal,pressure,noise]=inspection.questions.map(q=>q.id);
  const href='#inspections/run/'+overdue;
  const technician=await launch('maintenance',{width:390,height:844,mobile:true});
  const inspector=await launch('inspector',{width:390,height:844,mobile:true});
  const supervisor=await launch('supervisor');
  const admin=await launch('admin');
  await Promise.all([signIn(inspector,'inspector',true),signIn(technician,'technician'),signIn(supervisor,'supervisor'),signIn(admin,'admin')]);
  await inspector.text('h1','My Inspections');
  await technician.text('h1','My Work');
  await supervisor.text('h1','Operations overview');
  await inspector.visible('a.task-row[href="'+href+'"]');
  await inspector.visible('a.task-row[href="#inspections/run/'+upcoming+'"]');
  assert.equal(await inspector.evaluate('document.querySelectorAll("a.task-row").length'),2);
  assert.equal(await inspector.evaluate(`!document.querySelector('[href="#settings"]')`),true);
  assert.equal(await inspector.evaluate('document.documentElement.scrollWidth === window.innerWidth'),true);
  await inspector.snap('team-my-inspections');
  await inspector.click('a.task-row[href="'+href+'"]');
  await inspector.text('#check-progress','0 of 3');
  await waitFor(()=>inspector.evaluate('navigator.serviceWorker.controller !== null'),'offline shell becomes active');
  assert.equal(await inspector.evaluate('caches.match("/fonts/NotoSansSC-Regular.ttf").then(Boolean)'),true);

  await inspector.offline(true);
  await inspector.text('.sync-button','Offline');
  await inspector.click(question(seal)+'[data-value=Fail]');
  await inspector.text('#check-progress','1 of 3');
  await inspector.fill('textarea'+question(seal),'Water collects below the leaking shaft seal during circulation.');
  await inspector.attach('input[data-photo-input]'+question(seal),'src/demo-pump.jpg');
  await inspector.text('#toast','1 photo saved');
  await inspector.click(question(pressure)+'[data-value=Pass]');
  await inspector.text('#check-progress','2 of 3');
  await inspector.click(question(noise)+'[data-value=Pass]');
  await inspector.text('#check-progress','3 of 3');
  await inspector.evaluate('window.beforeOfflineReload=true');
  await inspector.send('Page.reload');
  await waitFor(()=>inspector.evaluate('!window.beforeOfflineReload && !navigator.onLine && !!document.querySelector("#check-progress")').catch(()=>false),'offline reload');
  await inspector.text('#check-progress','3 of 3');
  await waitFor(()=>inspector.evaluate('document.querySelector("'+inspectPhoto+'")?.naturalWidth'),'offline photo survives reload');
  assert.match(await inspector.evaluate('document.querySelector('+JSON.stringify('textarea'+question(seal))+').value'),/Water collects/);
  await inspector.snap('team-offline-inspection');
  await inspector.click('[data-action=submit]');
  await inspector.text('#toast','queued for synchronization');
  await inspector.text('.inspection-meta .tag','Queued');
  assert.equal((await profiles.supervisor('workspace')).state.work.length,0);

  await inspector.offline(false);
  await inspector.text('.inspection-meta .tag','Completed');
  await inspector.text('.sync-button','Up to date');
  const {state:shared}=await profiles.supervisor('workspace');
  const [order]=shared.work;
  assert.equal(order.assigneeId,members.technician);
  assert.equal(order.inspectionId,overdue);
  assert.equal(order.questionId,seal);
  assert.equal(shared.inspections.find(i=>i.id===overdue).submittedBy,members.inspector);
  assert.equal(shared.evidence.length,1);
  const work='#work/'+order.id;
  await technician.text('.task-row','Correct: Check pump seal for leaks');
  await technician.click('a.task-row[href="'+work+'"]');
  await technician.text(status,'Open');
  assert.equal(await technician.evaluate('!document.querySelector("[data-action=assign]")'),true);
  await technician.click('[data-action=start-work]');
  await technician.text(status,'In Progress');
  await fillRepair(technician,'Replaced the shaft seal and checked the pump at 54 psi.');
  await supervisor.route(work);
  await supervisor.text(status,'Pending Verification');
  await waitFor(()=>supervisor.evaluate('[...document.querySelectorAll(".evidence-grid img")].filter(img=>img.naturalWidth).length===2'),'both evidence photos are visible');
  await supervisor.snap('team-review');
  await cert(supervisor,'reject','Run the pump under circulation for at least 30 minutes.');
  await supervisor.text(status,'In Progress');
  await technician.text(status,'In Progress');
  await fillRepair(technician,'Rechecked at operating pressure for 30 minutes. No seepage.');
  await supervisor.text(status,'Pending Verification');
  await cert(supervisor,'close','Verified independently. The shaft seal and base stayed dry.');
  await supervisor.text(status,'Closed');
  await technician.text(status,'Closed');
  await supervisor.text('.timeline','Repair verified and closed');
  assert.equal(await supervisor.evaluate('document.querySelectorAll(".repair").length'),2);
  await supervisor.click('[data-action=pdf][data-kind=work]');
  await supervisor.text('#toast','PDF report downloaded');
  const report='FieldProof-'+order.id+'.pdf';
  await waitFor(async()=>(await readdir(downloads)).includes(report),'work order report');
  const pdf=(await readFile(join(downloads,report))).toString('latin1');
  assert.match(unicodeText(pdf),/Verified independently/);
  assert.match(pdf,/\/DCTDecode/);
  await supervisor.route('#dashboard');
  await supervisor.text('h1','Operations overview');
  assert.deepEqual(await supervisor.evaluate('[...document.querySelectorAll(".metric strong")].map(n=>n.textContent)'),['50%','0','0','1']);
  await waitFor(()=>supervisor.evaluate('document.querySelector("#toast").hidden'),'dashboard screenshot without toast');
  await supervisor.snap('team-dashboard');
  console.log('PASS four isolated browser profiles, assigned mobile queues, offline evidence and reload, reconnect, one shared corrective action, repair rework, independent approval, analytics and PDF');

  const next='#inspections/run/'+upcoming;
  await inspector.route(next);
  await inspector.text('#check-progress','0 of 3');
  const nextSeal=(await profiles.admin('workspace')).state.inspections.find(i=>i.id===upcoming).questions[0].id;
  await inspector.offline(true);
  await inspector.text('.sync-button','Offline');
  await inspector.fill('textarea'+question(nextSeal),'Offline observation from the field.');
  await inspector.text('#draft-state','Draft saved');
  await act(profiles.supervisor,{type:'result',id:upcoming,questionId:nextSeal,fields:{notes:'Supervisor saved an independent observation.'}});
  await inspector.offline(false);
  await inspector.text('.sync-button','Review sync issue');
  await inspector.click('[data-action=sync-status]');
  await inspector.text('#dialog-content','Someone changed this record');
  await inspector.click('[data-action=export-unsynced]');
  await inspector.text('#toast','Unsynced changes exported');
  let unsynced;
  await waitFor(async()=>Boolean(unsynced=(await readdir(downloads)).find(name=>name.includes('unsynced'))),'conflicting edit export');
  const saved=JSON.parse(await readFile(join(downloads,unsynced),'utf8'));
  assert.equal(saved.commands[0].action.fields.notes,'Offline observation from the field.');
  await inspector.click('[data-action=discard-sync]');
  await inspector.text('#dialog-title','Use the server version');
  await inspector.click(submit);
  await inspector.text('.sync-button','Up to date');
  assert.match(await inspector.evaluate('document.querySelector('+JSON.stringify('textarea'+question(nextSeal))+').value'),/Supervisor saved/);
  await admin.route('#settings');
  await admin.text('h1','Settings');
  await admin.click('[data-action=members]');
  await admin.text('#dialog-title','Team members');
  await admin.click('[data-action=team-member]:not([data-id])');
  await admin.fill('dialog input[name=name]','Taylor Brooks');
  await admin.fill('dialog input[name=email]','taylor@example.test');
  await admin.click(submit);
  await admin.text('#dialog-title','Member activation code');
  assert.ok((await admin.evaluate('document.querySelector("#activation-code").value')).length>30);
  await admin.click('[data-action=cancel]');
  const standalone=await act(profiles.admin,{type:'work',fields:{title:'Secure a loose coupling guard',assetId:equipment.asset,
    assigneeId:members.supervisor,priority:'Medium',due:FP.localDay()}});
  await supervisor.route('#work/'+standalone.result);
  await supervisor.text(status,'Open');
  await supervisor.click('[data-action=start-work]');
  await supervisor.text(status,'In Progress');
  await fillRepair(supervisor,'Secured the guard hardware and checked the assembly.');
  await supervisor.text('.detail-actions','An independent supervisor must verify this repair.');
  assert.equal(await supervisor.evaluate(`!document.querySelector('[data-value="close"]')`),true);
  await admin.route('#work/'+standalone.result);
  await admin.text(status,'Pending Verification');
  await cert(admin,'close','Verified by a different account.');
  await admin.text(status,'Closed');
  await admin.route('#inspections/templates');
  await admin.visible('.page-head [data-action=template]');
  await admin.click('.page-head [data-action=template]');
  await admin.fill('dialog input[name=name]','Water pump thermal inspection');
  await admin.fill('dialog input[name=question]','轴承温度 / Bearing temperature');
  await admin.fill('dialog select[name=checkType]','measurement','change');
  await admin.fill('dialog input[name=unit]','°C');
  await admin.fill('dialog input[name=min]','15');
  await admin.fill('dialog input[name=max]','75');
  await admin.fill('dialog select[name=priority]','High','change');
  await admin.click(submit);
  await admin.text('tbody','Water pump thermal inspection');
  const payload=(await profiles.admin('workspace')).state;
  const measured={...equipment,template:payload.templates.find(row=>row.name==='Water pump thermal inspection').id};
  const first=await schedule(profiles.admin,measured,members.inspector);
  const second=await schedule(profiles.admin,measured,members.inspector);
  await inspector.fill('.language-control select','zh','change');
  await inspector.text('.topbar','我的巡检');
  await inspector.route('#inspections/run/'+first);
  await inspector.visible('input[data-field=reading]');
  await inspector.fill('input[data-field=reading]','86.5');
  await inspector.text('.numeric-outcome','不合格');
  await inspector.fill('textarea[data-draft]','轴承过热，读数高于正常范围。 Bearing overheated.');
  const firstControl=await inspector.evaluate('document.querySelector("[data-field=reading]").dataset.question');
  await inspector.attach('input[data-photo-input]'+question(firstControl),'src/demo-pump.jpg');
  await inspector.text('#toast','已在本机保存 1 张照片');
  await inspector.text('#check-progress','已检查 1／1 项');
  await inspector.snap('v21-measurement-zh');
  await inspector.click('[data-action=submit]');
  await inspector.text('.inspection-meta .tag','已完成');
  const firstOrder=(await profiles.supervisor('workspace')).state.work.find(w=>w.inspectionId===first);
  assert.ok(firstOrder);
  await inspector.route('#inspections/run/'+second);
  await inspector.visible('input[data-field=reading]');
  await inspector.fill('input[data-field=reading]','89');
  await inspector.fill('textarea[data-draft]','复测仍过热。 Repeated high temperature.');
  await inspector.click('[data-action=submit]');
  await inspector.text('#dialog-title','确认整改处理方式');
  const selected=await inspector.evaluate('document.querySelector("dialog select").name');
  await inspector.fill('dialog select[name="'+selected+'"]',firstOrder.id,'change');
  await inspector.click(submit);
  await inspector.text('.inspection-meta .tag','已完成');
  const merged=(await profiles.supervisor('workspace')).state.work.find(w=>w.id===firstOrder.id);
  assert.equal(merged.sources.length,2);
  await inspector.route('#faults');
  await inspector.text('h1','故障上报');
  await inspector.offline(true);
  await inspector.text('.sync-button','离线');
  await inspector.click('[data-action=new-fault]');
  await inspector.text('#dialog-title','上报故障');
  await inspector.fill('dialog select[name=assetId]',equipment.asset,'change');
  await inspector.fill('dialog input[name=title]','联轴器防护罩开裂 / Cracked coupling guard');
  await inspector.fill('dialog select[name=priority]','Urgent','change');
  await inspector.fill('dialog textarea[name=notes]','防护罩出现明显裂缝。 Visible crack on the guard.');
  await inspector.attach('input[name=photoFile]','src/demo-pump.jpg');
  await inspector.click(submit);
  await inspector.text('#toast','故障报告已离线保存');
  await inspector.text('.pane-head .tag','待同步');
  await inspector.evaluate('window.beforeFaultReload=true');
  await inspector.send('Page.reload');
  await waitFor(()=>inspector.evaluate('!window.beforeFaultReload && !navigator.onLine && document.documentElement.lang==="zh-CN" && !!document.querySelector(".facts")').catch(()=>false),'offline fault and language survive reload');
  assert.equal(await inspector.evaluate('document.documentElement.scrollWidth===window.innerWidth'),true);
  await inspector.offline(false);
  await inspector.text('.pane-head .tag','已上报');
  const faultHref=await inspector.evaluate('location.hash');
  await supervisor.route(faultHref);
  await supervisor.text('h1','Cracked coupling guard');
  await supervisor.click('[data-action=review-fault][data-value=approve]');
  await supervisor.text('#dialog-title','Assign corrective action');
  await supervisor.click(submit);
  await supervisor.text('.pane-head .tag','Assigned');
  const approved=(await profiles.supervisor('workspace')).state.faults.find(item=>item.id===faultHref.split('/').at(-1));
  await technician.route('#work/'+approved.workId);
  await technician.text(status,'Open');
  await technician.click('[data-action=start-work]');
  await technician.text(status,'In Progress');
  await fillRepair(technician,'更换了开裂的防护罩。 Replaced the cracked guard and checked fasteners.');
  await supervisor.route('#work/'+approved.workId);
  await supervisor.text(status,'Pending Verification');
  await cert(supervisor,'close','现场独立验收通过。 Independent verification passed.');
  await supervisor.text(status,'Closed');
  await supervisor.route('#assets/item/'+equipment.asset);
  await supervisor.text('.trend-item','轴承温度');
  assert.equal(await supervisor.evaluate('document.querySelectorAll(".reading-trend circle").length'),2);
  await supervisor.fill('.language-control select','zh','change');
  await supervisor.text('.asset-summary h2','设备档案');
  await supervisor.snap('v21-asset-trends-zh');
  await supervisor.route('#reports');
  await supervisor.text('h1','报告');
  await supervisor.fill('[data-filter=reportKind]','work','change');
  await supervisor.fill('[data-filter=pdfLanguage]','both','change');
  await supervisor.click('button[data-action=pdf][data-id="'+approved.workId+'"]');
  await supervisor.text('#toast','PDF 报告已下载');
  const bilingualName='FieldProof-'+approved.workId+'.pdf';
  await waitFor(async()=>(await readdir(downloads)).includes(bilingualName),'bilingual PDF export');
  const bilingualPdf=(await readFile(join(downloads,bilingualName))).toString('latin1');
  const bilingual=unicodeText(bilingualPdf);
  for (const expected of ['Corrective action report / 整改报告','防护罩出现明显裂缝','Visible crack on the guard','更换了开裂的防护罩','Independent verification passed']) {
    assert.ok(bilingual.includes(expected),expected+' in bilingual PDF');
  }
  assert.match(bilingualPdf,/\/DCTDecode/);
  await supervisor.route('#work/'+firstOrder.id);
  await supervisor.text('.source-record','Bearing temperature');
  assert.equal(await supervisor.evaluate('document.querySelectorAll(".source-record").length'),2);
  await supervisor.snap('v21-linked-evidence');
  await admin.route('#settings');
  await admin.text('h1','Settings');
  await admin.fill('.language-control select','zh','change');
  await admin.text('h1','设置');
  await admin.click('[data-action=audit]');
  await admin.text('#dialog-title','工作区审计记录');
  await admin.text('#dialog-content','已保存巡检结果');
  for (const page of e2e) assert.deepEqual(page.errors,[]);
  console.log('PASS concurrent offline conflict recovery, one-use invitation, self-approval blocked in supervisor UI, and independent administrator closure');
  console.log('PASS numerical template and range checks, deduplication, offline fault with photo, supervisor assignment, trends, Chinese audit labels and language persistence, and bilingual Unicode PDF');
  console.log('QA downloads and isolated profiles:',temp);
} finally {
  await Promise.all(e2e.map(page=>page.close()));
  await server.close();
}
