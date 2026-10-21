import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('privacy guard rejects a staged identifier even after working copy is cleaned',async t=>{
  if(spawnSync('git',['--version']).status!==0){t.skip('Git is required for staged-content verification');return;}
  const base=path.resolve(os.tmpdir()),temporary=await fs.mkdtemp(path.join(base,'rank-monitor-test-'));
  try{
    await fs.mkdir(path.join(temporary,'scripts'));
    await fs.copyFile(new URL('../scripts/check-public.mjs',import.meta.url),path.join(temporary,'scripts/check-public.mjs'));
    assert.equal(spawnSync('git',['init'],{cwd:temporary}).status,0);
    const fixture=path.join(temporary,'example.txt');
    await fs.writeFile(fixture,'B0'+'X'.repeat(8));
    assert.equal(spawnSync('git',['add','example.txt','scripts/check-public.mjs'],{cwd:temporary}).status,0);
    await fs.writeFile(fixture,'redacted');
    const rejected=spawnSync(process.execPath,['scripts/check-public.mjs'],{cwd:temporary,encoding:'utf8'});
    assert.equal(rejected.status,1);assert.match(rejected.stderr,/product identifier/);
    assert.equal(spawnSync('git',['add','example.txt'],{cwd:temporary}).status,0);
    assert.equal(spawnSync(process.execPath,['scripts/check-public.mjs'],{cwd:temporary}).status,0);
  }finally{
    const resolved=await fs.realpath(temporary),resolvedBase=await fs.realpath(base);
    if(!resolved.startsWith(resolvedBase+path.sep)||!path.basename(resolved).startsWith('rank-monitor-test-'))throw new Error('Refusing to remove an unexpected directory');
    await fs.rm(resolved,{recursive:true,force:true});
  }
});

