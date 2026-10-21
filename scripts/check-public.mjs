import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
async function walk(directory){const out=[];for(const entry of await fs.readdir(directory,{withFileTypes:true})){if(['.git','node_modules'].includes(entry.name))continue;const full=path.join(directory,entry.name);if(entry.isDirectory())out.push(...await walk(full));else out.push(path.relative(root,full).replaceAll('\\','/'));}return out;}
const tracked=spawnSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'});
const files=tracked.status===0&&tracked.stdout?tracked.stdout.split('\0').filter(Boolean):await walk(root);
const findings=[];
for(const name of files){
  if(/(?:^|\/)(?:sifTraffic\.json|local|private|data|reports|exports|screenshots|backups)(?:\/|$)|\.(?:csv|xlsx?|jsonl|zip|png|jpe?g|webp|pdf|pem|key|p12|pfx|log)$/i.test(name)||/(?:^|\/)\.env(?:\.|$)/.test(name))findings.push(`${name}: private or generated file`);
  const staged=tracked.status===0?spawnSync('git',['show',`:${name}`],{cwd:root,encoding:'utf8'}):null;
  const versions=[await fs.readFile(path.join(root,name),'utf8')];if(staged?.status===0)versions.push(staged.stdout);
  for(const text of versions){
    if(/\bB0[A-Z0-9]{8}\b/.test(text))findings.push(`${name}: possible product identifier`);
    if(/(?:github_pat_|ghp_)[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|[A-Z]:[\\/]Users[\\/]/.test(text))findings.push(`${name}: possible credential or personal path`);
  }
}
if(findings.length){console.error(findings.join('\n'));process.exitCode=1;}else console.log(`Privacy checks passed for ${files.length} public source files. Review business-sensitive content before publishing.`);

