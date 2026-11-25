import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveWindowsCompiler } from '../src/windows-job-cache.mjs';

/** Presence/version checks only: no installs, login, provider requests, shell edits or secret output. */
export async function providerDoctor({kind,env=process.env,platform=process.platform,arch=process.arch,probe}={}) {
  const find=probe??(async name=>{
    if((platform==='win32'?path.win32:path.posix).isAbsolute(name)){try{await access(name,platform==='win32'?constants.F_OK:constants.X_OK);return true;}catch{return false;}}
    const extensions=platform==='win32'?(env.PATHEXT??'.EXE;.CMD;.BAT').split(';'):[''];
    for(const directory of (env.PATH??'').split(path.delimiter))for(const extension of extensions){try{await access(path.join(directory,name+extension),platform==='win32'?constants.F_OK:constants.X_OK);return true;}catch{}}
    return false;
  });
  const checks=[{name:'Node.js',role:'startup',available:Number(process.versions.node.split('.')[0])>=24,version:process.versions.node,recommendation:'Install Node.js 24 or newer manually using your operating system package manager.'}];
  for(const [name,role,recommendation] of [
    ['npm','startup','Install npm with Node.js before building this source application.'],
    ['git','workspace','Install Git manually for source and development workspace operations.'],
    ['rg','optional','Install ripgrep manually when a project needs fast source search.'],
    ['dotnet','optional','.NET is needed only for .NET workloads. Install the version selected by that project.'],
    ['python3','optional','Python is needed only for Python workloads. Install the version selected by that project.'],
    ['cargo','optional','Rust/Cargo is needed only for Rust workloads. Install it when a project requires it.'],
  ])checks.push({name,role,available:await find(name),recommendation});
  if(platform==='win32') {
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
    const compiler = systemRoot && await resolveWindowsCompiler(systemRoot).catch(() => undefined);
    checks.push({ name: 'csc.exe', role: 'startup', available: Boolean(compiler),
      recommendation: 'Enable or repair the Windows .NET Framework 4.x component so the provider can prepare its native Job Object helper.' });
  }
  else checks.push({name:'/bin/ps',role:'startup',available:await find('/bin/ps'),recommendation:platform==='darwin'?'Restore the macOS system /bin/ps utility; the provider requires it to verify its owned process tree stopped.':'Install the Linux procps package (procps-ng on distributions using that name), providing executable /bin/ps for owned process-tree stop verification.'});
  const recommendations=platform==='darwin'?['Install Node.js 24 or newer and npm with the macOS installer or your chosen package manager.','Install Git using Xcode Command Line Tools or your package manager; install project tools only as needed.']
    :platform==='win32'?['Install Node.js 24 or newer with the Windows installer, including npm and its PATH entry.','Use the built-in .NET Framework 4.x C# compiler for native process supervision. Install Git for Windows and the SDKs your projects require.']
    :['Install Node.js 24 or newer and npm using a supported Linux distribution package or the official Node.js distribution.','Install Git and optional project tools using the distribution package manager; match project-pinned SDK versions.'];
  const core={configured:Boolean(env.HOSTY_APP_ID&&env.HOSTY_CORE_ORIGIN&&env.HOSTY_APP_SERVICE_TOKEN),note:'Use a Core-managed launch to verify identity, declared permissions and configured provider endpoints. Account credentials are configured explicitly in provider settings.'};
  return{version:1,kind:kind??null,platform,arch,ready:checks.filter(c=>c.role==='startup').every(c=>c.available),checks,recommendations,core};
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url))){
  const kind=process.argv.slice(2).find(v=>v!=='--json'),result=await providerDoctor({kind});
  if(process.argv.includes('--json'))console.log(JSON.stringify(result,null,2));
  else{console.log('Hosty provider prerequisites ('+result.platform+'/'+result.arch+')');for(const check of result.checks)console.log((check.available?'OK':'Missing')+' '+check.name+' ['+check.role+']'+(check.available?'':': '+check.recommendation));for(const recommendation of result.recommendations)console.log(recommendation);console.log(result.core.note);console.log('This command changes nothing and never installs development tools or provider credentials.');}
  if(!result.ready)process.exitCode=1;
}
