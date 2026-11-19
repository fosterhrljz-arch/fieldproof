import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash,scrypt,timingSafeEqual,randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {mkdirSync,readFileSync,openSync,closeSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import './src/core.js';
import './src/operations.js';
import './src/storage.js';
import './src/team-policy.js';

FP.storage.channel?.close();
const {check,find,perform}=FP;
const {error,authorize,projection,basis,checkAssignment}=FP.team;
const root=dirname(fileURLToPath(import.meta.url));
const token=()=>randomBytes(32).toString('base64url');
const digest=value=>createHash('sha256').update(value).digest('hex');
const hashPassword=promisify(scrypt);
const lifetime=7*86400_000;
const offlineLifetime=3*86400_000;
const actionLimit=5*1024*1024;
const backupLimit=96*1024*1024;
const idPattern=/^[a-zA-Z0-9-]{1,159}$/;
const schema=`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  PRAGMA busy_timeout=5000;
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, password TEXT, invitation TEXT, invite_until INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, member TEXT NOT NULL REFERENCES members(id), expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, bytes BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS received (member TEXT NOT NULL, id TEXT NOT NULL, generation TEXT NOT NULL, hash TEXT NOT NULL,
    result TEXT NOT NULL, PRIMARY KEY(member,id,generation));
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS throttle (id TEXT PRIMARY KEY, hits INTEGER NOT NULL, until INTEGER NOT NULL);
`;
const staticFiles={'/':'index.html','/index.html':'index.html','/sw.js':'sw.js','/icon.svg':'icon.svg','/manifest.webmanifest':'manifest.webmanifest'};
const contentTypes={'index.html':'text/html; charset=utf-8','sw.js':'text/javascript; charset=utf-8','icon.svg':'image/svg+xml','manifest.webmanifest':'application/manifest+json'};

const fieldsByAction={
  place:['kind','parentId','name','notes'], asset:['name','tag','type','areaId','status','manufacturer','model','serial','notes'],
  template:['name','description','questions','archived'], inspection:['templateId','assetId','assigneeId','due'],
  reschedule:['assigneeId','due'], recurrence:['templateId','assetId','assigneeId','interval','start','paused'],
  work:['title','assetId','assigneeId','priority','due','description'], assign:['assigneeId','priority','due'],
  settings:['workspace','defaultAssignee','correctiveDays','responseHours'], result:['value','notes','photo','removePhoto','reading'],
  repairDraft:['notes','photo','removePhoto'], reject:['notes'], close:['notes'],submit:['decisions'],
  reportFault:['assetId','title','priority','notes','photo'],approveFault:['assigneeId','priority','due','notes','workId'],declineFault:['notes']
};
const checkId=(id,optional=false)=>check((optional&&id==='')||(typeof id==='string'&&idPattern.test(id)),'Invalid record identifier.');
function string(value,label,max=180) {
  check(typeof value==='string'&&value.length<=max,'Invalid '+label+'.');
  return value;
}
const emailValue=value=>{
  const email=string(value,'email address',254).trim().toLowerCase();
  check(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'Enter a valid email address.');
  return email;
};
const nameValue=value=>{
  const name=string(value,'name',100).trim();
  check(name,'Enter a full name.');
  return name;
};
const roleValue=value=>{
  check(FP.roles.includes(value),'Choose a role.');
  return value;
};
const passwordValue=value=>{
  check(typeof value==='string'&&value.length>=12&&value.length<=128,'Use a password with 12 to 128 characters.');
  return value;
};
async function passwordRecord(password) {
  const salt=randomBytes(16).toString('hex');
  const hash=await hashPassword(password,salt,64,{N:32768,maxmem:64*1024*1024});
  return salt+':'+hash.toString('hex');
}
async function checkPassword(password,record) {
  const [salt,hash]=record.split(':');
  const derived=await hashPassword(password,salt,64,{N:32768,maxmem:64*1024*1024});
  return timingSafeEqual(derived,Buffer.from(hash,'hex'));
}
const dummy='00000000000000000000000000000000:'+ '0'.repeat(128);
function jpegBytes(photo) {
  const src=string(photo.src,'photograph',4000000);
  check(/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(src),'Only JPEG evidence is accepted.');
  const bytes=Buffer.from(src.slice(23),'base64');
  for (let offset=2;offset+8<bytes.length;) {
    if (bytes[offset]!==0xff) break;
    const marker=bytes[offset+1];
    if (marker===0xff) {offset++;continue;}
    if (marker===0xd9||marker===0xda) break;
    const length=bytes.readUInt16BE(offset+2);
    if (length<2||offset+2+length>bytes.length) break;
    if ([0xc0,0xc1,0xc2].includes(marker)) {
      check(length>=8&&bytes.readUInt16BE(offset+5)===photo.h&&bytes.readUInt16BE(offset+7)===photo.w&&bytes[offset+9]===3,'Invalid JPEG dimensions or color format.');
      return bytes;
    }
    offset+=length+2;
  }
  throw error(400,'Invalid JPEG photograph.');
}
function photoValue(value) {
  check(value&&typeof value==='object','Invalid photograph.');
  const {id,name,at,w,h,src}=value;
  checkId(id);
  string(name,'photo filename',250);
  check(name&&Number.isFinite(Date.parse(at)),'Invalid photo metadata.');
  check([w,h].every(n=>Number.isInteger(n)&&n>0&&n<=1600),'Photographs must be 1,600 pixels or smaller.');
  const photo={id,name,at:new Date(at).toISOString(),w,h,src};
  jpegBytes(photo);
  return photo;
}
function parseAction(input) {
  check(input&&typeof input==='object'&&FP.team.actions.has(input.type),'Unknown workspace action.');
  const type=input.type;
  const id=input.id??'';
  checkId(id,true);
  if (type==='reportFault'||type==='readNotice') checkId(id);
  const questionId=input.questionId??'';
  checkId(questionId,true);
  const fields={};
  for (const key of fieldsByAction[type]||[]) {
    const value=input.fields?.[key];
    if (key==='questions') {
      check(Array.isArray(value)&&value.length<=40,'Add 1 to 40 checks.');
      fields.questions=value.map(q=>{
        check(q&&typeof q==='object','Invalid check.');
        const qid=q.id||'';
        checkId(qid,true);
        check(q.kind===undefined||['check','measurement'].includes(q.kind),'Select a valid check type.');
        const measurement=q.kind==='measurement'?FP.ops.questionFields(q):{};
        return {id:qid,label:string(q.label,'question'),criteria:string(q.criteria??'','pass criteria',550),priority:string(q.priority,'priority',25),...measurement};
      });
      const defined=fields.questions.filter(q=>q.id);
      check(new Set(defined.map(q=>q.id)).size===defined.length,'Question identifiers must be unique.');
    } else if (key==='responseHours') {
      if (value!==undefined) {
        check(value&&typeof value==='object'&&!Array.isArray(value),'Set a response target for each priority.');
        fields[key]=Object.fromEntries(FP.priorities.map(priority=>[priority,value[priority]]));
      }
    } else if (key==='decisions') {
      if (value!==undefined) {
        check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length<=40,'Invalid corrective action choices.');
        fields[key]=Object.fromEntries(Object.entries(value).map(([qid,choice])=>{
          checkId(qid);
          checkId(choice);
          return [qid,choice];
        }));
      }
    } else if (key==='reading') {
      if (value!==undefined) {
        check(value===null||FP.ops.validNumber(value),'Enter a finite numerical measurement.');
        fields[key]=value;
      }
    } else if (['archived','paused'].includes(key)) fields[key]=value===true || value==='on';
    else if (key==='correctiveDays') {
      check(value!==undefined&&value!==''&&Number.isInteger(+value)&&+value>=0&&+value<=365,'Choose a corrective due time from 0 to 365 days.');
      fields[key]=+value;
    } else if ((['result','repairDraft'].includes(type)||key==='photo') && value===undefined) continue;
    else if (key==='photo') fields[key]=photoValue(value);
    else {
      fields[key]=string(value??'',key,['notes','description'].includes(key)?4000:180);
      if (key.endsWith('Id')||key==='removePhoto') checkId(fields[key],true);
    }
  }
  if (['result','repairDraft'].includes(type)) check(Object.keys(fields).length>0,'No draft change was supplied.');
  return {type,id,questionId,fields};
}
function publicMember(member) {
  return {id:member.id,email:member.email,name:member.name,role:member.role,enabled:!!member.enabled,
    activated:!!member.password,invited:!member.password&&!!member.invitation&&member.invite_until>Date.now(),version:member.version};
}
async function jsonBody(request,limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type']||'')) throw error(415,'Send JSON.');
  if (+request.headers['content-length']>limit) throw error(413,'The request is too large.');
  let total=0;
  const chunks=[];
  for await (const chunk of request) {
    total+=chunk.length;
    if (total>limit) throw error(413,'The request is too large.');
    chunks.push(chunk);
  }
  try {
    const data=JSON.parse(Buffer.concat(chunks).toString());
    check(data&&typeof data==='object'&&!Array.isArray(data),'Invalid request body.');
    return data;
  } catch { throw error(400,'Invalid JSON request.'); }
}

export async function startFieldProof({host='127.0.0.1',port=8740,file=resolve(root,'team-data','fieldproof.sqlite'),origin='',setupCode=''}={}) {
  if (origin) {
    const provided=new URL(origin);
    check(provided.origin===origin&&provided.protocol==='https:','FIELDPROOF_ORIGIN must be an HTTPS origin without a trailing slash.');
  } else check(['127.0.0.1','::1','localhost'].includes(host),'Set FIELDPROOF_ORIGIN to the HTTPS address before enabling network access.');
  if (file!==':memory:') {
    mkdirSync(dirname(file),{recursive:true,mode:0o700});
    try { closeSync(openSync(file,'wx',0o600)); }
    catch (failure) { if (failure.code!=='EEXIST') throw failure; }
  }
  const db=new DatabaseSync(file);
  db.exec(schema);
  if (!db.prepare('PRAGMA table_info(members)').all().some(column=>column.name==='version')) {
    db.exec('ALTER TABLE members ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  }
  const stateRow=db.prepare('SELECT payload FROM workspace WHERE id=1');
  const storeState=db.prepare('INSERT INTO workspace VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
  const byEmail=db.prepare('SELECT * FROM members WHERE email=?');
  const byId=db.prepare('SELECT * FROM members WHERE id=?');
  const allMembers=()=>db.prepare('SELECT * FROM members ORDER BY name,id').all();
  const photoById=db.prepare('SELECT bytes FROM photos WHERE id=?');
  const auditAdd=db.prepare('INSERT INTO audit(at,actor,action,target,detail) VALUES (?,?,?,?,?)');
  const hasWorkspace=()=>Boolean(stateRow.get());
  const oneTimeSetup=hasWorkspace()?'':setupCode||token();
  if (oneTimeSetup) check(oneTimeSetup.length>=20&&oneTimeSetup.length<=128,'Set a server setup code with 20 to 128 characters.');
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result=fn(); db.exec('COMMIT'); return result; }
    catch (failure) { db.exec('ROLLBACK'); throw failure; }
  }
  function load() { return FP.ops.defaults(JSON.parse(stateRow.get().payload)); }
  function write(state) {
    state.revision++;
    storeState.run(JSON.stringify(state));
  }
  function memberState(state) {
    const map=new Map((state.people||[]).map(person=>[person.id,{...person,available:false}]));
    for (const user of allMembers()) map.set(user.id,{id:user.id,name:user.name,role:user.role,available:!!user.enabled&&!!user.password});
    state.people=[...map.values()];
    return state;
  }
  function summary(state,member,session) {
    return {state:{...projection(state,member),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone},account:{id:member.id,email:member.email,name:member.name,role:member.role},
      leaseUntil:Math.min(session.expires,Date.now()+offlineLifetime)};
  }
  const audit=(actor,action,target='',detail='',at=new Date().toISOString())=>auditAdd.run(at,actor,action,target,detail);
  function tick() {
    if (!hasWorkspace()) return;
    transaction(()=>{
      const state=load();
      const initial=state.inspections.length;
      const system=state.people.find(person=>person.role==='Admin'&&person.available!==false)||state.people[0];
      const count=perform(state,{type:'tick',actorId:system.id});
      if (count) {
        FP.ops.recordNotices(state,{type:'tick'},null,new Date().toISOString(),'system',{inspections:initial,work:state.work.length});
        write(state);
        for (const record of state.inspections.slice(initial)) audit('system','recurring-inspection',record.id,record.scheduleId);
      }
      db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
      db.prepare('DELETE FROM throttle WHERE until<=?').run(Date.now());
    });
  }
  let siteOrigin=origin;
  let inFlightHashes=0;
  async function limitedHash(fn) {
    if (inFlightHashes>=4) throw error(429,'Sign-in is busy. Try again in a moment.');
    inFlightHashes++;
    try { return await fn(); }
    finally { inFlightHashes--; }
  }
  const cookieName=()=>origin?'__Host-fieldproof':'fieldproof';
  const makeCookie=(value,maxAge)=>`${cookieName()}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin?'; Secure':''}`;
  const cookieValue=request=>(request.headers.cookie||'').split(';').map(t=>t.trim()).find(t=>t.startsWith(cookieName()+'='))?.slice(cookieName().length+1);
  const setSession=(response,user,request)=>{
    const previous=cookieValue(request);
    if (previous) db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(previous));
    const raw=token();
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(raw),user,Date.now()+lifetime);
    response.setHeader('Set-Cookie',makeCookie(raw,lifetime/1000));
  };
  function auth(request) {
    const raw=cookieValue(request);
    const session=raw&&db.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?').get(digest(raw),Date.now());
    const member=session&&byId.get(session.member);
    if (!member?.enabled || !member.password || (request.headers['x-fieldproof-account']&&request.headers['x-fieldproof-account']!==member.id)) {
      throw error(401,'Sign in as the account that owns these changes.');
    }
    return {member,session};
  }
  const admin=member=>{if (member.role!=='Admin') throw error(403,'An administrator is required.');};
  function limit(request,operation,email='') {
    const address=request.socket.remoteAddress||'';
    const now=Date.now();
    const read=db.prepare('SELECT * FROM throttle WHERE id=?');
    const set=db.prepare('INSERT INTO throttle VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET hits=excluded.hits,until=excluded.until');
    for (const [key,max] of [[operation+':ip:'+address,100],[operation+':target:'+email,12]]) {
      const last=read.get(key);
      if (last&&last.until>now&&last.hits>=max) throw error(429,'Too many attempts. Try again in 15 minutes.');
      set.run(key,last?.until>now?last.hits+1:1,last?.until>now?last.until:now+900000);
    }
  }
  function registerAction(command,member) {
    checkId(command.opId);
    checkId(command.generation);
    const action=parseAction(command.action);
    const guard=string(command.basis,'edit version',350000);
    const hash=digest(JSON.stringify([action,guard,command.localAt]));
    return transaction(()=>{
      const state=load();
      if (state.workspaceKey!==command.generation) throw error(409,'The workspace was restored. Export your unsynced changes before clearing them.');
      const received=db.prepare('SELECT * FROM received WHERE member=? AND id=? AND generation=?').get(member.id,command.opId,command.generation);
      if (received) {
        if (received.hash!==hash) throw error(409,'This operation identifier has already been used.');
        return {state,result:JSON.parse(received.result),duplicate:true};
      }
      authorize(state,action,member);
      checkAssignment(state,action);
      if (guard!==basis(state,action)) throw error(409,'Someone changed this record after you opened it. Review the server version before applying your change again.');
      const photo=action.fields.photo;
      if (photo&&find(state.evidence,photo.id)) throw error(409,'This photograph is already attached.');
      const before=new Set(state.evidence.map(meta=>meta.id));
      const at=new Date().toISOString();
      const previous={inspections:state.inspections.length,work:state.work.length,
        assigneeId:FP.find(action.type==='reschedule'?state.inspections:state.work,action.id)?.assigneeId};
      const result=perform(state,{...action,actorId:member.id},at)??null;
      if (action.type==='result') {
        const inspection=find(state.inspections,action.id);
        const result=inspection.results[action.questionId];
        const claimed=Date.parse(command.localAt);
        if ((action.fields.value||typeof action.fields.reading==='number')&&Number.isFinite(claimed)&&claimed<=Date.now()+60000&&claimed>=Date.now()-lifetime) {
          result.capturedAt=new Date(claimed).toISOString();
        }
      }
      if (photo) db.prepare('INSERT INTO photos VALUES (?,?)').run(photo.id,jpegBytes(photo));
      if (action.fields.removePhoto&&before.has(action.fields.removePhoto)&&!find(state.evidence,action.fields.removePhoto)) {
        db.prepare('DELETE FROM photos WHERE id=?').run(action.fields.removePhoto);
      }
      FP.ops.recordNotices(state,action,result,at,member.id,previous);
      write(state);
      db.prepare('INSERT INTO received VALUES (?,?,?,?,?)').run(member.id,command.opId,state.workspaceKey,hash,JSON.stringify(result));
      const detail=action.type==='submit'?JSON.stringify(result):action.questionId?JSON.stringify({question:action.questionId,fields:Object.keys(action.fields)}):'';
      audit(member.id,action.type,action.id||(typeof result==='string'?result:''),detail,at);
      return {state,result,duplicate:false};
    });
  }
  function restoreRecords(backup,member,expected) {
    check(backup?.format==='FieldProof backup'&&backup.version===1,'Choose a FieldProof backup.');
    FP.storage.validate(backup.state,backup.images);
    for (const photo of backup.images) jpegBytes(photoValue(photo));
    return transaction(()=>{
      const current=load();
      if (current.revision!==expected) throw error(409,'Records changed after you reviewed the backup. Load it again before restoring.');
      const imported=structuredClone(backup.state);
      const actual=allMembers();
      const existing=new Set(actual.map(person=>person.id));
      const matches=new Map();
      if (Array.isArray(backup.members)) for (const entry of backup.members) {
        const account=actual.find(person=>person.email===entry?.email);
        if (account&&typeof entry.id==='string'&&!existing.has(entry.id)) matches.set(entry.id,account.id);
      }
      const map=id=>matches.get(id)||id;
      const attribution=event=>{event.actorId=map(event.actorId);};
      const owner=record=>{record.assigneeId=map(record.assigneeId);};
      imported.people=imported.people.filter(person=>!matches.has(person.id)).map(({id,name,role})=>({id,name,role,available:false}));
      imported.settings.defaultAssignee=map(imported.settings.defaultAssignee);
      for (const inspection of imported.inspections) {
        owner(inspection);
        inspection.submittedBy=map(inspection.submittedBy);
        for (const check of Object.values(inspection.results)) if (check.recordedBy) check.recordedBy=map(check.recordedBy);
      }
      for (const asset of imported.assets) asset.changes.forEach(attribution);
      imported.schedules.forEach(owner);
      for (const order of imported.work) {
        owner(order);
        order.history.forEach(attribution);
        (order.sources||[]).forEach(attribution);
        for (const repair of [...order.repairs,order.draft]) {
          if (repair.actorId) attribution(repair);
          if (repair.contributors) repair.contributors=repair.contributors.map(map);
        }
      }
      for (const fault of imported.faults||[]) {
        fault.reporterId=map(fault.reporterId);
        fault.reviewedBy=map(fault.reviewedBy);
      }
      imported.notices=[];
      imported.noticeReads={};
      imported.activeId=member.id;
      imported.workspaceKey=randomUUID();
      imported.team=true;
      imported.revision=current.revision;
      delete imported.pendingSubmissions;
      delete imported.timeZone;
      memberState(imported);
      FP.storage.validate(imported,backup.images);
      db.exec('DELETE FROM photos; DELETE FROM received;');
      const photoPut=db.prepare('INSERT INTO photos VALUES (?,?)');
      for (const photo of backup.images) photoPut.run(photo.id,jpegBytes(photo));
      write(imported);
      audit(member.id,'workspace-restore',imported.workspaceKey,backup.exportedAt||'');
      return imported;
    });
  }
  function imageWithBytes(meta) {
    const stored=photoById.get(meta.id);
    if (!stored) throw error(500,'Evidence is missing from server storage.');
    return {...meta,src:'data:image/jpeg;base64,'+Buffer.from(stored.bytes).toString('base64')};
  }

  const reply=(response,value,status=200)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify(value));};
  async function handler(request,response) {
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('X-Frame-Options','DENY');
    response.setHeader('Cache-Control','no-store');
    if (origin) response.setHeader('Strict-Transport-Security','max-age=31536000');
    const path=new URL(request.url,'http://localhost').pathname;
    const method=request.method;
    if (method==='GET'&&Object.hasOwn(staticFiles,path)) {
      const name=staticFiles[path];
      response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      return response.writeHead(200,{'Content-Type':contentTypes[name]}).end(readFileSync(resolve(root,'team-dist',name)));
    }
    if (method==='GET'&&['/app.js','/style.css','/fonts/NotoSansSC-Regular.ttf'].includes(path)) {
      const name=path.slice(1);
      const type=name.endsWith('.ttf')?'font/ttf':name==='app.js'?'text/javascript; charset=utf-8':'text/css; charset=utf-8';
      return response.writeHead(200,{'Content-Type':type}).end(readFileSync(resolve(root,'team-dist',name)));
    }
    if (!path.startsWith('/api/')) throw error(404,'Page not found.');
    if (method==='POST'&&request.headers.origin!==siteOrigin) throw error(403,'The request origin does not match the FieldProof server address.');
    if (method==='GET'&&path==='/api/start') return reply(response,{setup:!hasWorkspace()});
    if (method==='POST'&&['/api/setup','/api/login','/api/activate'].includes(path)) {
      const data=await jsonBody(request,16384);
      const email=emailValue(data.email);
      limit(request,path,email);
      if (path==='/api/setup') {
        const code=string(data.code,'setup code',128);
        if (!oneTimeSetup||hasWorkspace()||digest(code)!==digest(oneTimeSetup)) throw error(403,'Setup code is invalid or the workspace already exists.');
        const name=nameValue(data.name);
        const workspace=nameValue(data.workspace);
        const hash=await limitedHash(()=>passwordRecord(passwordValue(data.password)));
        const id=randomUUID();
        transaction(()=>{
          if (hasWorkspace()) throw error(409,'The workspace already exists.');
          db.prepare('INSERT INTO members(id,email,name,role,password) VALUES (?,?,?,?,?)').run(id,email,name,'Admin',hash);
          const state={...FP.empty(),activeId:id,workspace,workspaceKey:randomUUID(),team:true,people:[]};
          write(memberState(state));
          audit(id,'workspace-setup',state.workspaceKey);
          setSession(response,id,request);
        });
        return reply(response,{ok:true});
      }
      const user=byEmail.get(email);
      if (path==='/api/login') {
        const valid=await limitedHash(()=>checkPassword(string(data.password,'password',128),user?.password||dummy));
        const current=user&&byId.get(user.id);
        if (!valid||!current?.enabled||!current.password||current.password!==user.password) throw error(401,'Email or password is incorrect, or the account is inactive.');
        transaction(()=>{setSession(response,user.id,request);audit(user.id,'sign-in',user.id);});
      } else {
        const invitation=digest(string(data.code,'activation code',128));
        if (!user?.enabled||user.password||user.invitation!==invitation||user.invite_until<=Date.now()) throw error(403,'Activation code is invalid or expired.');
        const hash=await limitedHash(()=>passwordRecord(passwordValue(data.password)));
        transaction(()=>{
          const updated=db.prepare('UPDATE members SET password=?,invitation=NULL,invite_until=NULL,version=version+1 WHERE id=? AND enabled=1 AND password IS NULL AND invitation=? AND invite_until>?')
            .run(hash,user.id,invitation,Date.now());
          if (!updated.changes) throw error(409,'The activation code is no longer available.');
          write(memberState(load()));
          audit(user.id,'account-activated',user.id);
          setSession(response,user.id,request);
        });
      }
      return reply(response,{ok:true});
    }
    const {member,session}=auth(request);
    if (method==='GET'&&path==='/api/workspace') {
      const state=load();
      const tag='"'+state.workspaceKey+'-'+state.revision+'-'+member.id+'-'+Math.floor(Date.now()/30000)+'"';
      response.setHeader('ETag',tag);
      if (request.headers['if-none-match']===tag) return response.writeHead(304).end();
      return reply(response,summary(state,member,session));
    }
    if (method==='GET'&&path.startsWith('/api/photos/')) {
      const id=path.slice('/api/photos/'.length);
      checkId(id);
      const photo=find(projection(load(),member).evidence,id);
      if (!photo) throw error(404,'This photograph is unavailable.');
      return reply(response,imageWithBytes(photo));
    }
    if (method==='POST'&&path==='/api/actions') {
      const command=await jsonBody(request,actionLimit);
      const fresh=auth(request);
      const outcome=registerAction(command,fresh.member);
      return reply(response,{...summary(outcome.state,fresh.member,fresh.session),result:outcome.result,duplicate:outcome.duplicate});
    }
    if (method==='POST'&&path==='/api/logout') {
      db.prepare('DELETE FROM sessions WHERE hash=?').run(session.hash);
      response.setHeader('Set-Cookie',makeCookie('',0));
      return reply(response,{ok:true});
    }
    if (method==='POST'&&path==='/api/password') {
      const data=await jsonBody(request,16384);
      limit(request,path,member.email);
      if (!await limitedHash(()=>checkPassword(string(data.current,'current password',128),member.password))) throw error(403,'Current password is incorrect.');
      const hash=await limitedHash(()=>passwordRecord(passwordValue(data.password)));
      transaction(()=>{
        if (auth(request).member.password!==member.password) throw error(409,'The password changed during this request.');
        db.prepare('UPDATE members SET password=? WHERE id=?').run(hash,member.id);
        db.prepare('DELETE FROM sessions WHERE member=?').run(member.id);
        setSession(response,member.id,request);
        audit(member.id,'password-changed',member.id);
      });
      return reply(response,{ok:true});
    }
    admin(member);
    if (method==='GET'&&path==='/api/members') return reply(response,allMembers().map(publicMember));
    if (method==='GET'&&path==='/api/audit') {
      return reply(response,db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all());
    }
    if (method==='POST'&&path==='/api/members') {
      const data=await jsonBody(request,16384);
      const fresh=auth(request).member;
      admin(fresh);
      const outcome=transaction(()=>{
        const role=roleValue(data.role);
        const name=nameValue(data.name);
        const code=token();
        const until=Date.now()+offlineLifetime;
        let id;
        if (data.id) {
          checkId(data.id);
          const user=byId.get(data.id);
          if (!user||user.version!==data.version) throw error(409,'This member changed. Reopen their record and try again.');
          check(typeof data.enabled==='boolean','Choose an account status.');
          if (user.role==='Admin'&&user.enabled&&(!data.enabled||role!=='Admin')) {
            check(allMembers().some(other=>other.id!==user.id&&other.role==='Admin'&&other.enabled&&other.password),'Keep at least one active administrator.');
          }
          if (data.reissue&&user.role==='Admin'&&user.password) {
            check(allMembers().some(other=>other.id!==user.id&&other.role==='Admin'&&other.enabled&&other.password),'Keep another active administrator before resetting this password.');
          }
          check(!(data.reissue&&!data.enabled),'Enable this account before issuing a code.');
          db.prepare('UPDATE members SET name=?,role=?,enabled=?,password=?,invitation=?,invite_until=?,version=version+1 WHERE id=?')
            .run(name,role,+data.enabled,data.reissue?null:user.password,data.reissue?digest(code):user.invitation,data.reissue?until:user.invite_until,user.id);
          if (!data.enabled||data.reissue) db.prepare('DELETE FROM sessions WHERE member=?').run(user.id);
          id=user.id;
        } else {
          const email=emailValue(data.email);
          if (byEmail.get(email)) throw error(409,'This email already has an account.');
          id=randomUUID();
          db.prepare('INSERT INTO members(id,email,name,role,invitation,invite_until) VALUES (?,?,?,?,?,?)')
            .run(id,email,name,role,digest(code),until);
        }
        write(memberState(load()));
        audit(fresh.id,data.id?'account-updated':'account-invited',id,role);
        return {member:publicMember(byId.get(id)),code:!data.id||data.reissue?code:''};
      });
      return reply(response,outcome);
    }
    if (method==='GET'&&path==='/api/backup') {
      const backup=transaction(()=>{
        const state=load();
        state.activeId=member.id;
        return {format:'FieldProof backup',version:1,exportedAt:new Date().toISOString(),state,
          images:state.evidence.map(imageWithBytes),members:allMembers().map(({id,email})=>({id,email}))};
      });
      return reply(response,backup);
    }
    if (method==='POST'&&path==='/api/restore') {
      const data=await jsonBody(request,backupLimit);
      const fresh=auth(request);
      admin(fresh.member);
      return reply(response,summary(restoreRecords(data.backup,fresh.member,data.revision),fresh.member,fresh.session));
    }
    throw error(404,'Operation not found.');
  }

  tick();
  let previousDay=FP.localDay();
  const timer=setInterval(()=>{
    const day=FP.localDay();
    if (day===previousDay) return;
    try {tick();previousDay=day;} catch (failure) {console.error('FieldProof schedule tick failed.',failure.message);}
  },30000);
  timer.unref();
  const server=createServer((request,response)=>{
    handler(request,response).catch(failure=>{
      if (response.headersSent||response.destroyed) return;
      const unexpected=failure.code?.startsWith('SQLITE')||failure instanceof TypeError||failure.code==='ENOENT';
      if (unexpected) console.error('FieldProof request failed.',failure.message);
      reply(response,{error:unexpected?'The server could not complete this request. Try again or contact your administrator.':failure.message},failure.status||(unexpected?500:400));
    });
  });
  server.requestTimeout=120000;
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,host,done);});
  siteOrigin ||= 'http://'+(host==='::1'?'[::1]':host)+':'+server.address().port;
  return {origin:siteOrigin,setupCode:oneTimeSetup,server,close:async()=>{
    clearInterval(timer);
    await new Promise((done,reject)=>server.close(err=>err?reject(err):done()));
    db.close();
  }};
}

if (process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  if (process.env.FIELDPROOF_TIME_ZONE) {
    new Intl.DateTimeFormat('en',{timeZone:process.env.FIELDPROOF_TIME_ZONE});
    process.env.TZ=process.env.FIELDPROOF_TIME_ZONE;
  }
  const app=await startFieldProof({host:process.env.FIELDPROOF_BIND||'127.0.0.1',
    port:+(process.env.FIELDPROOF_PORT||8740),file:process.env.FIELDPROOF_DB?resolve(process.env.FIELDPROOF_DB):undefined,
    origin:process.env.FIELDPROOF_ORIGIN||'',setupCode:process.env.FIELDPROOF_SETUP_CODE||''});
  console.log('FieldProof is listening at '+app.origin);
  if (app.setupCode) console.log('First launch only. Enter this setup code on the browser setup screen: '+app.setupCode);
}
