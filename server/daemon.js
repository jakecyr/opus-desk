import {spawn,execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=path.join(os.homedir(),'.local','share','prquay'), pidfile=path.join(dir,'daemon.pid'), entry=path.join(path.dirname(fileURLToPath(import.meta.url)),'index.js');
fs.mkdirSync(dir,{recursive:true,mode:0o700});
function pid(){try{const n=Number(fs.readFileSync(pidfile,'utf8'));if(!Number.isSafeInteger(n)||n<2)return null;process.kill(n,0);const command=execFileSync('ps',['-p',String(n),'-o','command='],{encoding:'utf8'});if(!command.includes(entry))return null;return n}catch{return null}}
const action=process.argv[2];if(action==='start'){if(pid()){console.log(`Already running (PID ${pid()})`);process.exit(0)}const log=fs.openSync(path.join(dir,'daemon.log'),'a',0o600);const p=spawn(process.execPath,[entry],{detached:true,stdio:['ignore',log,log],cwd:path.dirname(entry)});p.unref();fs.writeFileSync(pidfile,String(p.pid),{mode:0o600});console.log(`Started PR Quay (PID ${p.pid}) at http://127.0.0.1:4317`)}else if(action==='status'){console.log(pid()?`Running (PID ${pid()})`:'Stopped')}else if(action==='stop'){const n=pid();if(n){process.kill(n,'SIGTERM');console.log(`Stopped PID ${n}`)}else console.log('Already stopped');try{fs.unlinkSync(pidfile)}catch{}}else{console.error('Usage: node server/daemon.js start|stop|status');process.exitCode=1}
