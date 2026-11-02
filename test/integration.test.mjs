import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync,statSync,copyFileSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {App} from '../dist/commands.js';
import {AI} from '../dist/ai.js';
import {Store} from '../dist/store.js';
import {tokenize} from '../dist/parse.js';
const root=resolve(import.meta.dirname,'..'),jar=join(root,'runtime/local-json-connector.jar');
function workspace(t){const home=mkdtempSync(join(tmpdir(),'tapdatacli-test-'));t.cleanup=[];t.after(async()=>{for(const close of t.cleanup)await close();rmSync(home,{recursive:true,force:true});});return home;}
function cli(home,args,expected=0){const r=spawnSync(process.execPath,[join(root,'bin/tapdatacli.mjs'),...args,'--json'],{env:{...process.env,TAPDATACLI_HOME:home},encoding:'utf8',timeout:20000});assert.equal(r.status,expected,r.stderr+'\n'+r.stdout);const v=JSON.parse(r.stdout);assert.equal(v.ok,expected===0);return v;}
function load(home){return cli(home,['connector','load','--jar',jar]).data;}
function create(home,name='demo',extra=[]){return cli(home,['datasource','create',name,'--pdk-id','local-json','--set','path='+join(root,'examples/customers.json'),...extra]).data;}
test('real Java / PDK JAR lifecycle, persisted config, metadata, sample and CSV export',t=>{
 const home=workspace(t);assert.equal(cli(home,['init']).data.engine.protocolVersion,1);
 const c=load(home);assert.equal(c.pdkId,'local-json');assert.equal(c.capabilities.batchRead,true);
 create(home,'客户库',['--set','password=do-not-store-plaintext']);
 assert.ok(!readFileSync(join(home,'state.json'),'utf8').includes('do-not-store-plaintext'));
 assert.equal(statSync(join(home,'key')).mode&0o777,0o600);
 assert.equal(cli(home,['datasource','test','客户库']).data.passed,true);
 const models=cli(home,['datasource','load','客户库']).data.tables;assert.deepEqual(models.map(x=>x.id),['customers','orders']);
 const sample=cli(home,['datasource','sample','客户库','--table','customers','--limit','2']).data;assert.equal(sample.count,2);assert.equal(sample.rows[0].name,'张三');
 cli(home,['datasource','sample','客户库','--table','customers','--limit','101'],1);
 cli(home,['connector','unload',c.id],1);
 const updatedJar=join(home,'updated.jar');copyFileSync(jar,updatedJar);appendFileSync(updatedJar,'\n');
 const updated=cli(home,['connector','update',c.id,'--jar',updatedJar]).data;
 assert.notEqual(updated.id,c.id);assert.equal(cli(home,['datasource','describe','客户库']).data.connectorId,c.id);
 cli(home,['datasource','create','ambiguous','--pdk-id','local-json','--set','path=x'],1);
 cli(home,['connector','unload',updated.id]);
 const output=join(home,'customers.csv');cli(home,['task','create','export','--source','客户库','--table','customers','--output',output,'--exclude','phone']);
 const result=cli(home,['task','start','export']).data;assert.equal(result.status,'succeeded');assert.equal(result.written,3);
 const csv=readFileSync(output,'utf8');assert.ok(csv.includes('张三'));assert.ok(!csv.includes('phone'));assert.equal(csv.trim().split('\n').length,4);
 cli(home,['task','start','export'],1);assert.equal(readFileSync(output,'utf8'),csv);
 cli(home,['datasource','modify','客户库','--set','path=/missing-file.json']);assert.equal(cli(home,['datasource','describe','客户库']).data.modelStatus,'stale');
 const failed=cli(home,['datasource','test','客户库'],1);assert.equal(failed.error.details.checks[0].result,10);
 cli(home,['datasource','drop','客户库'],1);cli(home,['task','drop','export']);cli(home,['datasource','drop','客户库']);cli(home,['connector','unload',c.id]);
 assert.equal(cli(home,['connector','list']).data[0].loaded,false);load(home);assert.equal(cli(home,['connector','list']).data[0].loaded,true);
});
test('cancel an active export and confirm final state',async t=>{
 const home=workspace(t);load(home);const path=join(home,'big.json');writeFileSync(path,JSON.stringify({rows:Array.from({length:100000},(_,i)=>({id:i,text:'中文记录'+i}))}));
 cli(home,['datasource','create','big','--pdk-id','local-json','--set','path='+path]);cli(home,['task','create','big-export','--source','big','--table','rows','--output',join(home,'big.csv')]);
 const store=new Store(home);store.acquire();const app=new App(store);app.interactive=true;t.cleanup.push(()=>app.close());
 await app.execute(['task','start','big-export']);const promise=[...app.running.values()][0].promise;void promise.catch(()=>{});
 await app.execute(['task','stop','big-export']);await assert.rejects(promise);assert.equal(store.state.tasks[0].status,'cancelled');assert.ok(!existsSync(join(home,'big.csv')));
});
test('API natural language loop executes registry command and feeds actual result back',async t=>{
 const home=workspace(t);const bodies=[];let call=0;
 const server=createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{bodies.push(JSON.parse(body));call++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(call===1?{message:'查看已加载的连接器',command:['connector','list'],done:false}:{message:'当前没有加载连接器',command:[],done:true})}}]}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 process.env.TAPDATACLI_TEST_KEY='local-test-only';t.after(()=>delete process.env.TAPDATACLI_TEST_KEY);
 const store=new Store(home);store.acquire();const app=new App(store);t.cleanup.push(()=>app.close());
 await app.execute(['ai','bind','api','--url',`http://127.0.0.1:${server.address().port}/v1`,'--key-env','TAPDATACLI_TEST_KEY','--model','test-model']);
 const ai=new AI(app),messages=[];const result=await ai.ask('有哪些连接器？',new AbortController().signal,x=>messages.push(x));
 assert.equal(result.steps.length,1);assert.deepEqual(result.steps[0].result.data,[]);assert.equal(bodies[1].messages.at(-1).content,'Actual command result: {"ok":true,"data":[]}');
 assert.ok(!JSON.stringify(bodies).includes(process.env.TAPDATACLI_TEST_KEY));assert.ok(!readFileSync(join(home,'state.json'),'utf8').includes(process.env.TAPDATACLI_TEST_KEY));
});
test('argument parser preserves quoted names and never invokes shell',t=>{
 assert.deepEqual(tokenize('datasource test "客户 连接"'),['datasource','test','客户 连接']);assert.throws(()=>tokenize('x "unfinished'));
 const home=workspace(t),marker=join(home,'should-not-exist');cli(home,['connector','load','--jar',jar,'--nonsense'],1);cli(home,['datasource','drop',`$(touch ${marker})`],1);assert.ok(!existsSync(marker));
});
