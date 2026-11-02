import {mkdtempSync,cpSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const tmp=mkdtempSync(join(tmpdir(),'tapdatacli-bundle-'));const folder=join(tmp,'tapdatacli');mkdirSync(folder);
for(const f of ['bin','dist','runtime','examples','docs','README.md','package.json'])cpSync(f,join(folder,f),{recursive:true});
const result=spawnSync('tar',['-czf','tapdatacli-0.1.0.tar.gz','-C',tmp,'tapdatacli'],{stdio:'inherit'});if(result.status)process.exit(result.status);
console.log('Created tapdatacli-0.1.0.tar.gz (requires Node.js 22+ and Java 17+)');
