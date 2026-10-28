// Trusted file/command executor, launched with the selected execution identity.
export const FILE_TOOL_SCRIPT = String.raw`
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { constants } = require("node:fs"), { spawn } = require("node:child_process");
setInterval(() => {}, 1000); // The supervisor owns termination, including Windows descendants.
(async () => {
 let input = ""; for await (const c of process.stdin) { input += c; if(input.length > 2*1024*1024) throw Error("Tool input too large"); }
 const { name, args, expectedHash } = JSON.parse(input);
 const root = await fs.realpath(process.cwd());
 const inside = p => p === root || p.startsWith(root + path.sep);
 async function resolve(file, missing = false) {
  if(typeof file !== "string" || file.includes("\0")) throw Error("Invalid path");
  const p=path.resolve(root,file); if(!inside(p)) throw Error("Path is outside the workspace");
  if(p===root)return root;
  const parent=await fs.realpath(path.dirname(p)); if(!inside(parent)) throw Error("Path redirects outside the workspace");
  const resolved=await fs.realpath(p).catch(e=> { if(missing&&e.code==="ENOENT") return path.join(parent,path.basename(p)); throw e; });
  if(!inside(resolved)) throw Error("Path redirects outside the workspace");
  return resolved;
 }
 async function text(file) {
  const p=await resolve(file), h=await fs.open(p,constants.O_RDONLY|constants.O_NOFOLLOW);
  try { const s=await h.stat(); if(!s.isFile()||s.size>1024*1024) throw Error("Expected a text file of at most 1 MiB");
   const t=await h.readFile("utf8"); if(t.includes("\0")) throw Error("Binary files are not supported"); return {text:t,hash:crypto.createHash("sha256").update(t).digest("hex"),mode:s.mode}; }
  finally {await h.close();}
 }
 let result;
 if(name==="read_file") {
  const f=await text(args.path), offset=args.offset??0, length=args.length??24000;
  result={content:f.text.slice(offset,offset+length),sha256:f.hash,totalCharacters:f.text.length,truncated:offset+length<f.text.length};
 } else if(name==="list_directory") {
  const entries=await fs.readdir(await resolve(args.path||"."),{withFileTypes:true});
  result={entries:entries.slice(args.offset??0,(args.offset??0)+200).map(e=>({name:e.name,type:e.isDirectory()?"directory":e.isSymbolicLink()?"link":"file"})),total:entries.length};
 } else if(name==="search_text") {
  const results=[]; let visited=0, clipped=false;
  async function walk(dir) {
   for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
    if([".git","node_modules",".next","bin","obj"].includes(entry.name)||entry.isSymbolicLink()) continue;
    if(++visited>2000||results.length>=100){clipped=true;return;}
    const p=path.join(dir,entry.name);
    if(entry.isDirectory()) await walk(p);
    else if(entry.isFile()) {
     const data=await text(path.relative(root,p)).catch(()=>null); if(!data) continue;
     const lines=data.text.split("\n");
     for(let i=0;i<lines.length&&results.length<100;i++) if(lines[i].includes(args.query))
      results.push({path:path.relative(root,p),line:i+1,text:lines[i].slice(0,500)});
    }
   }
  }
  await walk(await resolve(args.path||".")); result={matches:results,truncated:clipped||results.length>=100};
 } else if(name==="inspect_patch" || name==="apply_patch") {
  const p=await resolve(args.path,true);
  const before=await text(args.path).catch(e=>{if(e.code==="ENOENT")return null;throw e;});
  if(args.old_text==="") { if(before) throw Error("Empty old_text is only valid for a new file"); }
  else if(!before || before.text.split(args.old_text).length!==2) throw Error("old_text must match exactly once");
  const content=before?before.text.replace(args.old_text,()=>args.new_text):args.new_text;
  if(Buffer.byteLength(content)>1024*1024) throw Error("Patched file exceeds 1 MiB");
  const hash=before?.hash??"missing";
  if(name==="inspect_patch") result={sha256:hash};
  else {
   if(hash!==expectedHash) throw Error("File changed after the patch was proposed; request a fresh approval");
   const tmp=path.join(path.dirname(p),".hosty-patch-"+crypto.randomUUID());
   try {const h=await fs.open(tmp,"wx",before?before.mode&0o777:0o600);try{await h.writeFile(content);await h.sync();}finally{await h.close();}
    const current=await text(args.path).catch(e=>{if(e.code==="ENOENT")return null;throw e;});
    if((current?.hash??"missing")!==expectedHash)throw Error("File changed before patch commit");
    await fs.rename(tmp,p); result={path:args.path,sha256:crypto.createHash("sha256").update(content).digest("hex")};
   } finally {await fs.rm(tmp,{force:true});}
  }
 } else if(name==="run_command") {
  const cwd=await resolve(args.cwd||".");
  const child=spawn(process.platform==="win32"?"cmd.exe":"/bin/sh",process.platform==="win32"?["/d","/s","/c",args.command]:["-c",args.command],{cwd,stdio:["ignore","pipe","pipe"],env:process.env});
  let output="",truncated=false;
  const add=c=>{const t=c.toString();output+=t.slice(0,48000-output.length);if(output.length>=48000)truncated=true;};
  child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
  child.stdout.on("data",add);child.stderr.on("data",add);
  const drained=new Promise(resolve=>child.once("close",()=>resolve(true)));
  const exitCode=await new Promise((resolve,reject)=>{child.on("error",reject);child.on("exit",resolve);});
  // Descendants can keep pipes open; drain final output, then let the supervisor stop the group.
  let timer; const closed=await Promise.race([drained,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),250);})]);clearTimeout(timer);
  result={exitCode,output,truncated:truncated||!closed};
 } else throw Error("Unknown file tool");
 process.stdout.write(JSON.stringify({ok:true,result})+"\n");
})().catch(e=>{process.stdout.write(JSON.stringify({ok:false,error:e.message})+"\n");process.exitCode=1;});
`;
