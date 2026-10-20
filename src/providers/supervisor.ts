/** Runs as a separate Node process. The IPC pipe closes even when our parent is
 * SIGKILLed; native agents never survive that disconnect. No credentials pass
 * through IPC and stdout/stderr remain the native agent's existing pipes. */
export const SUPERVISOR_SOURCE = String.raw`
const {spawn} = require('node:child_process');
const {readFileSync,readdirSync} = require('node:fs');
const [binary,argsJSON]=process.argv.slice(1);
let child, leaderBirth, stopped=false, finishing=false, status=1;
const owned=new Map();
function info(pid) {
  try { const s=readFileSync('/proc/'+pid+'/stat','utf8'); const f=s.slice(s.lastIndexOf(')')+2).split(' ');
    return {parent:Number(f[1]),group:Number(f[2]),birth:f[19]}; } catch { return null; }
}
function signalPid(pid,birth,signal) {
  if(process.platform==='linux') { const s=info(pid); if(!s||s.birth!==birth)return; }
  try {process.kill(pid,signal);}catch{}
}
function remember() {
  if(process.platform!=='linux'||!child?.pid)return;
  const leader=info(child.pid);
  if(!leader||leader.birth!==leaderBirth)return;
  const candidates=[];
  for(const name of readdirSync('/proc')) {
    if(!/^\d+$/.test(name))continue;
    const pid=Number(name), s=info(pid);
    if(s)candidates.push([pid,s]);
  }
  // Also track descendants that start their own groups (for example a test
  // runner). Only a still-matching owned parent establishes that relationship.
  let changed=true;
  while(changed) {
    changed=false;
    for(const [pid,s]of candidates) {
      const parentBirth=owned.get(s.parent), parent=parentBirth&&info(s.parent);
      if(s.group===child.pid || (parent&&parent.birth===parentBirth)) {
        if(owned.get(pid)!==s.birth) {owned.set(pid,s.birth);changed=true;}
      }
    }
  }
}
function signalOwned(signal) {
  if(!child?.pid)return;
  if(process.platform==='linux') {
    remember();
    const leader=info(child.pid);
    if(leader?.birth===leaderBirth) {
      // A matching live leader proves the group still belongs to this launch.
      try {process.kill(-child.pid,signal);}catch{}
    }
    for(const [pid,birth]of owned)signalPid(pid,birth,signal);
  } else if(process.platform!=='win32') {try{process.kill(-child.pid,signal);}catch{}}
  else child.kill(signal);
}
function finish() {
  if(finishing)return;finishing=true;clearInterval(poll);
  signalOwned('SIGKILL');
  setTimeout(()=>process.exit(status),25);
}
function stop() {
  if(stopped)return; stopped=true;
  signalOwned('SIGTERM');setTimeout(finish,700);
}
process.on('disconnect',stop);
process.on('SIGTERM',stop);process.on('SIGINT',stop);
child=spawn(binary,JSON.parse(argsJSON),{stdio:'inherit',detached:process.platform!=='win32'});
if(child.pid) {leaderBirth=info(child.pid)?.birth; if(leaderBirth)owned.set(child.pid,leaderBirth);}
// Periodic scans keep descendants attributable after an intermediate parent
// exits; stop() rescans immediately. Every tick reads all of /proc, so keep it slow.
const poll=setInterval(remember,500);
child.on('error',error=>{
  process.send?.({type:'spawn_error',code:error.code});status=127;finish();
});
child.on('exit',(code,signal)=>{status=code??1;finish();});
if(!process.connected)stop();
`;
