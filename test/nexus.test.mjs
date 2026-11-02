import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Nexus, connectorName } from '../dist/nexus.js';
import { App } from '../dist/commands.js';
import { Store } from '../dist/store.js';
import { AI } from '../dist/ai.js';
const bytes = readFileSync(resolve('runtime/local-json-connector.jar'));
const digest = createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
    const home = mkdtempSync(join(tmpdir(), 'tapdatacli-nexus-'));
    const f = { home, downloads: 0, queries: [], mode: 'ok', cleanup: [], aiBodies: [] };
    const previous = process.env.TAPDATACLI_NEXUS_URL;
    const server = createServer((req, res) => {
        const url = new URL(req.url, f.url);
        if (url.pathname.endsWith('/chat/completions')) {
            let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
                f.aiBodies.push(JSON.parse(body));
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(f.aiBodies.length === 1 ? { message: '下载并加载连接器', command: ['connector', 'load', 'local-json'], done: false } : { message: '已根据真实结果加载', command: [], done: true }) } }] }));
            });
        } else if (url.pathname.endsWith('/search')) {
            f.queries.push(url.searchParams);
            if (f.mode === 'auth') { res.writeHead(401).end(); return; }
            const artifact = url.searchParams.get('name') ?? 'local-json-connector';
            const version = url.searchParams.get('version') ?? '1.0.0';
            const asset = { downloadUrl: f.url + '/repository/maven-releases/io/tapdata/local-json-connector/' + version + '/connector.jar', checksum: { sha256: f.mode === 'bad-hash' ? '0'.repeat(64) : digest }, fileSize: bytes.length, maven2: { extension: 'jar' } };
            if (f.mode === 'foreign') asset.downloadUrl = 'https://example.com/connector.jar';
            if (f.mode === 'missing-hash') asset.checksum = {};
            const item = { group: 'io.tapdata', name: artifact, version, assets: [{ ...asset, maven2: { extension: 'jar', classifier: 'sources' } }, asset] };
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ items: f.mode === 'empty' ? [] : [item], continuationToken: f.mode === 'pagination' && !url.searchParams.has('continuationToken') ? 'second' : null }));
        } else {
            f.downloads++;
            if (f.mode === 'slow') { res.writeHead(200); res.write(bytes.subarray(0, 2)); return; }
            if (f.mode === 'redirect') { res.writeHead(302, { Location: 'https://example.com/connector.jar' }).end(); return; }
            res.end(bytes);
        }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    f.url = `http://127.0.0.1:${server.address().port}`;
    process.env.TAPDATACLI_NEXUS_URL = f.url;
    t.after(async () => {
        for (const close of f.cleanup) await close();
        if (previous === undefined) delete process.env.TAPDATACLI_NEXUS_URL; else process.env.TAPDATACLI_NEXUS_URL = previous;
        server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(home, { recursive: true, force: true });
    });
    return f;
}
test('aliases and invalid names', () => {
    assert.equal(connectorName('PostgreSQL'), 'postgres-connector');
    assert.equal(connectorName('postgres-connector'), 'postgres-connector');
    assert.throws(() => connectorName('../evil'));
});
test('download verifies real JAR, reuses and repairs cache; pins versions', async t => {
    const f = await fixture(t), nexus = new Nexus(f.home);
    const first = await nexus.download('local-json', '1.0.0');
    assert.equal(first.cached, false); assert.deepEqual(readFileSync(first.jar), bytes);
    assert.equal((await nexus.download('local-json', '1.0.0')).cached, true); assert.equal(f.downloads, 1);
    writeFileSync(first.jar, 'corrupt');
    assert.equal((await nexus.download('local-json', '1.0.0')).cached, false); assert.equal(f.downloads, 2);
    assert.equal(f.queries[0].get('version'), '1.0.0'); assert.equal(f.queries[0].get('sort'), 'version');
});
test('pagination and sources filtering; missing version is actionable', async t => {
    const f = await fixture(t), nexus = new Nexus(f.home);
    f.mode = 'pagination'; assert.equal((await nexus.search()).length, 2);
    assert.equal(f.queries[1].get('continuationToken'), 'second');
    f.mode = 'empty'; await assert.rejects(nexus.download('postgres'), /no published io.tapdata:postgres-connector/);
    assert.equal(f.downloads, 0);
});
test('rejects checksum failures, missing checksums, foreign URLs, redirects and auth errors', async t => {
    const f = await fixture(t), nexus = new Nexus(f.home);
    for (const [mode, pattern] of [['bad-hash', /SHA-256 mismatch/], ['missing-hash', /missing SHA-256/], ['foreign', /untrusted/], ['redirect', /request failed/], ['auth', /HTTP 401/]]) {
        f.mode = mode; await assert.rejects(nexus.download('local-json'), pattern);
    }
    assert.equal(existsSync(join(f.home, 'downloads', '0'.repeat(64), 'connector.jar')), false);
    assert.ok(readdirSync(join(f.home, 'downloads'), { recursive: true }).every(x => !x.endsWith('.partial')));
});
test('abort removes partial downloads', async t => {
    const f = await fixture(t), nexus = new Nexus(f.home); f.mode = 'slow';
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 150);
    await assert.rejects(nexus.download('local-json', undefined, { signal: abort.signal })); clearTimeout(timer);
    assert.ok(readdirSync(join(f.home, 'downloads'), { recursive: true }).every(x => !x.endsWith('.partial') && !x.endsWith('.jar')));
});
test('name-based load uses real Java inspection and update keeps datasource pinned', async t => {
    const f = await fixture(t), store = new Store(f.home); store.acquire();
    const app = new App(store); f.cleanup.push(() => app.close());
    const downloaded = await app.execute(['connector', 'download', 'local-json']); assert.equal(downloaded.cached, false);
    assert.equal(store.state.connectors.length, 0);
    const loaded = await app.execute(['connector', 'load', 'local-json']);
    assert.equal(loaded.pdkId, 'local-json'); assert.equal(loaded.origin.artifactId, 'local-json-connector');
    assert.equal(f.downloads, 1);
    await app.execute(['datasource', 'create', 'demo', '--pdk-id', 'local-json', '--set', 'path=' + resolve('examples/customers.json')]);
    await app.execute(['connector', 'update', loaded.id, '--version', '2.0.0']);
    assert.equal(store.state.datasources[0].connectorId, loaded.id);
    assert.equal((await app.execute(['datasource', 'test', 'demo'])).passed, true);
    await assert.rejects(app.execute(['connector', 'load', 'postgres', '--jar', downloaded.jar]), /either a local/);
    assert.match(app.contextText(), /automatically resolves and downloads/);
});

test('natural language provider loop loads by name and receives real Nexus and Java results', async t => {
    const f = await fixture(t), store = new Store(f.home); store.acquire();
    const app = new App(store); f.cleanup.push(() => app.close());
    const previousKey = process.env.TAPDATACLI_NEXUS_TEST_KEY;
    process.env.TAPDATACLI_NEXUS_TEST_KEY = 'test-only';
    t.after(() => { if (previousKey === undefined) delete process.env.TAPDATACLI_NEXUS_TEST_KEY; else process.env.TAPDATACLI_NEXUS_TEST_KEY = previousKey; });
    await app.execute(['ai', 'bind', 'api', '--url', f.url + '/v1', '--key-env', 'TAPDATACLI_NEXUS_TEST_KEY', '--model', 'test']);
    const result = await new AI(app).ask('帮我下载并加载 local-json 连接器', new AbortController().signal, () => {});
    assert.equal(result.steps[0].result.data.pdkId, 'local-json');
    assert.equal(f.downloads, 1); assert.equal(store.state.connectors.length, 1);
    assert.match(f.aiBodies[1].messages.at(-1).content, /"artifactId":"local-json-connector"/);
});

test('script entry preserves connector --version and emits clean JSON', async t => {
    const f = await fixture(t);
    const { stdout } = await promisify(execFile)(process.execPath, ['bin/tapdatacli.mjs', 'connector', 'download', 'local-json', '--version', '3.2.1', '--json'], { env: { ...process.env, TAPDATACLI_HOME: f.home }, timeout: 15000 });
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true); assert.equal(result.data.version, '3.2.1');
    assert.equal(f.queries[0].get('version'), '3.2.1');
    assert.equal(f.downloads, 1);
});
