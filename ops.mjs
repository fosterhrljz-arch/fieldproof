import {backup,DatabaseSync} from 'node:sqlite';
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,closeSync,openSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const [operation,argument]=process.argv.slice(2);
const dbPath=resolve(process.env.FIELDPROOF_DB||fileURLToPath(new URL('team-data/fieldproof.sqlite',import.meta.url)));
if (!['snapshot','recover-admin'].includes(operation)||!argument) {
  throw new Error('Use ops.mjs snapshot <new-db-file> or ops.mjs recover-admin <email>.');
}
if (!existsSync(dbPath)) throw new Error('FieldProof database file does not exist. Check FIELDPROOF_DB.');
const db=new DatabaseSync(dbPath,{readOnly:operation==='snapshot'});
try {
  db.exec('PRAGMA busy_timeout=5000');
  if (operation==='snapshot') {
    const target=resolve(argument);
    const handle=openSync(target,'wx',0o600);
    closeSync(handle);
    try {
      await backup(db,target);
      console.log('Snapshot saved to '+target);
    } catch (failure) {
      unlinkSync(target);
      throw failure;
    }
  } else {
    const email=argument.trim().toLowerCase();
    db.exec('BEGIN IMMEDIATE');
    let code;
    try {
      const user=db.prepare("SELECT id FROM members WHERE email=? AND role='Admin' AND enabled=1").get(email);
      if (!user) throw new Error('No enabled administrator has that email.');
      code=randomBytes(32).toString('base64url');
      const hash=createHash('sha256').update(code).digest('hex');
      db.prepare('UPDATE members SET password=NULL, invitation=?, invite_until=?, version=version+1 WHERE id=?')
        .run(hash,Date.now()+3600000,user.id);
      db.prepare('DELETE FROM sessions WHERE member=?').run(user.id);
      const record=db.prepare('SELECT payload FROM workspace WHERE id=1').get();
      const state=JSON.parse(record.payload);
      const person=state.people.find(person=>person.id===user.id);
      if (person) person.available=false;
      state.revision++;
      db.prepare('UPDATE workspace SET payload=? WHERE id=1').run(JSON.stringify(state));
      db.prepare('INSERT INTO audit(at,actor,action,target,detail) VALUES (?,?,?,?,?)').run(new Date().toISOString(),'system','admin-recovery',user.id,'');
      db.exec('COMMIT');
    } catch (failure) {
      db.exec('ROLLBACK');
      throw failure;
    }
    console.log('Open Activate an account and use this one-hour code for '+email+': '+code);
  }
} finally { db.close(); }
