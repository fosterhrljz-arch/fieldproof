import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const root = new URL('./',import.meta.url);
const src = new URL('src/',root);
const dist = new URL('dist/',root);
const read = name => readFile(new URL(name,src),'utf8');
const [shell,css,logo,worker,photo,...scripts] = await Promise.all([
  read('index.html'),read('style.css'),read('icon.svg'),read('sw.js'),
  readFile(new URL('demo-pump.jpg',src)),
  ...['core','demo','storage','ui','pdf','app'].map(name=>read(name+'.js'))
]);
const art = {src:'data:image/jpeg;base64,'+photo.toString('base64'),w:1536,h:1024};
const code = [...scripts.slice(0,-1),'FP.demoPhoto = '+JSON.stringify(art)+';',scripts.at(-1)].join('\n');
const source = shell.replace('<!-- APP_SCRIPTS -->',()=>`<script>\n${code.replaceAll('</script','<\\/script')}\n</script>`);
const style = '<style>\n'+css+'\n</style>';
const hosted = source.replace('<!-- APP_ASSETS -->',()=>'<link rel="icon" href="icon.svg"><link rel="manifest" href="manifest.webmanifest">\n'+style);
const standalone = source.replace('<!-- APP_ASSETS -->',()=>`<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(logo)}">\n${style}`);
const version = createHash('sha256').update(hosted).update(worker).digest('hex').slice(0,16);
await mkdir(dist,{recursive:true});
await Promise.all([
  writeFile(new URL('index.html',dist),hosted),
  writeFile(new URL('FieldProof.html',root),standalone),
  writeFile(new URL('sw.js',dist),worker.replace('BUILD_ID',version)),
  ...['icon.svg','manifest.webmanifest'].map(name=>copyFile(new URL(name,src),new URL(name,dist)))
]);
console.log('Built FieldProof.html and dist/');
