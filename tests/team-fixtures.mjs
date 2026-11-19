import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export const testPassword='test-only-long-password!';
export const setupCode='test-only-workspace-setup-code';
export const people={
  admin:{name:'Morgan Reed',email:'morgan@example.test'},
  inspector:{name:'Jordan Carter',email:'jordan@example.test',role:'Inspector'},
  technician:{name:'Maya Rivera',email:'maya@example.test',role:'Maintenance'},
  supervisor:{name:'Sam Patel',email:'sam@example.test',role:'Supervisor'},
  unrelated:{name:'Lin Chen',email:'lin@example.test',role:'Inspector'}
};
export function api(origin) {
  let cookie='';
  return async (path,data,allowed=200,headers={})=>{
    const response=await fetch(origin+'/api/'+path,{method:data===undefined?'GET':'POST',
      headers:{cookie,origin,connection:'close',...(data===undefined?{}:{'Content-Type':'application/json'}),...headers},
      body:data===undefined?undefined:JSON.stringify(data)});
    const replacement=response.headers.get('set-cookie');
    if (replacement) cookie=replacement.split(';')[0];
    const result=await response.json();
    assert.equal(response.status,allowed,JSON.stringify(result).slice(0,250));
    return result;
  };
}
export async function createTeam(origin) {
  const admin=api(origin);
  await admin('setup',{...people.admin,workspace:'Harborstone Facilities',code:setupCode,password:testPassword});
  const profiles={admin};
  const members={admin:(await admin('workspace')).account.id};
  for (const role of Object.keys(people).filter(key=>key!=='admin')) {
    const identity=people[role];
    const invitation=await admin('members',identity);
    assert.ok(invitation.code);
    members[role]=invitation.member.id;
    profiles[role]=api(origin);
    await profiles[role]('activate',{email:identity.email,password:testPassword,code:invitation.code});
  }
  return {profiles,members};
}
export const envelope=(state,action)=>({generation:state.workspaceKey,opId:randomUUID(),basis:FP.team.basis(state,action),action,localAt:new Date().toISOString()});
export async function act(client,action,status=200) {
  const {state}=await client('workspace');
  return client('actions',envelope(state,action),status);
}
export async function createEquipment(admin,members) {
  const {result:site}=await act(admin,{type:'place',fields:{kind:'Site',name:'Harborstone Commons',notes:'120 Harborview Avenue'}});
  const {result:building}=await act(admin,{type:'place',fields:{kind:'Building',name:'Building A',parentId:site}});
  const {result:area}=await act(admin,{type:'place',fields:{kind:'Area',name:'Mechanical Room',parentId:building}});
  const {result:asset}=await act(admin,{type:'asset',fields:{name:'Domestic Water Pump P-01',tag:'PMP-001',type:'Water pump',areaId:area,status:'In service',manufacturer:'Grundfos'}});
  const {result:template}=await act(admin,{type:'template',fields:{name:'Water pump inspection',description:'Routine circulation pump checks.',questions:[
    {label:'Check pump seal for leaks',criteria:'The shaft seal and pump base are dry.',priority:'High'},
    {label:'Check operating pressure',criteria:'Discharge pressure is between 45 and 65 psi.',priority:'Medium'},
    {label:'Listen for unusual pump noise',criteria:'The motor runs steadily without grinding or rattling.',priority:'Medium'}
  ]}});
  await act(admin,{type:'settings',fields:{workspace:'Harborstone Facilities',defaultAssignee:members.technician,correctiveDays:3}});
  return {asset,template};
}
export async function schedule(admin,equipment,assigneeId,due=FP.localDay()) {
  return (await act(admin,{type:'inspection',fields:{templateId:equipment.template,assetId:equipment.asset,assigneeId,due}})).result;
}
