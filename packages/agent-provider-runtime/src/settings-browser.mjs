import { appFetch, appSessionActive, configureAppActivity, openAppSignIn, rememberAppGrant, restoreAppGrant } from '@hosty-sdk/app/browser-auth';
import { configureAppContinuity } from '@hosty-sdk/app/continuity/browser';
import { providerSignInUrl } from './settings-auth.mjs';
import { configureProviderTheme } from './settings-theme.mjs';
import { summarizeProviderUsage, usageAmount, usageLabel } from './settings-usage.mjs';

const stopTheme = configureProviderTheme();
const usageEntries=new Map(),usageViews=new Map(),usageQueue=[];let usageReading=0,usageDialog,usageDialogEntry,usageDialogTrigger;
const usageClock=setInterval(refreshUsageDisplays,60000);document.addEventListener('visibilitychange',refreshUsageDisplays);
const element = id => document.getElementById(id);
const definition=JSON.parse(element('provider-definition').textContent);
const providerName=definition.connectionName??definition.name;
const authLabels=Object.fromEntries(definition.authentication.map(method=>[method.id,method.label]));
const authDefinition=auth=>definition.authentication.find(method=>method.id===auth);
const loginName=definition.login?.name??providerName;
let recovery, editing = null, inventory, loginTimer, continuityStop, activityStop, continuityId, busy = false, editorTrigger, activeLogin, focusAfterBusy, loginEpoch = 0, stopped = false;
const message = (text, state = 'status') => { const node=element('message'); node.textContent=text;node.hidden=!text;node.dataset.state=state;node.setAttribute('role',state==='error'?'alert':'status');node.parentElement.hidden=!text&&element('signin').hidden; };
const errorAt = (id, text) => { const node=element(id);node.textContent=text;node.hidden=!text; };
const reportError = error => { const text=error instanceof Error?error.message:String(error);if(element('editor').open)errorAt('form-error',text);else if(element('login-dialog').open)errorAt('login-error',text);else message(text,'error'); };
const authOptions=definition.authentication.map(method=>method.id);
for(const value of authOptions){const option=document.createElement('option');option.value=value;option.textContent=authLabels[value];element('auth').append(option);}
const fields = () => {
  const auth=element('auth').value;
  element('secret-field').hidden=!authDefinition(auth)?.credential;element('secret').required=!editing&&!element('secret-field').hidden;
  element('host-field').hidden=!authDefinition(auth)?.hostDirectory;element('hostDirectory').required=authDefinition(auth)?.hostDirectory;
  element('url-field').hidden=!definition.baseUrl;element('browser-login-description').hidden=!authDefinition(auth)?.browserLogin;element('save-provider').textContent=authDefinition(auth)?.browserLogin&&!editing?'Add and sign in':'Save provider';
};
element('auth').addEventListener('change',()=>{element('secret').value='';fields();});fields();
function setBusy(value){busy=value;for(const node of document.querySelectorAll('button'))node.disabled=value||node.dataset.unavailable==='true'||node.dataset.loading==='true';element('connection-fields').disabled=value;element('auth').disabled=!!editing;}
async function act(action){if(busy)return;setBusy(true);try{await action();}catch(error){reportError(error);}finally{setBusy(false);focusAfterBusy?.focus();focusAfterBusy=null;}}
async function request(path,method='GET',body){
  const response=await appFetch(path,{method,headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},false);
  const value=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(value?.message??`Request failed (${response.status}). Refresh before retrying a change.`);
  return value;
}
async function exchange(result,signal){
  const response=await fetch('/api/auth/exchange',{method:'POST',credentials:'include',signal,headers:{'content-type':'application/json'},body:JSON.stringify(result)});
  const value=await response.json().catch(()=>null);
  if(!response.ok||!value?.accessToken)throw new Error(value?.message??'Hosty sign-in failed.');
  rememberAppGrant(value.accessToken);appSessionActive();return value;
}
async function probe(){
  const response=await appFetch('/api/auth/session',{},false),state=await response.json();recovery=state.recovery;
  if(state.status!=='active'){
    element('protected').hidden=true;element('signin').hidden=false;clearUsage();
    message(state.status==='forbidden'?'An administrator with access to this provider is required.':state.status==='unavailable'?'Core is temporarily unavailable. Keep this page and retry.':'Sign in through Hosty to configure this provider.',['forbidden','unavailable'].includes(state.status)?'error':'status');return false;
  }
  appSessionActive();element('protected').hidden=false;element('signin').hidden=true;
  if(recovery?.corePublicOrigin&&recovery?.appId&&recovery?.appAuthProtocol===2){
    const openUrl=providerSignInUrl(recovery,window.location.origin);
    activityStop?.();activityStop=configureAppActivity({openUrl,appAuthProtocol:2,activeUntil:state.activeUntil,activityRequired:state.activityRequired,exchangeCode:exchange,validateSession:probe});
    if(state.continuity&&continuityId!==state.continuity.grantId){continuityStop?.();continuityId=state.continuity.grantId;continuityStop=configureAppContinuity({coreOrigin:recovery.corePublicOrigin,authority:state.continuity,probe});}
  }
  return true;
}
async function load(notice=''){
  element('connections').setAttribute('aria-busy','true');element('refresh').disabled=true;
  try{if(!await probe())return;if(!inventory)message('Loading providers…');inventory=await request('/api/settings/connections');render();message(notice);}
  finally{element('connections').setAttribute('aria-busy','false');element('refresh').disabled=busy;}
}
function button(label,action,className='button button-outline button-sm',mutation=true){
  const node=document.createElement('button');node.type='button';node.className=className;node.textContent=label;node.onclick=()=>{if(mutation)void act(action);else Promise.resolve(action()).catch(reportError);};return node;
}
const icons={ellipsis:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',edit:'<path d="m16 3 5 5-13 13H3v-5Z"/><path d="m14 5 5 5"/>',star:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',login:'<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M3 12h12m-5-5 5 5-5 5"/>',remove:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>'};
function icon(name){const holder=document.createElement('span');holder.innerHTML=`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;return holder.firstElementChild;}
function closeMenu(menu,restore=false){menu.hidden=true;const trigger=menu.previousElementSibling;trigger.setAttribute('aria-expanded','false');if(restore)trigger.focus();}
function closeMenus(event){for(const menu of document.querySelectorAll('.menu'))if(!event||!menu.parentElement.contains(event.target))closeMenu(menu);}
function menuItem(label,name,action,mutation=true){const node=button(label,async()=>{closeMenus();await action();},'menu-item',mutation);node.setAttribute('role','menuitem');node.prepend(icon(name));return node;}
function showRemoval(card,connection,trigger){
  closeMenus();card.querySelector('.remove-confirmation')?.remove();const row=document.createElement('div');row.className='remove-confirmation';
  const text=document.createElement('p');text.textContent=`Remove ${connection.name}? Existing native session files are retained.`;
  const keep=button('Keep provider',()=>{row.remove();trigger.focus();},'button button-outline button-sm',false);
  const remove=button('Remove provider',async()=>{await request(`/api/settings/connections/${encodeURIComponent(connection.id)}`,'DELETE',{expectedRevision:connection.revision});await load('Provider removed. Existing native session files are retained.');},'button button-danger button-sm');
  row.append(text,keep,remove);card.append(row);keep.focus();
}
function render(){
  const root=element('connections');root.replaceChildren();usageViews.clear();
  if(!inventory.connections.length){const empty=document.createElement('div');empty.className='empty';const content=document.createElement('div'),title=document.createElement('h3'),description=document.createElement('p');title.textContent='No providers connected';description.textContent='Add a connection to start using this provider.';content.append(title,description);empty.append(content);root.append(empty);}
  for(const connection of inventory.connections){
    const card=document.createElement('article');card.className='connection';const summary=document.createElement('div');summary.className='connection-summary';const title=document.createElement('div');title.className='connection-title';const name=document.createElement('h3');name.textContent=connection.name;title.append(name);
    if(inventory.defaultId===connection.id){const badge=document.createElement('span');badge.className='badge';badge.textContent='Default';title.append(badge);}
    const state=document.createElement('p');state.className='connection-description';state.textContent=`${providerName} · ${authLabels[connection.auth]??connection.auth} · ${connection.available?'Configured':connection.reason??'Reconnect required'}`;summary.append(title,state);
    const actions=document.createElement('div');actions.className='connection-actions';const trigger=document.createElement('button');trigger.type='button';trigger.className='button button-ghost button-icon';trigger.setAttribute('aria-label',`Actions for ${connection.name}`);trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-expanded','false');trigger.append(icon('ellipsis'));
    const menu=document.createElement('div');menu.className='menu';menu.hidden=true;menu.setAttribute('role','menu');menu.setAttribute('aria-label',`Actions for ${connection.name}`);
    if(inventory.defaultId!==connection.id){const item=menuItem('Set default','star',async()=>{await request('/api/settings/default','PUT',{id:connection.id});await load('Default saved. Existing chats keep their provider.');});item.dataset.unavailable=String(!connection.available);item.disabled=!connection.available;menu.append(item);}
    if(authDefinition(connection.auth)?.browserLogin)menu.append(menuItem(connection.available?'Sign in again':`Sign in with ${loginName}`,'login',async()=>showLogin(await request(`/api/settings/connections/${encodeURIComponent(connection.id)}/login`,'POST',{expectedRevision:connection.revision}))));
    menu.append(menuItem('Edit','edit',()=>openEditor(connection,trigger),false));const separator=document.createElement('div');separator.className='menu-separator';separator.setAttribute('role','separator');const remove=menuItem('Remove','remove',()=>showRemoval(card,connection,trigger),false);remove.classList.add('menu-item-danger');menu.append(separator,remove);
    trigger.dataset.connectionId=connection.id;const openMenu=()=>{closeMenus();menu.hidden=false;trigger.setAttribute('aria-expanded','true');menu.querySelector('button:not(:disabled)')?.focus();};trigger.onclick=()=>{if(!menu.hidden)closeMenu(menu);else openMenu();};
    trigger.onkeydown=event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();openMenu();const items=[...menu.querySelectorAll('button:not(:disabled)')];(event.key==='ArrowDown'?items[0]:items.at(-1))?.focus();}};
    menu.onkeydown=event=>{const items=[...menu.querySelectorAll('button:not(:disabled)')],index=items.indexOf(document.activeElement);if(event.key==='Escape'){event.preventDefault();closeMenu(menu,true);}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();}else if(event.key==='Tab')closeMenu(menu);};
    actions.append(limitsButton(connection),trigger,menu);card.append(summary,actions);root.append(card);
  }
  for(const [key,entry]of usageEntries)if(!currentUsageEntry(entry)){usageEntries.delete(key);if(usageDialogEntry===entry)closeUsage(false);}
  setBusy(busy);
}
function usageKey(connection){return JSON.stringify([connection.id,String(connection.revision)]);}
function currentUsageEntry(entry){return !stopped&&usageEntries.get(entry.key)===entry&&inventory?.connections.some(connection=>usageKey(connection)===entry.key);}
function usageEntry(connection){
  const key=usageKey(connection);let entry=usageEntries.get(key);
  if(!entry){entry={key,connection:{...connection},usage:null,error:'',loading:false,pending:null};usageEntries.set(key,entry);}
  else entry.connection={...connection};
  return entry;
}
function limitsSummary(entry){return summarizeProviderUsage(entry.usage,Date.now(),undefined,definition.usage);}
function paintUsage(entry){
  const view=usageViews.get(entry.key);if(!view||!currentUsageEntry(entry))return;
  const usage=entry.usage,summary=limitsSummary(entry),remaining=summary.remaining;
  view.hidden=usage?.state==='unsupported'||usage?.state==='not_applicable';
  const amount=remaining===null?'?':new Intl.NumberFormat('en',{maximumFractionDigits:1}).format(remaining)+'%';
  const description=remaining===null?summary.reason??'Remaining limits are unavailable.':`${amount} left · ${summary.row.label}`;
  view.setAttribute('aria-label',`Provider limits for ${entry.connection.name}: ${description}`);view.title=description;
  view.setAttribute('aria-busy',String(entry.loading));view.dataset.tone=remaining===null?'unknown':remaining<=0?'empty':remaining<=20?'low':'available';
  const ring=document.createElement('span');ring.className='usage-ring';ring.dataset.slot='usage-ring';
  ring.innerHTML='<svg viewBox="0 0 28 28" aria-hidden="true"><circle class="usage-ring-track" cx="14" cy="14" r="11" fill="none" stroke="currentColor" stroke-width="2"/></svg><span class="usage-ring-icon" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><path d="M5 22h14M5 2h14M17 22v-4.17a2 2 0 0 0-.59-1.42L7.59 7.59A2 2 0 0 1 7 6.17V2M7 22v-4.17a2 2 0 0 1 .59-1.42l8.82-8.82A2 2 0 0 0 17 6.17V2"/></svg></span>';
  const svg=ring.firstElementChild;
  if(remaining===null)svg.firstElementChild.setAttribute('stroke-dasharray','2 3');
  else{
    ring.setAttribute('role','meter');ring.setAttribute('aria-label','Provider limits remaining');
    for(const [name,value]of Object.entries({'aria-valuemin':0,'aria-valuemax':100,'aria-valuenow':remaining,'aria-valuetext':description}))ring.setAttribute(name,String(value));
    const arc=svg.firstElementChild.cloneNode();arc.removeAttribute('class');arc.setAttribute('pathLength','100');arc.setAttribute('stroke-dasharray','100');arc.setAttribute('stroke-dashoffset',String(100-remaining));svg.append(arc);
  }
  const text=document.createElement('span');text.className='usage-amount';text.textContent=amount+' left';view.replaceChildren(ring,text);
  if(usageDialogEntry===entry)paintUsageDialog();
}
function pumpUsageReads(){
  while(!stopped&&usageReading<2&&usageQueue.length){usageReading++;const task=usageQueue.shift();void task().finally(()=>{usageReading--;pumpUsageReads();});}
}
function readUsage(connection){
  const entry=usageEntry(connection);if(entry.pending)return entry.pending;
  entry.loading=true;entry.error='';paintUsage(entry);
  entry.pending=new Promise(resolve=>{usageQueue.push(async()=>{
    try{
      if(!currentUsageEntry(entry))return;
      const value=await request(`/api/settings/connections/${encodeURIComponent(connection.id)}/usage?refresh=true`);
      if(!currentUsageEntry(entry))return;
      if(String(value?.connectionRevision)!==String(connection.revision)){entry.usage=null;throw new Error('This connection changed. Refresh providers before checking its limits.');}
      if(!['available','unavailable','unsupported','not_applicable'].includes(value?.state)||!Array.isArray(value.rows)||value.rows.length>200||value.rows.some(row=>!row||typeof row!=='object'||typeof row.group!=='string'||typeof row.label!=='string'))throw new Error('The provider did not return a valid account limits observation.');
      entry.usage=value;
    }catch(error){
      if(currentUsageEntry(entry)){entry.error=error instanceof Error?error.message:'Could not read account limits.';if(entry.usage)entry.usage={...entry.usage,stale:true};}
    }finally{entry.loading=false;entry.pending=null;if(currentUsageEntry(entry))paintUsage(entry);resolve();}
  });});
  pumpUsageReads();return entry.pending;
}
function limitsButton(connection){
  const entry=usageEntry(connection),node=button('',()=>showUsage(entry),'button button-ghost usage-indicator',false);
  node.dataset.slot='provider-usage';node.dataset.usageConnectionId=connection.id;node.setAttribute('aria-haspopup','dialog');
  usageViews.set(entry.key,node);paintUsage(entry);void readUsage(connection);return node;
}
function ensureUsageDialog(){
  if(usageDialog)return;
  usageDialog=document.createElement('dialog');usageDialog.id='usage-dialog';usageDialog.className='dialog usage-dialog';usageDialog.setAttribute('aria-labelledby','usage-title');usageDialog.setAttribute('aria-describedby','usage-description');
  usageDialog.innerHTML='<div class="dialog-header"><h2 id="usage-title">Provider limits</h2><p id="usage-description">Quota, credits and request limits reported by this connection.</p></div><button class="dialog-close button button-ghost button-icon" type="button" aria-label="Close limits">×</button><div id="usage-content" class="dialog-body usage-content" aria-live="polite"></div><div class="dialog-footer"><button id="usage-refresh" class="button button-outline button-sm" type="button">Refresh limits</button></div>';
  usageDialog.querySelector('.dialog-close').onclick=()=>closeUsage();
  usageDialog.addEventListener('cancel',event=>{event.preventDefault();closeUsage();});
  usageDialog.querySelector('#usage-refresh').onclick=()=>{if(usageDialogEntry)void readUsage(usageDialogEntry.connection);};
  document.body.append(usageDialog);
}
function showUsage(entry){
  if(!currentUsageEntry(entry))return;
  closeMenus();ensureUsageDialog();usageDialogEntry=entry;usageDialogTrigger=usageViews.get(entry.key);paintUsageDialog();
  if(!usageDialog.open)usageDialog.showModal();usageDialog.querySelector('.dialog-close').focus();void readUsage(entry.connection);
}
function closeUsage(restore=true){
  if(!usageDialog)return;usageDialog.close();usageDialogEntry=null;
  if(restore&&usageDialogTrigger?.isConnected)usageDialogTrigger.focus();
  usageDialogTrigger=null;
}
function appendUsageText(root,text,className='usage-note',tag='p'){
  const node=document.createElement(tag);node.className=className;node.textContent=text;root.append(node);return node;
}
function appendUsageTime(root,label,value){
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return;
  const note=appendUsageText(root,label+' '),time=document.createElement('time');time.dateTime=value;time.textContent=date.toLocaleString();note.append(time);
}
function paintUsageDialog(){
  if(!usageDialogEntry||!usageDialog)return;
  const entry=usageDialogEntry,usage=entry.usage,root=usageDialog.querySelector('#usage-content');root.replaceChildren();
  usageDialog.querySelector('#usage-title').textContent=`Provider limits · ${entry.connection.name}`;
  const refresh=usageDialog.querySelector('#usage-refresh');refresh.textContent=entry.loading?'Refreshing…':'Refresh limits';refresh.dataset.loading=String(entry.loading);refresh.disabled=busy||entry.loading;
  if(entry.error){const alert=appendUsageText(root,entry.error,'usage-error');alert.setAttribute('role','alert');}
  if(!usage){appendUsageText(root,entry.loading?'Loading limits…':'Account limits are unavailable.');return;}
  const description={available:'Account limits are shared across conversations and devices.',unavailable:'Usage information is temporarily unavailable or not reported by this account.',unsupported:'This connection does not expose account limits through its SDK.',not_applicable:'Account quotas do not apply to this local provider.'};
  appendUsageText(root,description[usage.state]);
  if(usage.partial)appendUsageText(root,'Only the reported limits are shown.');
  if(usage.stale||usage.invalidated||limitsSummary(entry).reason?.includes('outdated')||limitsSummary(entry).reason?.includes('reset'))appendUsageText(root,'Last known values · may be outdated','badge usage-stale');
  for(const row of usage.rows){
    const section=document.createElement('div');section.className='usage-row';const heading=document.createElement('div');heading.className='usage-row-heading';
    appendUsageText(heading,usageLabel(row,Date.now(),definition.usage),'usage-row-label','span');appendUsageText(heading,usageAmount(row),'usage-row-amount','span');section.append(heading);
    if(row.unit==='percent'&&Number.isFinite(row.used)&&row.used>=0){const progress=document.createElement('progress');progress.max=100;progress.value=Math.min(100,row.used);progress.setAttribute('aria-label',usageLabel(row,Date.now(),definition.usage)+' used');section.append(progress);}
    if(Number.isFinite(row.used)&&Number.isFinite(row.limit))appendUsageText(section,`${new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(row.used)} / ${new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(row.limit)} ${row.unit==='percent'?'% used':'used'}`);
    if(row.status)appendUsageText(section,'Status: '+String(row.status).replaceAll('_',' '));
    if(row.enabled===false)appendUsageText(section,'Additional usage is not enabled.');
    if(row.resetsAt)appendUsageTime(section,'Resets',row.resetsAt);
    appendUsageTime(section,'Observed',row.observedAt);root.append(section);
  }
  if(!usage.rows.length&&usage.observedAt)appendUsageTime(root,'Last observed',usage.observedAt);
}
function refreshUsageDisplays(){if(document.visibilityState==='hidden')return;for(const entry of usageEntries.values())paintUsage(entry);}
function clearUsage(){closeUsage(false);usageEntries.clear();usageViews.clear();for(const task of usageQueue.splice(0))void task();}

function openEditor(connection=null,trigger=element('add-provider')){
  editing=connection;editorTrigger=trigger;element('connection-form').reset();element('form-title').textContent=connection?`Edit ${connection.name}`:'Add provider';element('form-description').textContent=connection?'Update this connection’s name or settings.':'Configure this provider’s connection.';
  element('name').value=connection?.name??'';element('auth').value=connection?.auth??authOptions[0];element('auth').disabled=!!connection;element('secret').value='';element('hostDirectory').value=connection?.hostDirectory??'';element('baseUrl').value=connection?.baseUrl??'';errorAt('form-error','');fields();closeMenus();element('editor').showModal();element('name').focus();
}
function closeEditor(){if(busy)return;element('secret').value='';editing=null;element('editor').close();(editorTrigger?.isConnected?editorTrigger:element('add-provider')).focus();}
async function showLogin(login,epoch=++loginEpoch){
  if(stopped||epoch!==loginEpoch)return;clearTimeout(loginTimer);activeLogin=login;errorAt('login-error','');const pending=login.status==='pending';element('login-title').textContent=login.status==='complete'?`${loginName} connected`:`Sign in with ${loginName}`;
  element('login-description').textContent=pending?definition.login?.description??'Complete this account’s browser sign-in.':login.status==='complete'?'Your provider is ready to select for a new chat.':login.message??'Sign-in cancelled. Try again from the provider menu.';
  element('login-code-row').hidden=!pending;element('login-code').textContent=login.userCode??'Preparing…';element('copy-code').dataset.unavailable=String(!login.userCode);element('copy-code').disabled=!login.userCode;
  element('login-status').textContent=pending?'Waiting for confirmation…':'';element('login-close').textContent=pending?'Cancel sign-in':'Close';const link=element('login-open');link.hidden=true;link.removeAttribute('href');
  if(pending&&login.verificationUrl){try{const url=new URL(login.verificationUrl);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password){link.href=url.href;link.hidden=false;}}catch{}}
  if(!element('login-dialog').open)element('login-dialog').showModal();
  if(pending)pollLogin(login.id,epoch);else await load();
}
function pollLogin(id,epoch){loginTimer=setTimeout(()=>{if(stopped||epoch!==loginEpoch)return;void request(`/api/settings/logins/${encodeURIComponent(id)}`).then(value=>{if(!stopped&&epoch===loginEpoch)return showLogin(value,epoch);}).catch(error=>{if(stopped||epoch!==loginEpoch)return;reportError(error);if(activeLogin?.id===id&&activeLogin.status==='pending')pollLogin(id,epoch);});},2000);}
async function closeLogin(){
  const login=activeLogin,epoch=++loginEpoch;clearTimeout(loginTimer);
  try{if(login?.status==='pending')await request(`/api/settings/logins/${encodeURIComponent(login.id)}`,'DELETE');}
  catch(error){if(!stopped&&epoch===loginEpoch&&login?.status==='pending')pollLogin(login.id,epoch);throw error;}
  if(stopped||epoch!==loginEpoch)return;activeLogin=null;element('login-dialog').close();await load();focusAfterBusy=[...document.querySelectorAll('[data-connection-id]')].find(node=>node.dataset.connectionId===login?.connectionId)??element('add-provider');
}
element('connection-form').onsubmit=event=>{event.preventDefault();void act(async()=>{
  const auth=element('auth').value,input={name:element('name').value,auth,...(editing?{expectedRevision:editing.revision}:{}),...(element('secret').value?{secret:element('secret').value}:{}),...(authDefinition(auth)?.hostDirectory?{hostDirectory:element('hostDirectory').value}:{}),...(definition.baseUrl?{baseUrl:element('baseUrl').value}:{})};
  const created=!editing,result=await request('/api/settings/connections'+(editing?'/'+encodeURIComponent(editing.id):''),editing?'PUT':'POST',input);
  element('secret').value='';element('editor').close();editing=null;await load('Provider saved. Existing chats keep their provider.');focusAfterBusy=element('add-provider');
  if(created&&authDefinition(auth)?.browserLogin){const saved=result?.saved;if(typeof saved?.id!=='string'||typeof saved.revision!=='string')throw new Error(`Provider saved. Refresh and choose Sign in with ${loginName} from its menu.`);focusAfterBusy=null;await showLogin(await request(`/api/settings/connections/${encodeURIComponent(saved.id)}/login`,'POST',{expectedRevision:saved.revision}));}
});};
element('add-provider').onclick=()=>openEditor();element('clear').onclick=closeEditor;element('editor-close').onclick=closeEditor;
element('editor').addEventListener('cancel',event=>{event.preventDefault();closeEditor();});
element('editor').addEventListener('click',event=>{if(event.target!==element('editor'))return;const box=element('editor').getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)closeEditor();});
element('refresh').onclick=()=>void act(load);element('login-close').onclick=()=>void act(closeLogin);element('login-dialog').addEventListener('cancel',event=>{event.preventDefault();void act(closeLogin);});
element('copy-code').onclick=async()=>{try{await navigator.clipboard.writeText(activeLogin?.userCode??'');element('login-status').textContent='Code copied to clipboard.';}catch{errorAt('login-error','Could not copy automatically. Select the code and copy it manually.');}};
element('signin').onclick=()=>void act(async()=>{
  if(!recovery?.corePublicOrigin||!recovery?.appId||recovery?.appAuthProtocol!==2)throw new Error('Core browser sign-in is unavailable. Start this application through a compatible Hosty Core and refresh.');
  const openUrl=providerSignInUrl(recovery,window.location.origin);await exchange(await openAppSignIn(openUrl,undefined,2));await load();
});
document.addEventListener('click',closeMenus);
export function stopProviderSettings(){stopped=true;loginEpoch++;clearTimeout(loginTimer);activityStop?.();continuityStop?.();stopTheme();clearInterval(usageClock);document.removeEventListener('visibilitychange',refreshUsageDisplays);clearUsage();usageDialog?.remove();document.removeEventListener('click',closeMenus);}
restoreAppGrant();void load().catch(reportError);
