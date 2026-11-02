import {spawnSync} from 'node:child_process';
import {mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
function run(cmd,args){const r=spawnSync(cmd,args,{cwd:root,stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);}
run('npx',['--no-install','tsc']);
run('mvn',[...(process.env.MAVEN_OFFLINE==='1'?['-o']:[]),'-B','-q','-f','java/pom.xml','-DskipTests','package']);
mkdirSync(root+'runtime',{recursive:true});
copyFileSync(root+'java/engine/target/mini-engine.jar',root+'runtime/mini-engine.jar');
copyFileSync(root+'java/file-connector/target/local-json-connector-0.1.0.jar',root+'runtime/local-json-connector.jar');
console.log('Built TypeScript CLI + Java 17 engine + local JSON PDK connector. Run ./bin/tapdatacli.mjs');
