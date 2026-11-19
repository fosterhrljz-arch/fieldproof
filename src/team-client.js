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
