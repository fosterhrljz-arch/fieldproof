import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';

const root=fileURLToPath(new URL('../',import.meta.url));
const temp=await mkdtemp(join(tmpdir(),'fieldproof-qa-'));
const downloads=join(temp,'downloads');
await mkdir(downloads);
const chrome=process.env.FIELDPROOF_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const fileMode=process.argv.includes('--file');
const evidence=resolve(root,'src/demo-pump.jpg');
const repairPhoto=resolve(root,'tests/pump-after-repair.jpg');
const requestTypes={'index.html':'text/html','sw.js':'text/javascript','icon.svg':'image/svg+xml','manifest.webmanifest':'application/manifest+json'};
const server=createServer(async(request,response)=>{
  const pathname=new URL(request.url,'http://localhost').pathname;
  const name=pathname.slice(1)||'index.html';
  if (!Object.hasOwn(requestTypes,name)) {response.writeHead(404); response.end(); return;}
  try {
    const data=await readFile(resolve(root,'dist',name));
    response.writeHead(200,{'Content-Type':requestTypes[name]});
    response.end(data);
  } catch {response.writeHead(500);response.end();}
});
if (!fileMode) {
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
}
const origin=fileMode?pathToFileURL(resolve(root,'FieldProof.html')).href:'http://127.0.0.1:'+server.address().port+'/';

async function waitFor(check,label) {
  const stop=Date.now()+12000;
  let value;
  while (Date.now()<stop) {
    value=await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error('Timed out waiting for '+label);
}

async function launch() {
  const process = spawn(chrome,['--headless=new','--remote-debugging-pipe','--disable-background-networking','--no-first-run',
    '--no-default-browser-check','--no-proxy-server','--user-data-dir='+join(temp,'profile'),'about:blank'],
  {stdio:['ignore','ignore','pipe','pipe','pipe'],windowsHide:true});
  const commands=new Map();
  const errors=[];
  let counter=0, buffer='', sessionId, stderr='';
  process.stderr.on('data',chunk=>stderr=(stderr+chunk.toString()).slice(-3000));
  process.on('error',error=>commands.forEach(item=>item.reject(error)));
  process.on('exit',(code)=>commands.forEach(item=>item.reject(new Error('Chromium exited '+code+' '+stderr))));
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
      if (message.method==='Log.entryAdded' && message.params.entry.level==='error' &&
        !message.params.entry.text.includes('net::ERR_INTERNET_DISCONNECTED')) errors.push(message.params.entry.text);
    }
  });
  const send=(method,params={},outer=false)=>new Promise((resolve,reject)=>{
    const id=++counter;
    commands.set(id,{resolve,reject});
    process.stdio[3].write(JSON.stringify({id,method,params,...(sessionId&&!outer?{sessionId}:{})})+'\0');
  });
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  ({sessionId}=await send('Target.attachToTarget',{targetId,flatten:true}));
  for (const domain of ['Page','Runtime','Log','DOM','Network']) await send(domain+'.enable');
  await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads},true);
  const evaluate=async expression=>{
    const data=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if (data.exceptionDetails) throw new Error(data.exceptionDetails.exception?.description||data.exceptionDetails.text);
    return data.result.value;
  };
  const query=selector=>'document.querySelector('+JSON.stringify(selector)+')';
  const click=selector=>evaluate(query(selector)+'.click()');
  const fill=(selector,value,event='input')=>evaluate(`(()=>{ const el=${query(selector)}; el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true})); })()`);
  const text=(selector,expected)=>waitFor(()=>evaluate(`${query(selector)}?.textContent?.includes(${JSON.stringify(expected)})`),selector+' containing '+expected);
  const visible=selector=>waitFor(()=>evaluate(`Boolean(${query(selector)})`),selector);
  const route=async hash=>{
    await evaluate('location.hash='+JSON.stringify(hash));
  };
  const navigate=async hash=>{
    await send('Page.navigate',{url:origin+hash});
    await waitFor(async()=>{
      try {return evaluate('Boolean(document.querySelector("#main"))');}
      catch {return false;}
    },'workspace to load');
  };
  const viewport=(width,height,mobile=false)=>send('Emulation.setDeviceMetricsOverride',{width,height,mobile,deviceScaleFactor:1});
  const snap=async name=>{
    const shot=await send('Page.captureScreenshot',{format:'png',fromSurface:true});
    await writeFile(resolve(root,'screenshots',name+'.png'),Buffer.from(shot.data,'base64'));
  };
  const attach=async(selector,path)=>{
    const {root:doc}=await send('DOM.getDocument');
    const {nodeId}=await send('DOM.querySelector',{nodeId:doc.nodeId,selector});
    assert.ok(nodeId);
    await send('DOM.setFileInputFiles',{nodeId,files:[path]});
  };
  async function close() {
    const closed = new Promise(done=>process.once('close',done));
    await send('Browser.close',{},true).catch(()=>{});
    await closed;
  }
  return {send,evaluate,click,fill,text,visible,route,navigate,viewport,snap,attach,close,errors};
}

const inspection='#inspections/run/IN-1021';
const draftPhoto='.check-card img[data-photo]';
const saveDraft='[data-action="save-draft"]';
const requestReview='[data-action="request-review"]';
const formSubmit='dialog button[type="submit"]';
let app;
try {
  app=await launch();
  await app.viewport(1440,1000);
  await app.navigate('#dashboard');
  await app.text('h1','Operations overview');
  assert.match(await app.evaluate('document.title'),/^FieldProof/);
  assert.equal(await app.evaluate('location.href'),origin+'#dashboard');
  assert.deepEqual(await app.evaluate('[...document.querySelectorAll(".metric strong")].map(node=>node.textContent)'),['71%','12','4','9']);
  if (!fileMode) await waitFor(()=>app.evaluate('navigator.serviceWorker.controller !== null'),'active offline shell');
  if (!fileMode) await app.snap('dashboard');
  await app.fill('[data-filter="site"]','harbor','change');
  const siteOpen=await app.evaluate('document.querySelectorAll(".metric strong")[1].textContent');
  assert.ok(+siteOpen>0 && +siteOpen<12);
  await app.fill('[data-filter="site"]','','change');
  await app.route('#inspections');
  await app.text('h1','Inspections');
  await app.fill('[data-filter="inspectionStatus"]','Draft','change');
  await app.click('a[href="'+inspection+'"]');
  await app.text('#check-progress','1 of 3');
  await waitFor(()=>app.evaluate(`!!document.querySelector('${draftPhoto}')?.naturalWidth`),'demo evidence');
  await app.viewport(390,844,true);
  assert.equal(await app.evaluate('document.documentElement.scrollWidth === window.innerWidth'),true);
  await app.evaluate('document.activeElement.blur(); window.scrollTo(0,0)');
  await waitFor(()=>app.evaluate('document.querySelector(".sidebar").getBoundingClientRect().right <= 0'),'mobile navigation fully concealed');
  if (!fileMode) await app.snap('inspection-mobile');
  await app.click('[data-action="submit"]');
  await app.text('#toast','Choose Pass or Fail');
  await app.click('[data-question="noise"][data-value="Pass"]');
  await app.text('#check-progress','2 of 3');
  await app.fill('textarea[data-question="noise"]','Even vibration and normal motor noise.');
  const inCheck='input[data-photo-input][data-question="noise"]';
  await app.attach(inCheck,evidence);
  await app.text('#toast','1 photo saved');
  await app.click(saveDraft);
  await app.text('#toast','draft saved');
  assert.deepEqual(app.errors,[]);
  await app.close();
  app=null;
  console.log('PASS first launch, verified metrics, mobile layout, checklist validation, and saved photo draft');

  app=await launch();
  await app.viewport(1440,1000);
  await app.navigate(inspection);
  await app.text('#check-progress','2 of 3');
  assert.equal(await app.evaluate('document.querySelector("textarea[data-question=noise]").value'),'Even vibration and normal motor noise.');
  assert.equal(await app.evaluate('document.querySelectorAll(".check-card img[data-photo]").length'),2);
  if (!fileMode) {
    await app.evaluate('window.qaBeforeReload = true');
    await app.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    await app.send('Page.reload');
    await waitFor(()=>app.evaluate('!window.qaBeforeReload && !navigator.onLine && !!document.querySelector("#check-progress")').catch(()=>false),'offline page reload');
  }
  await app.visible('[data-action="remove-photo"][data-question="noise"]');
  await app.click('[data-action="remove-photo"][data-question="noise"]');
  await app.text('#toast','Photo removed');
  await app.click('[data-question="pressure"][data-value="Pass"]');
  await app.text('#check-progress','3 of 3');
  await app.click('[data-action="submit"]');
  await app.text('#toast','1 corrective work order created');
  const workHref=await app.evaluate('document.querySelector(".linked-record a").getAttribute("href")');
  assert.match(workHref,/^#work\/WO-/);
  await app.click('.linked-record a');
  await app.text('.work-detail .pane-head h2','Correct: Check pump seal for leaks');
  const switchTo=async id=>{
    await app.click('[data-action="profile"]');
    await app.visible('dialog[open] select[name=profile]');
    await app.fill('dialog select[name=profile]',id,'change');
    await app.click(formSubmit);
    await waitFor(()=>app.evaluate('!document.querySelector("dialog").open'),'profile switch');
  };
  await switchTo('maya');
  await app.click('[data-action="start-work"]');
  await app.text('.work-detail .pane-head .tag','In Progress');
  await app.fill('textarea[data-kind="work"]','Replaced shaft seal. Static pressure check held.');
  await app.attach('input[data-photo-input][data-kind="work"]',repairPhoto);
  await app.text('#toast','1 photo saved');
  await app.click(requestReview);
  await app.text('.work-detail .pane-head .tag','Pending Verification');
  assert.equal(await app.evaluate('!document.querySelector("[data-value=close]")'),true);
  await switchTo('morgan');
  if (!fileMode) {
    await waitFor(()=>app.evaluate('document.querySelector("#toast").hidden && [...document.querySelectorAll(".evidence-grid img")].every(img => img.naturalWidth)'),'verification evidence to render');
    await app.snap('verification');
  }
  await app.click('[data-value="reject"]');
  await app.visible('dialog[open] textarea');
  await app.fill('dialog textarea','Repeat the operating check with circulation running for 30 minutes.');
  await app.click(formSubmit);
  await app.text('.work-detail .pane-head .tag','In Progress');
  await app.text('.timeline','Repair returned for rework');
  await switchTo('maya');
  await app.fill('textarea[data-kind="work"]','Dry after 30 minutes at 54 psi. No seepage at the flange.');
  await app.attach('input[data-photo-input][data-kind="work"]',repairPhoto);
  await app.text('#toast','1 photo saved');
  await app.click(requestReview);
  await app.text('.work-detail .pane-head .tag','Pending Verification');
  await switchTo('morgan');
  await app.click('[data-value="close"]');
  await app.visible('dialog[open] textarea');
  await app.fill('dialog textarea','Verified at the pump. Seal and base were dry.');
  await app.click(formSubmit);
  await app.text('.work-detail .pane-head .tag','Closed');
  await app.text('.timeline','Repair verified and closed');
  assert.equal(await app.evaluate('document.querySelectorAll(".repair").length'),2);
  await app.click('.facts a[href="#assets/item/pump"]');
  await app.text('h1','Domestic Water Pump P-01');
  await app.visible('a[href="'+workHref+'"]');
  await app.route('#dashboard');
  await app.text('h1','Operations overview');
  assert.deepEqual(await app.evaluate('[...document.querySelectorAll(".metric strong")].map(node=>node.textContent)'),['79%','12','4','10']);
  console.log('PASS browser restart, offline workflow, linked action, rejection and resubmission, verification, asset history, and reconciled analytics');

  await app.route('#reports');
  await app.text('h1','Reports');
  await app.click('button[data-kind="inspection"][data-id="IN-1021"]');
  const workId=workHref.split('/').at(-1);
  await app.fill('[data-filter="reportKind"]','work','change');
  await app.click('button[data-kind="work"][data-id="'+workId+'"]');
  const wanted=['FieldProof-IN-1021.pdf','FieldProof-'+workId+'.pdf'];
  await waitFor(async()=>{
    const files=await readdir(downloads);
    return wanted.every(name=>files.includes(name));
  },'two PDF downloads');
  for (const name of wanted) {
    const pdf=await readFile(join(downloads,name));
    assert.ok(pdf.subarray(0,8).equals(Buffer.from('%PDF-1.4')));
    assert.match(pdf.toString('latin1'),/\/DCTDecode/);
  }
  await app.route('#settings');
  await app.text('h1','Settings');
  await app.click('[data-action="backup"]');
  const backupName=await waitFor(async()=>(await readdir(downloads)).find(name=>name.endsWith('.json')),'backup download');
  const backup=JSON.parse(await readFile(join(downloads,backupName),'utf8'));
  assert.equal(backup.images.length,3);
  assert.equal(backup.state.work.find(item=>item.id===workId).status,'Closed');
  await app.click('[data-action="reset"]');
  await app.visible('dialog[open] form[data-form=reset]');
  await app.click(formSubmit);
  await app.text('#toast','Blank workspace created');
  await app.click('[data-action="restore"]');
  await app.visible('#backup-file');
  await app.attach('#backup-file',join(downloads,backupName));
  await app.text('#dialog-title','Confirm backup restore');
  await app.click(formSubmit);
  await app.text('#toast','Backup restored');
  await app.route(workHref);
  await app.text('.work-detail .pane-head .tag','Closed');
  assert.equal(await app.evaluate('document.querySelectorAll(".photos img").length'),3);
  await app.route('#assets');
  await app.text('h1','Sites & Assets');
  const addPlace=async(name,kind)=>{
    await app.click('.page-head [data-action="place"]');
    await app.visible('dialog[open] input[name=name]');
    assert.equal(await app.evaluate('document.querySelector("dialog [name=kind]").value'),kind);
    await app.fill('dialog input[name=name]',name);
    await app.click(formSubmit);
    await app.text('.site-split section h2',name);
  };
  await addPlace('Maple Terrace','Site');
  await addPlace('East Building','Building');
  await addPlace('Utility Room','Area');
  await app.click('.page-head [data-action="asset"]');
  await app.visible('dialog[open] input[name=tag]');
  await app.fill('dialog input[name=name]','Transfer pump P-03');
  await app.fill('dialog input[name=tag]','PMP-003');
  await app.fill('dialog input[name=type]','Transfer pump');
  await app.click(formSubmit);
  await app.text('h1','Transfer pump P-03');
  const addedAsset=await app.evaluate('location.hash.split("/").at(-1)');
  await app.route('#inspections/templates');
  await app.visible('[data-action="template"]:not([data-id])');
  await app.click('[data-action="template"]:not([data-id])');
  await app.visible('dialog[open] input[name=question]');
  await app.fill('dialog input[name=name]','Transfer pump checks');
  await app.fill('dialog input[name=question]','Verify pressure');
  await app.fill('dialog textarea[name=criteria]','Pressure is between 48 and 58 psi.');
  await app.click('[data-action="add-question"]');
  await app.fill('dialog fieldset:nth-child(2) input[name=question]','Inspect coupling guard');
  await app.fill('dialog fieldset:nth-child(2) textarea[name=criteria]','Guard installed and fasteners secure.');
  await app.click(formSubmit);
  await app.text('tbody','Transfer pump checks');
  const addedTemplate=await app.evaluate('[...document.querySelectorAll("tbody tr")].find(row=>row.textContent.includes("Transfer pump checks")).querySelector("[data-action=template]").dataset.id');
  await app.route('#inspections/recurring');
  await app.visible('.page-head [data-action="recurrence"]');
  await app.click('.page-head [data-action="recurrence"]');
  await app.visible('dialog[open] select[name=assetId]');
  await app.fill('dialog select[name=templateId]',addedTemplate,'change');
  await app.fill('dialog select[name=assetId]',addedAsset,'change');
  await app.fill('dialog select[name=assigneeId]','jordan','change');
  await app.click(formSubmit);
  await app.text('tbody','Transfer pump checks');
  await app.evaluate('[...document.querySelectorAll("tbody tr")].find(row=>row.textContent.includes("Transfer pump checks")).querySelector("[data-action=pause]").click()');
  await app.text('#toast','Recurring schedule paused');
  await app.route('#inspections');
  await app.visible('[data-search="inspectionQuery"]');
  await app.fill('[data-filter="inspectionStatus"]','','change');
  await app.fill('[data-search="inspectionQuery"]','Transfer pump checks');
  assert.equal(await app.evaluate('document.querySelectorAll("tbody tr").length'),3);
  await app.route('#work');
  await app.visible('.page-head [data-action="new-work"]');
  await app.click('.page-head [data-action="new-work"]');
  await app.visible('dialog[open] input[name=title]');
  await app.fill('dialog input[name=title]','Replace transfer pump guard fasteners');
  await app.fill('dialog select[name=assetId]',addedAsset,'change');
  await app.click(formSubmit);
  await app.text('.work-detail .pane-head h2','Replace transfer pump guard fasteners');
  assert.deepEqual(app.errors,[]);
  console.log('PASS PDF downloads, export and restore including photos, site hierarchy, asset registration, template editor, recurring schedule, standalone work order, and zero application console errors');
  console.log('QA downloads:',downloads);
} finally {
  if (app) await app.close();
  if (!fileMode) server.close();
}
