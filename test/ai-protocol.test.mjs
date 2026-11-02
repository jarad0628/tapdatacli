import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {App} from '../dist/commands.js';
import {AI} from '../dist/ai.js';
import {Store} from '../dist/store.js';

function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'tapdatacli-protocol-'));
  const store = new Store(home); store.acquire();
  const app = new App(store), executed = [], original = app.execute.bind(app);
  app.execute = async argv => { executed.push(argv); return original(argv); };
  t.after(async () => { await app.close(); rmSync(home, {recursive: true, force: true}); });
  return {home, store, app, executed};
}

for (const provider of ['codex', 'claude', 'api']) {
  for (const repairable of [true, false]) {
    test(`${provider}: ${repairable ? 'repair prose then discover real directory' : 'reject repeated prose without executing commands'}`, async t => {
      const {home, store, app, executed} = setup(t);
      const directory = join(home, '连接器 包'); mkdirSync(directory);
      writeFileSync(join(directory, 'mysql.jar'), 'test fixture, not a loadable JAR');
      writeFileSync(join(directory, 'notes.txt'), 'not a jar');
      const replies = ['已收到路径，准备加载。', repairable ? JSON.stringify({message: '先查看目录', command: ['connector', 'discover', '--dir', directory], done: false}) : '已收到路径，但仍然不是 JSON', JSON.stringify({message: '目录中没有 Postgres JAR，只有 mysql.jar。', command: [], done: true})];
      const prompts = []; let calls = 0;
      const binding = {name: provider, provider, model: 'test-model'};
      if (provider === 'api') {
        const server = createServer((req, res) => {
          let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
            prompts.push(JSON.parse(body));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({choices: [{message: {content: replies[calls++]}}]}));
          });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(() => new Promise(resolve => server.close(resolve)));
        binding.url = `http://127.0.0.1:${server.address().port}`;
        binding.keyEnv = 'TAPDATACLI_PROTOCOL_TEST_KEY';
        process.env[binding.keyEnv] = 'local-fixture'; t.after(() => delete process.env[binding.keyEnv]);
      } else {
        const fixture = join(home, 'fixture.json'), log = join(home, 'requests.json');
        writeFileSync(fixture, JSON.stringify(replies));
        const executable = join(home, 'mock-provider.mjs');
        writeFileSync(executable, `#!/usr/bin/env node
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
const fixture = ${JSON.stringify(fixture)}, log = ${JSON.stringify(log)};
const prompt = readFileSync(0, 'utf8');
const requests = existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) : [];
const reply = JSON.parse(readFileSync(fixture, 'utf8'))[requests.length];
requests.push(prompt); writeFileSync(log, JSON.stringify(requests));
const args = process.argv.slice(2);
if (${JSON.stringify(provider)} === 'codex') writeFileSync(args[args.indexOf('-o') + 1], reply);
else { let structured; try { structured = JSON.parse(reply); } catch {} process.stdout.write(JSON.stringify(structured ? {structured_output: structured} : {result: reply})); }
`, {mode: 0o700});
        binding.command = executable;
      }
      store.state.bindings = [binding]; store.state.activeBinding = provider;
      const messages = [], ai = new AI(app);
      const run = () => ai.ask('帮我加载postgres连接器，连接器路径都在' + directory, new AbortController().signal, text => messages.push(text));
      if (repairable) {
        const result = await run();
        assert.equal(result.steps.length, 1);
        assert.deepEqual(executed, [['connector', 'discover', '--dir', directory]]);
        assert.deepEqual(result.steps[0].result.data.jars, [{name: 'mysql.jar', path: join(directory, 'mysql.jar')}]);
        assert.match(result.message, /没有 Postgres/);
      } else {
        await assert.rejects(run, /AI 返回格式不符合命令协议/);
        assert.deepEqual(executed, []);
      }
      const requests = provider === 'api' ? prompts : JSON.parse(readFileSync(join(home, 'requests.json'), 'utf8'));
      assert.equal(requests.length, repairable ? 3 : 2);
      assert.match(JSON.stringify(requests[1]), /no command from it was executed/);
      assert.equal(messages.filter(text => text.includes('正在自动纠正')).length, 1);
      assert.ok(!messages.includes(replies[0]));
      if (provider !== 'api') assert.match(requests[0], /# Required response protocol/);
    });
  }
}

test('connector discover requires a directory, reports bounded results and does not load artifacts', async t => {
  const {home, app, store} = setup(t);
  await assert.rejects(app.execute(['connector', 'discover']), /Missing --dir/);
  const directory = join(home, 'dist'); mkdirSync(directory);
  for (let i = 0; i < 201; i++) writeFileSync(join(directory, `fixture-${i}.jar`), 'fixture');
  mkdirSync(join(directory, 'directory.jar'));
  const result = await app.execute(['connector', 'discover', '--dir', directory]);
  assert.equal(result.total, 201); assert.equal(result.jars.length, 200); assert.equal(result.truncated, true);
  assert.deepEqual(store.state.connectors, []);
});
