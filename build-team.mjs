import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('./',import.meta.url);
const src=new URL('src/',root);
const dist=new URL('team-dist/',root);
const read=name=>readFile(new URL(name,src),'utf8');
const [html,css,worker,font,...modules]=await Promise.all([
  read('index.html'),read('style.css'),read('team-sw.js'),readFile(new URL('fonts/NotoSansSC-Regular.ttf',src)),
  ...['core','operations','storage','team-policy','team-client','i18n','ui','field-ui','pdf-unicode','pdf','app'].map(name=>read(name+'.js'))
]);
const app=modules.join('\n');
const shell=html.replace('browser-local workspace','shared team workspace').replace('Opening the local workspace…','Connecting to the workspace…')
  .replace('<!-- APP_ASSETS -->','<link rel="icon" href="/icon.svg"><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/style.css">')
  .replace('<!-- APP_SCRIPTS -->','<script src="/app.js" defer></script>');
const version=createHash('sha256').update(shell).update(css).update(app).update(worker).update(font).digest('hex').slice(0,16);
await mkdir(new URL('fonts/',dist),{recursive:true});
await Promise.all([
  writeFile(new URL('index.html',dist),shell),writeFile(new URL('app.js',dist),app),writeFile(new URL('style.css',dist),css),
  writeFile(new URL('sw.js',dist),worker.replace('BUILD_ID',version)),
  writeFile(new URL('fonts/NotoSansSC-Regular.ttf',dist),font),
  ...['icon.svg','manifest.webmanifest'].map(name=>copyFile(new URL(name,src),new URL(name,dist)))
]);
console.log('Built the FieldProof team application in team-dist/');
