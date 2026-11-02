import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { App } from '../dist/commands.js';
import { Store } from '../dist/store.js';
import { AI } from '../dist/ai.js';

function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'tapdatacli local 中文 '));
  const store = new Store(home); store.acquire();
  const app = new App(store);
  t.after(async () => { await app.close(); rmSync(home, {recursive: true, force: true}); });
  const run = (code, options = {}, extra = []) => app.execute(['local', 'exec', '--cwd', home, '--argv', JSON.stringify([process.execPath, '-e', code]), ...extra], options);
  return {home, store, app, run};
}

test('local exec preserves cwd, Unicode and shell metacharacters as literal arguments', async t => {
  const {app, home} = setup(t);
  const literal = '中文 path; $(touch BAD) `touch BAD`';
  const result = await app.execute(['local', 'exec', '--cwd', home, '--argv', JSON.stringify([process.execPath, '-e', 'console.log(JSON.stringify([process.cwd(),process.argv[1]]))', literal])]);
  assert.deepEqual(JSON.parse(result.stdout), [home, literal]);
  assert.equal(result.exitCode, 0);
  assert.equal(readFileSync(result.log, 'utf8'), result.stdout);
});

test('local exec returns bounded output, a complete log and real failure details', async t => {
  const {run} = setup(t); const updates = [];
  await assert.rejects(run('console.log("x".repeat(20000)); console.error("compile failed"); process.exitCode=7', {onOutput: x => updates.push(x)}), e => {
    assert.equal(e.details.exitCode, 7); assert.equal(e.details.status, 'failed');
    assert.equal(e.details.truncated, true); assert.ok(e.details.stdout.length <= 12000);
    assert.match(e.details.stderr, /compile failed/);
    assert.ok(readFileSync(e.details.log, 'utf8').length > 20000);
    return true;
  });
  assert.ok(updates.length);
});

test('local exec validates arguments and reports missing executables', async t => {
  const {app, home, run} = setup(t);
  for (const argv of ['[]', '{}', '[1]', '[""]', '["node",null]'])
    await assert.rejects(app.execute(['local', 'exec', '--cwd', home, '--argv', argv]), /--argv/);
  await assert.rejects(run('', {}, ['--timeout', '0']), /--timeout/);
  await assert.rejects(app.execute(['local', 'exec', '--cwd', home, '--argv', '["/no-such-executable"]']), /Cannot start/);
});

test('local exec timeout and cancellation stop active processes', async t => {
  const {run} = setup(t);
  await assert.rejects(run('setInterval(()=>{},100)', {}, ['--timeout', '1']), e => e.details.status === 'timeout');
  const abort = new AbortController();
  const pending = run('setInterval(()=>{},100)', {signal: abort.signal});
  setTimeout(() => abort.abort(), 100);
  await assert.rejects(pending, e => e.details.status === 'cancelled');
});

test('closing the app waits for a process that ignores SIGTERM', {skip: process.platform === 'win32'}, async t => {
  const {app, run} = setup(t);
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const pending = run('process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},100)', {onOutput: () => ready()});
  // Attach rejection handling before close requests cancellation.
  const checked = assert.rejects(pending, e => e.details.status === 'cancelled' && e.details.signal === 'SIGKILL');
  await started;
  await app.close();
  await checked;
});

for (const provider of ['codex', 'claude', 'api']) {
  test(`${provider}: AI runs local build then discovers the actual artifact`, async t => {
    const {home, app, store} = setup(t);
    const artifact = join(home, 'postgres-fixture.jar');
    const replies = [
      {message: '编译', command: ['local', 'exec', '--cwd', home, '--argv', JSON.stringify([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(artifact)},'fixture');console.log('build complete')`])], done: false},
      {message: '扫描构建目录', command: ['connector', 'discover', '--dir', home], done: false},
      {message: '已编译并发现 postgres-fixture.jar', command: [], done: true}
    ];
    const binding = {name: provider, provider};
    const prompts = [];
    if (provider === 'api') {
      const server = createServer((req, res) => { let body = ''; req.on('data', x => body += x); req.on('end', () => { const reply = replies[prompts.length]; prompts.push(JSON.parse(body)); res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(reply)}}]})); }); });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise(resolve => server.close(resolve)));
      binding.url = `http://127.0.0.1:${server.address().port}`;
      binding.keyEnv = 'TAPDATACLI_LOCAL_TEST_KEY'; process.env[binding.keyEnv] = 'fixture';
      t.after(() => delete process.env[binding.keyEnv]);
    } else {
      const log = join(home, 'prompts.json'), executable = join(home, 'provider.mjs');
      writeFileSync(executable, `#!/usr/bin/env node
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const log=${JSON.stringify(log)}, requests=existsSync(log)?JSON.parse(readFileSync(log,'utf8')):[];
const reply=${JSON.stringify(replies)}[requests.length];
requests.push(readFileSync(0,'utf8'));writeFileSync(log,JSON.stringify(requests));
const args=process.argv.slice(2);
if (${JSON.stringify(provider)}==='codex') writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(reply));
else console.log(JSON.stringify({structured_output:reply}));
`, {mode:0o700});
      binding.command = executable;
    }
    store.state.bindings = [binding]; store.state.activeBinding = provider;
    const result = await new AI(app).ask('编译连接器后检查目录', new AbortController().signal, () => {});
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[0].result.data.exitCode, 0);
    assert.equal(result.steps[1].result.data.jars[0].path, artifact);
    const requests = provider === 'api' ? prompts : JSON.parse(readFileSync(join(home, 'prompts.json'), 'utf8'));
    assert.match(JSON.stringify(requests[1]), /build complete/);
    assert.match(JSON.stringify(requests[2]), /postgres-fixture.jar/);
  });
}
