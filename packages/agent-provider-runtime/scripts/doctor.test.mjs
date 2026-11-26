import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { providerDoctor } from './doctor.mjs';
describe('read-only provider doctor',()=>{
  it('keeps optional project tools separate from startup requirements',async()=>{
    const inspected=[];const result=await providerDoctor({kind:'independent-provider',platform:'linux',env:{},probe:async name=>{inspected.push(name);return ['npm','/bin/ps'].includes(name);}});
    expect(result.ready).toBe(true);expect(result.checks.find(c=>c.name==='dotnet')).toMatchObject({role:'optional',available:false});expect(result.checks.find(c=>c.name==='git')).toMatchObject({role:'workspace',available:false});
    expect(inspected).toEqual(['npm','git','rg','dotnet','python3','cargo','/bin/ps']);expect(result.core.configured).toBe(false);
  });
  it.each(['darwin','linux','win32'])('prints platform-specific manual guidance for %s',async platform=>{
    const result=await providerDoctor({kind:'another-engine',platform,env:{},probe:async()=>true});
    expect(result.recommendations.join(' ')).toContain(platform==='darwin'?'macOS':platform==='win32'?'Windows':'Linux');
    if(platform==='win32')expect(result.checks.find(c=>c.name==='csc.exe')).toMatchObject({role:'startup',available:false});
    else expect(result.checks.find(c=>c.name==='/bin/ps')).toMatchObject({role:'startup',available:true});
  });
  it.each(['Framework64','Framework'])('finds the stock compiler under SystemRoot/%s and ignores PATH lookalikes', async framework => {
    const root = await mkdtemp(path.join(os.tmpdir(),'hosty-doctor-windows-'));
    try {
      const env = { SYSTEMROOT: root }, probes = [];
      const options = { platform: 'win32', env, probe: async name => { probes.push(name); return true; } };
      const absent = await providerDoctor(options);
      expect(absent.ready).toBe(false);
      expect(absent.checks.find(c => c.name === 'csc.exe')).toMatchObject({ role: 'startup', available: false });
      const folder = path.join(root,'Microsoft.NET',framework,'v4.0.30319');
      await mkdir(folder,{ recursive: true }); await writeFile(path.join(folder,'csc.exe'),'fixture');
      const installed = await providerDoctor(options);
      expect(installed.ready).toBe(true);
      expect(installed.checks.find(c => c.name === 'csc.exe')).toMatchObject({ role: 'startup', available: true });
      expect(probes).not.toContain('csc.exe');
    } finally { await rm(root,{ recursive: true, force: true }); }
  });
  it.each(['darwin','linux'])('requires the absolute process-proof utility on %s',async platform=>{
    const result=await providerDoctor({platform,env:{},probe:async name=>name!=='/bin/ps'});
    expect(result.ready).toBe(false);
    expect(result.checks.find(c=>c.name==='/bin/ps')).toMatchObject({role:'startup',available:false,recommendation:expect.stringContaining(platform==='darwin'?'macOS system':'procps')});
  });
  it.skipIf(process.platform==='win32')('checks absolute /bin/ps independently of PATH',async()=>{
    const result=await providerDoctor({env:{PATH:'/nonexistent/hosty-doctor-fixture'}});
    expect(result.checks.find(c=>c.name==='/bin/ps')).toMatchObject({role:'startup',available:true});
    expect(result.checks.find(c=>c.name==='npm')?.available).toBe(false);
  });
  it('reports a missing startup tool without installing anything or returning secrets',async()=>{
    const result=await providerDoctor({kind:'local-engine',env:{HOSTY_APP_SERVICE_TOKEN:'must-not-print'},probe:async()=>false});
    expect(result.ready).toBe(false);expect(JSON.stringify(result)).not.toContain('must-not-print');
  });
});
