import { describe, expect, it } from 'vitest';
import { providerDoctor } from './doctor.mjs';
describe('read-only provider doctor',()=>{
  it('keeps optional project tools separate from startup requirements',async()=>{
    const inspected=[];const result=await providerDoctor({kind:'codex',platform:'linux',env:{},probe:async name=>{inspected.push(name);return ['npm','/bin/ps'].includes(name);}});
    expect(result.ready).toBe(true);expect(result.checks.find(c=>c.name==='dotnet')).toMatchObject({role:'optional',available:false});expect(result.checks.find(c=>c.name==='git')).toMatchObject({role:'workspace',available:false});
    expect(inspected).toEqual(['npm','git','rg','dotnet','python3','cargo','/bin/ps']);expect(result.core.configured).toBe(false);
  });
  it.each(['darwin','linux','win32'])('prints platform-specific manual guidance for %s',async platform=>{
    const result=await providerDoctor({kind:'claude',platform,env:{},probe:async()=>true});
    expect(result.recommendations.join(' ')).toContain(platform==='darwin'?'macOS':platform==='win32'?'Windows':'Linux');
    if(platform==='win32')expect(result.checks.find(c=>c.name==='powershell')).toMatchObject({role:'startup',available:true});
    else expect(result.checks.find(c=>c.name==='/bin/ps')).toMatchObject({role:'startup',available:true});
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
    const result=await providerDoctor({kind:'ollama',env:{HOSTY_APP_SERVICE_TOKEN:'must-not-print'},probe:async()=>false});
    expect(result.ready).toBe(false);expect(JSON.stringify(result)).not.toContain('must-not-print');
  });
});
