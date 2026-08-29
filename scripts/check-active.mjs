import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
const roots=['server.js','registerCommands.js','cogs','routes','utils','logic/duelSessions.js','logic/duelActions.js','logic/chatRegistry.js'];
const files=[];
for(const item of roots){const p=path.resolve(item);if(!fs.existsSync(p))continue;const st=fs.statSync(p);if(st.isFile())files.push(p);else for(const f of fs.readdirSync(p))if(f.endsWith('.js'))files.push(path.join(p,f));}
let failed=0;
for(const f of [...new Set(files)]){try{execFileSync(process.execPath,['--check',f],{stdio:'pipe'});}catch(e){failed++;console.error(`FAIL ${path.relative(process.cwd(),f)}\n${String(e.stderr||e.message)}`);}}
if(failed)process.exit(1);console.log(`Active syntax check passed (${new Set(files).size} files).`);
