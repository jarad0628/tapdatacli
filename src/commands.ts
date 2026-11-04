import { readFileSync, copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store, redact, RecordData } from './store.js';
import { Engine, root } from './engine.js';
import { parse } from './parse.js';
import { Nexus } from './nexus.js';
import { LocalProcesses, ExecutionOptions } from './local.js';
export const commands = [
    ['local exec', '--cwd DIR --argv JSON_ARRAY [--timeout SECONDS]; run a local program (default 1800s, max 7200s)'],
    ['test run', '--repo DIR --module CONNECTOR [--suite integration|performance|tpcc|long-transaction] [--datasource NAME] [--timeout SECONDS]; run connector repository Failsafe ITs'],
    ['init', 'Prepare local workspace and check engine'], ['doctor', 'Check Node / Java engine readiness'], ['help', 'Show command reference'],
    ['connector list', 'List loaded and unloaded connectors'], ['connector discover', '--dir DIR; list local JAR paths without loading them'], ['connector search', '[NAME] [--repository REPO]; list published Nexus JARs'], ['connector download', 'NAME [--version VERSION] [--repository REPO]; download without loading'], ['connector load', '[NAME --version VERSION --repository REPO] | --jar PATH [--deps DIR] [--class CLASS]'], ['connector update', 'REF [--version VERSION --repository REPO] | REF --jar PATH; existing datasources keep their version'], ['connector unload', 'REF; rejects datasource references'], ['connector describe', 'REF'],
    ['datasource create', 'NAME --pdk-id ID [--connector REF] [--config FILE] [--set KEY=JSON_OR_STRING]...'], ['datasource modify', 'NAME [--config FILE] [--set KEY=VALUE]...'], ['datasource drop', 'NAME; removes only local configuration'], ['datasource list', 'List named connections (credentials redacted)'], ['datasource test', 'NAME; actual connector connectionTest'], ['datasource capabilities', 'NAME; list actual registered PDK functions and CLI mappings'], ['datasource tables', 'NAME; connector table names, requires getTableNames'], ['datasource table-info', 'NAME --table TABLE; row count/storage estimate when connector provides it'], ['datasource load', 'NAME [--table TABLE]; discover and cache metadata'], ['datasource describe', 'NAME [--table TABLE]'], ['datasource sample', 'NAME --table TABLE [--limit 10]; first rows, at most 100'], ['datasource page', 'NAME --table TABLE [--limit 20] [--cursor TOKEN]; continue a bounded batchRead'], ['datasource count', 'NAME --table TABLE; requires batchCount'], ['datasource indexes', 'NAME --table TABLE; requires queryIndexes'], ['datasource constraints', 'NAME --table TABLE; requires queryConstraints'], ['datasource minmax', 'NAME --table TABLE --field FIELD [--filter JSON]; requires queryFieldMinMaxValue'], ['datasource now', 'NAME; connector server time, requires getCurrentTimestamp'], ['datasource query', 'NAME --table TABLE [--filter JSON] [--sort JSON] [--skip N] [--limit N] [--fields CSV]; requires queryByAdvanceFilter'], ['datasource sql', 'NAME --type query|execute --sql SQL --yes; requires executeCommandV2'], ['datasource command', 'NAME --command COMMAND [--params JSON] --yes; connector-defined command via executeCommand'],
    ['datasource stream', 'NAME [--table TABLE] [--since ISO_TIME] [--record-size 20]; foreground streamRead, Ctrl+C stops'],
    ['task create', 'NAME --source DATASOURCE --table TABLE --output FILE [--exclude COL,COL]'], ['task list', 'List local CSV export plans and runs'], ['task describe', 'NAME'], ['task start', 'NAME; export CSV without overwriting; foreground in scripts, background in REPL'], ['task status', 'NAME'], ['task stop', 'NAME; request cancellation of this session run'], ['task drop', 'NAME; removes local plan, preserves output files'],
    ['ai bind', 'codex|claude|api [--name NAME] [--command PATH] [--url BASE_URL] [--key-env ENV] [--model MODEL]'], ['ai list', 'Show saved AI bindings'], ['ai status', 'Show current binding'], ['ai use', 'NAME'], ['ai unbind', 'NAME'], ['ai native', 'Open bound CLI with Tapdata context in a managed directory'], ['ai models', 'Discover API models; CLI models use provider native entry'], ['model', '[MODEL_ID]; show or set current model'], ['ask', 'TEXT; run natural language through bound AI'], ['exit', 'Leave interactive session']
] as const;
export const help = () => ['Tapdata CLI 0.1.0 · TypeScript + Java PDK Mini Engine', 'Use /commands in chat; use tapdatacli commands in scripts.', '', ...commands.map(([n, d]) => `  ${n.padEnd(23)} ${d}`), '', 'Global: --output json | --json; workspace: TAPDATACLI_HOME; Java: TAPDATACLI_JAVA', 'Example: connector load --jar ' + join(root, 'runtime/local-json-connector.jar')].join('\n');
function required(value: string | undefined, label: string): string { if (value === undefined || value === '' || value === 'true')
    throw new Error(`Missing ${label}`); return value; }
function sha(path: string) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function jsonValue(value: string) { try {
    return JSON.parse(value);
}
catch {
    return value;
} }
function resolveEnv(v: any): any {
    if (typeof v === 'string' && /^\$\{ENV:[A-Za-z_][A-Za-z0-9_]*\}$/.test(v)) {
        const name = v.slice(6, -1);
        if (!process.env[name])
            throw new Error(`Environment variable ${name} is not set`);
        return process.env[name];
    }
    if (Array.isArray(v))
        return v.map(resolveEnv);
    if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveEnv(x)]));
    return v;
}
export class App {
    store: Store;
    engine: Engine;
    local: LocalProcesses;
    running = new Map<string, {
        requestId: string;
        promise: Promise<any>;
    }>();
    interactive = false;
    streamRequestId?: string;
    notify: (text: string) => void = () => { };
    constructor(store: Store) {
        this.store = store;
        this.engine = new Engine(store.home);
        this.local = new LocalProcesses(store.home);
        for (const t of store.state.tasks)
            if (['running', 'cancelling'].includes(t.status)) {
                t.status = 'interrupted';
                t.error = 'Previous CLI session ended; inspect output and .partial files before restarting';
            }
        this.engine.on('event', e => { if (e.method === 'task.progress') {
            const t = this.store.state.tasks.find(x => x.requestId === e.params.requestId);
            if (t) {
                t.written = e.params.written;
                this.notify(`↳ ${t.name} · 已写出 ${t.written} 行`);
            }
        } else if (e.method === 'stream.records' && e.params.requestId === this.streamRequestId) {
            const records = e.params.records ?? [];
            for (const [index, record] of records.entries()) {
                const table = record.tableId ?? record.table ?? record.after?.tableId ?? '记录';
                this.notify(`↳ stream · ${table} · ${e.params.count - records.length + index + 1}\n${JSON.stringify(record, null, 2)}`);
            }
        } });
    }
    private find(items: RecordData[], ref: string | undefined, label: string) { const matches = items.filter(x => x.id === ref || x.name === ref || x.pdkId === ref); if (matches.length !== 1)
        throw new Error(`${label} ${ref ?? ''}: ${matches.length ? 'ambiguous reference; use exact ID' : 'not found'}`); return matches[0]; }
    private datasource(name: string) { return this.find(this.store.state.datasources, name, 'Datasource'); }
    private connector(ref: string) { return this.find(this.store.state.connectors, ref, 'Connector'); }
    private artifact(c: RecordData) { if (!c.loaded)
        throw new Error(`Connector ${c.id} is unloaded`); if (sha(c.jar) !== c.sha256)
        throw new Error('Cached JAR checksum mismatch; reload original artifact'); for (const dep of c.dependencies)
        if (sha(dep.path) !== dep.sha256)
            throw new Error('Dependency checksum mismatch'); return { jar: c.jar, className: c.className, dependencies: c.dependencies.map((x: any) => x.path) }; }
    private params(ds: RecordData) { const c = this.connector(ds.connectorId); return { ...this.artifact(c), config: resolveEnv(this.store.unseal(ds.config)) }; }
    private async refreshCapabilities(c: RecordData) { const inspected = await this.engine.request('connector.inspect', this.artifact(c)); c.capabilities = inspected.capabilities; this.store.save(); return inspected; }
    private configInput(p: ReturnType<typeof parse>) { let patch: RecordData = {}; if (p.get('config')) {
        patch = JSON.parse(readFileSync(resolve(required(p.get('config'), '--config')), 'utf8'));
        if (!patch || Array.isArray(patch) || typeof patch !== 'object')
            throw new Error('Config JSON must be an object');
    } for (const pair of p.all('set')) {
        const i = pair.indexOf('=');
        if (i < 1)
            throw new Error('--set requires key=value');
        const key = pair.slice(0, i);
        if (['__proto__', 'prototype', 'constructor'].includes(key))
            throw new Error('Invalid config key');
        patch[key] = jsonValue(pair.slice(i + 1));
    } return patch; }
    private validateConfig(c: RecordData, config: RecordData) { const schema = c.configOptions?.connection; if (schema?.type === 'object' && schema.properties) {
        for (const [k, s] of Object.entries<any>(schema.properties)) {
            if (config[k] === undefined && s.default !== undefined)
                config[k] = s.default;
            const numeric = s['x-component'] === 'InputNumber';
            if (config[k] !== undefined && s.type && s.type !== 'void' && !numeric && !['object', 'array'].includes(s.type) && typeof config[k] !== s.type)
                throw new Error(`Config ${k} must be ${s.type}`);
        }
        for (const k of schema.required ?? [])
            if (config[k] === undefined || config[k] === '')
                throw new Error(`Missing datasource config: ${k}`);
    } }
    private summary(ds: RecordData) { const { config, models, ...rest } = ds; return { ...rest, config: redact(this.store.unseal(config)), modelCount: models?.length ?? 0 }; }
    context() { return { connectors: this.store.state.connectors.map(({ id, pdkId, version, loaded, capabilities }) => ({ id, pdkId, version, loaded, capabilities })), datasources: this.store.state.datasources.map(({ id, name, connectorId, revision, modelStatus, models }) => ({ id, name, connectorId, revision, modelStatus, tables: models?.slice(0, 50).map((t: any) => t.id) })), tasks: this.store.state.tasks.map(({ name, status, table, source, output }) => ({ name, status, table, source, output })) }; }
    async execute(argv: string[], options: ExecutionOptions = {}): Promise<any> {
        const p = parse(argv), [group, action, ref] = p.positional;
        const state = this.store.state;
        const allowed: Record<string, string[]> = {
            'local exec': ['cwd', 'argv', 'timeout'],
            'test run': ['repo', 'module', 'suite', 'datasource', 'timeout'],
            'connector discover': ['dir'], 'connector search': ['repository', 'version'], 'connector download': ['repository', 'version'], 'connector load': ['jar', 'deps', 'class', 'version', 'repository'], 'connector update': ['jar', 'deps', 'class', 'version', 'repository'],
            'datasource create': ['pdk-id', 'connector', 'config', 'set'], 'datasource modify': ['connector', 'config', 'set'],
            'datasource load': ['table', 'refresh'], 'datasource describe': ['table'], 'datasource sample': ['table', 'limit'], 'datasource page': ['table', 'limit', 'cursor'], 'datasource stream': ['table', 'since', 'record-size'], 'datasource table-info': ['table'],
            'datasource count': ['table'], 'datasource indexes': ['table'], 'datasource constraints': ['table'],
            'datasource minmax': ['table', 'field', 'filter'],
            'datasource query': ['table', 'filter', 'sort', 'skip', 'limit', 'fields'], 'datasource sql': ['type', 'sql', 'yes'], 'datasource command': ['command', 'params', 'yes'],
            'task create': ['source', 'table', 'output', 'exclude'], 'ai bind': ['name', 'command', 'url', 'key-env', 'model']
        };
        const permitted = allowed[`${group} ${action}`] ?? [];
        for (const flag of Object.keys(p.flags))
            if (!permitted.includes(flag))
                throw new Error(`Unknown option --${flag} for ${group} ${action ?? ''}`);
        if (!group || group === 'help' || group === '--help')
            return { text: help() };
        if (group === 'local' && action === 'exec') {
            if (p.positional.length !== 2) throw new Error('Use local exec --cwd DIR --argv JSON_ARRAY');
            const cwd = resolve(required(p.get('cwd'), '--cwd'));
            if (!statSync(cwd).isDirectory()) throw new Error('--cwd must be a directory');
            const args: unknown = JSON.parse(required(p.get('argv'), '--argv'));
            if (!Array.isArray(args) || !args.length || args.length > 256 || args.some(x => typeof x !== 'string' || x.includes('\0')) || !args[0])
                throw new Error('--argv must be a nonempty JSON array of strings without NUL bytes (max 256 arguments)');
            const timeout = Number(p.get('timeout') ?? 1800);
            if (!Number.isInteger(timeout) || timeout < 1 || timeout > 7200) throw new Error('--timeout must be 1..7200 seconds');
            return this.local.execute(cwd, args, timeout, options);
        }
        if (group === 'test' && action === 'run') {
            if (p.positional.length !== 2) throw new Error('Use test run --repo DIR --module CONNECTOR [--suite integration|performance|tpcc|long-transaction]');
            const repo = resolve(required(p.get('repo'), '--repo'));
            if (!statSync(repo).isDirectory() || !statSync(join(repo, 'pom.xml'), { throwIfNoEntry: false })?.isFile())
                throw new Error('--repo must be a Tapdata connectors repository containing pom.xml');
            const module = required(p.get('module'), '--module');
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(module)) throw new Error('--module must be a connector artifact/module name');
            const relativeModule = join('connectors', module);
            if (!statSync(join(repo, relativeModule, 'pom.xml'), { throwIfNoEntry: false })?.isFile())
                throw new Error(`Connector module not found: ${relativeModule}`);
            const suite = p.get('suite') ?? 'integration';
            const profiles: Record<string, string | undefined> = { integration: undefined, performance: 'performance-only', tpcc: 'tpcc-only', 'long-transaction': 'long-transaction-only' };
            if (!(suite in profiles)) throw new Error('--suite must be integration, performance, tpcc, or long-transaction');
            const timeout = Number(p.get('timeout') ?? 7200);
            if (!Number.isInteger(timeout) || timeout < 1 || timeout > 7200) throw new Error('--timeout must be 1..7200 seconds');
            const env: NodeJS.ProcessEnv = {};
            let datasourceName: string | undefined;
            if (p.get('datasource')) {
                const ds = this.datasource(p.get('datasource')!);
                const connector = this.connector(ds.connectorId);
                const pdkName = String(connector.pdkId).toLowerCase().replace(/^.*[.:]/, '').replace(/-connector$/, '');
                if (pdkName !== module.toLowerCase().replace(/-connector$/, ''))
                    throw new Error(`Datasource ${ds.name} uses ${connector.pdkId}; selected module is ${module}`);
                const config = resolveEnv(this.store.unseal(ds.config));
                for (const [key, value] of Object.entries(config)) {
                    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value === undefined || value === null || typeof value === 'object') continue;
                    env[`CONNECTOR_IT_${key.toUpperCase()}`] = String(value);
                }
                datasourceName = ds.name;
            }
            const argv = ['mvn', '-B', '-pl', relativeModule, '-am', 'verify', '-DskipITs=false'];
            if (profiles[suite]) argv.push(`-P${profiles[suite]}`);
            const runStarted = Date.now();
            let processResult: any;
            try {
                processResult = await this.local.execute(repo, argv, timeout, { ...options, env });
            } catch (error: any) {
                processResult = error.details;
                if (!processResult) throw error;
            }
            const reportDir = join(repo, relativeModule, 'target', 'failsafe-reports');
            const reportFiles = statSync(reportDir, { throwIfNoEntry: false })?.isDirectory()
                ? readdirSync(reportDir).filter(name => /^TEST-.*\.xml$/.test(name) && statSync(join(reportDir, name)).mtimeMs >= runStarted).map(name => join(reportDir, name)) : [];
            const counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
            for (const report of reportFiles) {
                const xml = readFileSync(report, 'utf8').slice(0, 2_000_000);
                const attr = (name: string) => Number(xml.match(new RegExp(`\\b${name}="(\\d+)"`))?.[1] ?? 0);
                counts.tests += attr('tests'); counts.failures += attr('failures'); counts.errors += attr('errors'); counts.skipped += attr('skipped');
            }
            return { suite, module, repo, datasource: datasourceName, passed: processResult.exitCode === 0, exitCode: processResult.exitCode,
                tests: counts, reports: reportFiles, log: processResult.log,
                note: reportFiles.length ? undefined : 'No Failsafe XML reports found; confirm tapdata-connector-it is installed and this connector has src/it tests.' };
        }
        if (group === 'init' || group === 'doctor') {
            const engine = await this.engine.start();
            this.store.save();
            writeFileSync(join(this.store.home, 'CONTEXT.md'), this.contextText(), { mode: 0o600 });
            return { coreReady: true, engineReady: true, contextReady: true, aiReady: !!state.activeBinding, home: this.store.home, engine };
        }
        if (group === 'connector') {
            if (['search', 'download', 'load', 'update'].includes(action) && p.positional.length > 3)
                throw new Error('Too many connector arguments');
            if (action === 'search' || action === 'download') {
                const nexus = new Nexus(this.store.home, p.get('repository'));
                return action === 'search' ? nexus.search(ref, p.get('version'), options.signal) : nexus.download(required(ref, 'connector name'), p.get('version'), options);
            }
            if (action === 'discover') {
                const directory = resolve(required(p.get('dir'), '--dir'));
                const entries = readdirSync(directory, { withFileTypes: true }).filter(e => e.isFile() && e.name.toLowerCase().endsWith('.jar')).sort((a, b) => a.name.localeCompare(b.name));
                return { directory, jars: entries.slice(0, 200).map(e => ({ name: e.name, path: join(directory, e.name) })), total: entries.length, truncated: entries.length > 200 };
            }
            if (!action || action === 'list')
                return state.connectors.map(({ jar, dependencies, ...c }) => ({ ...c, source: jar, references: state.datasources.filter(d => d.connectorId === c.id).map(d => d.name) }));
            if (action === 'describe') {
                const c = this.connector(required(ref, 'connector reference'));
                const inspected = await this.refreshCapabilities(c);
                return { ...c, ...inspected };
            }
            if (action === 'unload') {
                const c = this.connector(required(ref, 'connector reference'));
                const refs = state.datasources.filter(d => d.connectorId === c.id);
                if (refs.length)
                    throw new Error(`Connector referenced by: ${refs.map(x => x.name).join(', ')}`);
                if (c.loaded)
                    await this.engine.request('connector.unload', this.artifact(c));
                c.loaded = false;
                this.store.save();
                return { id: c.id, loaded: false };
            }
            if (action === 'load' || action === 'update') {
                if (action === 'update')
                    this.connector(required(ref, 'connector reference'));
                if (p.get('jar') && (p.get('version') || p.get('repository') || (action === 'load' && ref)))
                    throw new Error('Use either a local --jar or a remote connector name/version');
                if (!p.get('jar') && p.get('deps')) throw new Error('--deps requires --jar');
                const remote = p.get('jar') ? undefined : await new Nexus(this.store.home, p.get('repository')).download(
                    action === 'update' ? (this.connector(ref!).origin?.artifactId ?? this.connector(ref!).pdkId) : required(ref, 'connector name or --jar'), p.get('version'), options);
                options.signal?.throwIfAborted();
                const jar = resolve(remote?.jar ?? required(p.get('jar'), '--jar'));
                if (!statSync(jar).isFile())
                    throw new Error('--jar must be a file');
                const hash = sha(jar);
                const deps = p.get('deps') ? readdirSync(resolve(p.get('deps')!)).filter(f => f.endsWith('.jar')).sort().map(f => resolve(p.get('deps')!, f)) : [];
                const hashes = deps.map(sha);
                const digest = createHash('sha256').update(JSON.stringify([hash, hashes, p.get('class') ?? ''])).digest('hex');
                const folder = join(this.store.home, 'connectors', digest);
                mkdirSync(folder, { recursive: true, mode: 0o700 });
                const cached = join(folder, 'connector.jar');
                if (resolve(jar) !== cached)
                    copyFileSync(jar, cached);
                const dependencies = deps.map((f, i) => { const dest = join(folder, `dependency-${i}.jar`); if (f !== dest)
                    copyFileSync(f, dest); return { path: dest, sha256: hashes[i] }; });
                const info = await this.engine.request('connector.inspect', { jar: cached, dependencies: dependencies.map(x => x.path), className: p.get('class') });
                if (action === 'update' && this.connector(ref!).pdkId !== info.pdkId)
                    throw new Error('Update must have the same pdkId');
                const id = `${info.pdkId}@${digest.slice(0, 16)}`;
                let c = state.connectors.find(x => x.id === id);
                if (!c) {
                    c = { ...info, id, jar: cached, sha256: hash, dependencies, loaded: true, ...(remote ? { origin: remote } : {}) };
                    state.connectors.push(c!);
                }
                else {
                    c.loaded = true;
                    if (remote) c.origin = remote;
                }
                this.store.save();
                return { ...c, notice: action === 'update' ? 'Existing datasource references are pinned; use datasource modify --connector NEW_ID to migrate' : undefined };
            }
        }
        if (group === 'datasource') {
            if (!action || action === 'list')
                return state.datasources.map(x => this.summary(x));
            const name = required(ref, 'datasource name');
            if (action === 'create') {
                if (state.datasources.some(x => x.name === name))
                    throw new Error(`Datasource ${name} already exists`);
                const pdk = required(p.get('pdk-id'), '--pdk-id');
                const c = this.connector(p.get('connector') || pdk);
                if (c.pdkId !== pdk)
                    throw new Error('pdkId does not match connector');
                this.artifact(c);
                const config = this.configInput(p);
                this.validateConfig(c, config);
                const ds = { id: randomUUID(), name, connectorId: c.id, pdkId: pdk, config: this.store.seal(config), revision: 1, modelStatus: 'not-loaded', testStatus: 'not-tested' };
                state.datasources.push(ds);
                this.store.save();
                return this.summary(ds);
            }
            const ds = this.datasource(name);
            if (action === 'capabilities') {
                const loaded = this.connector(ds.connectorId), inspected = await this.refreshCapabilities(loaded);
                const caps = Object.keys(inspected.capabilities ?? {}).filter(x => inspected.capabilities[x]);
                const commandMap: Record<string, string[]> = {
                    get_table_names_function: ['datasource tables'], get_table_info_function: ['datasource table-info'],
                    batch_read_function: ['datasource sample', 'datasource page', 'task export'], stream_read_function: ['datasource stream'], timestamp_to_stream_offset_function: ['datasource stream'], batch_count_function: ['datasource count'],
                    query_by_advance_filter_function: ['datasource query'], query_indexes_function: ['datasource indexes'],
                    query_constraints_function: ['datasource constraints'], query_field_min_max_value_function: ['datasource minmax'],
                    get_current_timestamp_function: ['datasource now'], execute_command_v2_function: ['datasource sql'],
                    execute_command_function: ['datasource command']
                };
                const interactive = new Set(Object.keys(commandMap));
                return { pdkId: loaded.pdkId, version: loaded.version,
                    interactive: caps.filter(x => interactive.has(x)).map(name => ({ name, commands: commandMap[name] })),
                    runtimeOnly: caps.filter(x => !interactive.has(x) && !['test', 'discover'].includes(x)),
                    builtIns: ['connectionTest', 'discoverSchema'] };
            }
            if (action === 'tables')
                return this.engine.request('datasource.tables', this.params(ds));
            if (action === 'table-info')
                return this.engine.request('datasource.tableInfo', { ...this.params(ds), table: required(p.get('table'), '--table') });
            if (action === 'now')
                return this.engine.request('datasource.now', this.params(ds));
            if (action === 'count' || action === 'indexes' || action === 'constraints')
                return this.engine.request(`datasource.${action}`, { ...this.params(ds), table: required(p.get('table'), '--table') });
            if (action === 'minmax') {
                const table = required(p.get('table'), '--table'), field = required(p.get('field'), '--field');
                let filter: any;
                if (p.get('filter')) { filter = JSON.parse(p.get('filter')!); if (!filter || Array.isArray(filter) || typeof filter !== 'object') throw new Error('--filter must be a JSON object matching TapAdvanceFilter'); }
                return this.engine.request('datasource.minmax', { ...this.params(ds), table, field, ...(filter ? { filter } : {}) });
            }
            if (action === 'modify') {
                if (this.running.size && state.tasks.some(t => t.source === ds.id && this.running.has(t.id)))
                    throw new Error('Datasource has an active task');
                const c = p.get('connector') ? this.connector(p.get('connector')!) : this.connector(ds.connectorId);
                this.artifact(c);
                const config = { ...this.store.unseal(ds.config), ...this.configInput(p) };
                this.validateConfig(c, config);
                ds.connectorId = c.id;
                ds.pdkId = c.pdkId;
                ds.config = this.store.seal(config);
                ds.revision++;
                ds.modelStatus = ds.models ? 'stale' : 'not-loaded';
                ds.testStatus = 'not-tested';
                this.store.save();
                return this.summary(ds);
            }
            if (action === 'drop') {
                const refs = state.tasks.filter(t => t.source === ds.id);
                if (refs.length)
                    throw new Error(`Datasource referenced by tasks: ${refs.map(t => t.name).join(', ')}`);
                state.datasources = state.datasources.filter(x => x !== ds);
                this.store.save();
                return { dropped: name };
            }
            if (action === 'describe') {
                if (p.get('table')) {
                    const table = ds.models?.find((t: any) => t.id === p.get('table'));
                    if (!table)
                        throw new Error('Table metadata is missing; run datasource load');
                    return { modelStatus: ds.modelStatus, table };
                }
                return this.summary(ds);
            }
            if (action === 'test') {
                try {
                    const result = await this.engine.request('datasource.test', this.params(ds));
                    ds.testStatus = result.passed ? 'passed' : 'failed';
                    this.store.save();
                    if (!result.passed)
                        throw Object.assign(new Error('Connection test failed'), { details: redact(result) });
                    return redact(result);
                }
                catch (e) {
                    ds.testStatus = 'failed';
                    this.store.save();
                    throw e;
                }
            }
            if (action === 'load') {
                try {
                    const result = await this.engine.request('datasource.discover', { ...this.params(ds), table: p.get('table') });
                    ds.models = result.tables;
                    ds.modelStatus = p.get('table') ? 'partial' : 'loaded';
                    ds.loadedAt = new Date().toISOString();
                    this.store.save();
                    return result;
                }
                catch (e) {
                    ds.modelStatus = ds.models ? 'stale' : 'not-loaded';
                    this.store.save();
                    throw e;
                }
            }
            if (action === 'sample')
                return this.engine.request('datasource.sample', { ...this.params(ds), table: required(p.get('table'), '--table'), limit: Number(p.get('limit') ?? 10) });
            if (action === 'page')
                return this.engine.request('datasource.page', { ...this.params(ds), table: required(p.get('table'), '--table'), limit: Number(p.get('limit') ?? 20), ...(p.get('cursor') ? { cursor: p.get('cursor') } : {}) });
            if (action === 'stream') {
                const loaded = this.connector(ds.connectorId);
                const inspected = await this.refreshCapabilities(loaded);
                if (!inspected.capabilities?.stream_read_function) throw new Error(`Connector ${loaded.pdkId} does not support stream_read_function`);
                const sinceText = p.get('since');
                const startTime = sinceText === undefined ? Date.now() : /^\d+$/.test(sinceText) ? Number(sinceText) : Date.parse(sinceText);
                if (!Number.isSafeInteger(startTime) || startTime <= 0) throw new Error('--since must be epoch milliseconds or an ISO timestamp');
                const recordSize = Number(p.get('record-size') ?? 20);
                if (!Number.isInteger(recordSize) || recordSize < 1 || recordSize > 1000) throw new Error('--record-size must be 1..1000');
                const requestId = randomUUID();
                this.streamRequestId = requestId;
                const stop = () => { void this.engine.request('operation.cancel', { requestId }).catch(() => {}); };
                options.signal?.addEventListener('abort', stop, { once: true });
                try {
                    return await this.engine.request('datasource.streamRead', { ...this.params(ds), ...(p.get('table') ? { table: p.get('table') } : {}), startTime, recordSize }, requestId);
                } finally {
                    options.signal?.removeEventListener('abort', stop);
                    if (this.streamRequestId === requestId) this.streamRequestId = undefined;
                }
            }
            if (action === 'query') {
                const table = required(p.get('table'), '--table');
                const limit = Number(p.get('limit') ?? 20), skip = Number(p.get('skip') ?? 0);
                if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be 1..100');
                if (!Number.isInteger(skip) || skip < 0 || skip > 1_000_000) throw new Error('--skip must be 0..1000000');
                let sort: any;
                if (p.get('sort')) {
                    sort = JSON.parse(p.get('sort')!);
                    if (!Array.isArray(sort) || sort.some((x: any) => !x || typeof x.key !== 'string' || !['asc', 'desc', 'ASC', 'DESC', 1, 2].includes(x.sort)))
                        throw new Error('--sort must be a JSON array, e.g. [{"key":"id","sort":"asc"}]');
                    sort = sort.map((x: any) => ({ key: x.key, sort: typeof x.sort === 'string' ? (/^asc$/i.test(x.sort) ? 1 : 2) : x.sort }));
                }
                let filter: any;
                if (p.get('filter')) { filter = JSON.parse(p.get('filter')!); if (!filter || Array.isArray(filter) || typeof filter !== 'object') throw new Error('--filter must be a JSON object matching TapAdvanceFilter'); }
                const projection = p.get('fields') ? { includeFields: p.get('fields')!.split(',').map(x => x.trim()).filter(Boolean) } : undefined;
                const loaded = this.connector(ds.connectorId);
                const inspected = await this.refreshCapabilities(loaded);
                if (!inspected.capabilities?.query_by_advance_filter_function) throw new Error(`Connector ${loaded.pdkId} does not support query_by_advance_filter_function`);
                return this.engine.request('datasource.query', { ...this.params(ds), table, limit, skip, ...(filter ? { filter } : {}), ...(sort ? { sort } : {}), ...(projection ? { projection } : {}) });
            }
            if (action === 'command') {
                if (p.get('yes') !== 'true') throw new Error('Connector commands may modify data. Review the command and rerun with --yes to execute.');
                const loaded = this.connector(ds.connectorId);
                const inspected = await this.refreshCapabilities(loaded);
                if (!inspected.capabilities?.execute_command_function) throw new Error(`Connector ${loaded.pdkId} does not support execute_command_function`);
                const command = required(p.get('command'), '--command');
                let commandParams: any = {};
                if (p.get('params')) { commandParams = JSON.parse(p.get('params')!); if (!commandParams || Array.isArray(commandParams) || typeof commandParams !== 'object') throw new Error('--params must be a JSON object'); }
                return this.engine.request('datasource.command', { ...this.params(ds), command, commandParams, batchSize: 100 });
            }
            if (action === 'sql') {
                if (p.get('yes') !== 'true') throw new Error('SQL may modify or delete data. Review the SQL and rerun with --yes to execute.');
                const loaded = this.connector(ds.connectorId);
                const inspected = await this.refreshCapabilities(loaded);
                if (!inspected.capabilities?.execute_command_v2_function) throw new Error(`Connector ${loaded.pdkId} does not support execute_command_v2_function`);
                const sql = required(p.get('sql'), '--sql');
                const sqlType = p.get('type') ?? 'query';
                if (!['query', 'execute'].includes(sqlType)) throw new Error('--type must be query or execute');
                return this.engine.request('datasource.sql', { ...this.params(ds), sql, sqlType });
            }
        }
        if (group === 'task') {
            if (!action || action === 'list')
                return state.tasks;
            if (action === 'create') {
                const name = required(ref, 'task name');
                if (state.tasks.some(x => x.name === name))
                    throw new Error('Task already exists');
                const ds = this.datasource(required(p.get('source'), '--source'));
                const table = required(p.get('table'), '--table'), output = resolve(required(p.get('output'), '--output'));
                const task = { id: randomUUID(), name, source: ds.id, table, output, exclude: (p.get('exclude') ?? '').split(',').filter(Boolean), planVersion: 1, status: 'ready' };
                state.tasks.push(task);
                this.store.save();
                return task;
            }
            const task = this.find(state.tasks, required(ref, 'task name'), 'Task');
            if (['describe', 'status', 'stats'].includes(action))
                return task;
            if (action === 'drop') {
                if (this.running.has(task.id))
                    throw new Error('Task is running');
                state.tasks = state.tasks.filter(x => x !== task);
                this.store.save();
                return { dropped: task.name };
            }
            if (action === 'stop') {
                const run = this.running.get(task.id);
                if (!run)
                    throw new Error('No active run in this session');
                task.status = 'cancelling';
                this.store.save();
                await this.engine.request('operation.cancel', { requestId: run.requestId });
                return { name: task.name, status: task.status };
            }
            if (action === 'start') {
                if (this.running.has(task.id))
                    throw new Error('Task is already running');
                const ds = this.datasource(task.source);
                const params = { ...this.params(ds), table: task.table, output: task.output, exclude: task.exclude };
                task.runId = randomUUID();
                task.requestId = randomUUID();
                task.datasourceRevision = ds.revision;
                task.status = 'running';
                task.startedAt = new Date().toISOString();
                task.written = 0;
                delete task.error;
                this.store.save();
                const run = this.engine.request('task.export', params, task.requestId).then(result => { task.status = 'succeeded'; Object.assign(task, result); return { ...task }; }).catch((e: any) => { task.status = e.code === -32800 ? 'cancelled' : 'failed'; task.error = e.message; throw e; }).finally(() => { task.endedAt = new Date().toISOString(); this.running.delete(task.id); this.store.save(); this.notify(`↳ ${task.name} · ${task.status} · ${task.written} 行${task.error ? ' · ' + task.error : ''}`); });
                this.running.set(task.id, { requestId: task.requestId, promise: run });
                if (this.interactive) {
                    void run.catch(() => { });
                    return { ...task };
                }
                return run;
            }
        }
        if (group === 'ai') {
            if (!action || action === 'list')
                return state.bindings;
            if (action === 'status')
                return state.bindings.find(b => b.name === state.activeBinding) ?? { bound: false };
            if (action === 'use') {
                this.find(state.bindings, required(ref, 'binding name'), 'AI binding');
                state.activeBinding = ref;
                this.store.save();
                return { active: ref };
            }
            if (action === 'unbind') {
                const b = this.find(state.bindings, required(ref, 'binding name'), 'AI binding');
                state.bindings = state.bindings.filter(x => x !== b);
                if (state.activeBinding === b.name)
                    state.activeBinding = state.bindings[0]?.name;
                this.store.save();
                return { unbound: b.name };
            }
            if (action === 'bind') {
                if (!['codex', 'claude', 'api'].includes(ref))
                    throw new Error('Provider must be codex, claude, or api');
                const name = p.get('name') || ref;
                if (state.bindings.some(x => x.name === name))
                    throw new Error('Binding name already exists; choose --name or unbind first');
                const binding: RecordData = { name, provider: ref, model: p.get('model') };
                if (ref === 'api') {
                    const url = new URL(required(p.get('url'), '--url'));
                    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
                        throw new Error('Expected plain HTTP(S) API base URL without credentials or query');
                    binding.url = url.toString().replace(/\/$/, '');
                    binding.keyEnv = required(p.get('key-env'), '--key-env');
                    required(binding.model, '--model');
                }
                else {
                    binding.command = p.get('command') || ref;
                    const { execFileSync } = await import('node:child_process');
                    try {
                        binding.cliVersion = execFileSync(binding.command, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim().slice(0, 200);
                    }
                    catch {
                        throw new Error(`Cannot run ${binding.command} --version; install/login using the provider CLI`);
                    }
                }
                state.bindings.push(binding);
                state.activeBinding = name;
                this.store.save();
                return { ...binding, authentication: ref === 'api' ? 'environment variable reference' : 'provider native login; not yet verified' };
            }
        }
        if (group === 'model') {
            const b = state.bindings.find(b => b.name === state.activeBinding);
            if (!b)
                throw new Error('Bind an AI first using ai bind');
            if (action) {
                b.model = action;
                this.store.save();
            }
            return { binding: b.name, model: b.model ?? 'provider default' };
        }
        throw new Error(`Unknown command: ${group} ${action ?? ''}. Use help.`);
    }
    contextText() { return `# Tapdata CLI context v1\nYou operate an independent CLI and Java PDK mini engine.\nNever invent pdkId, task success or test results. Use actual returned IDs.\nCommands are argument arrays, not shell strings. Metadata load does not copy records.\nLocal build/file inspection is available through local exec --cwd DIR --argv JSON_ARRAY. Example: ["local","exec","--cwd","/path/to/repo","--argv",'["mvn","-B","-pl","connectors/postgres-connector","-am","package","-DskipTests"]']. Inspect repository instructions before choosing build arguments. Local programs run as the current user, with their environment; only do work the user requested. stdout/stderr, exit status and a private full-log path are returned. Build failure is not success; report the actual error before deciding whether a targeted fix is within scope.\nFor user-requested connector loading by name without a local path, use connector load NAME (for example postgres). This automatically resolves and downloads a verified JAR from Nexus. Do not ask the user for a JAR path first. connector search [NAME] lists published versions; connector download NAME only downloads. Use --version to pin a version and --repository maven-snapshots only when requested. If no artifact is published, report the actual error; never substitute a different connector.\nIf the user gives a connector directory, use connector discover --dir DIR to find actual JAR paths before loading. Discovery lists filenames, not verified connector identities. If no matching JAR exists, explain that; never substitute another database connector.\nNever ask a model to handle passwords; use config JSON files or ENV references.\n\n${help()}\n\nWorkspace snapshot:\n${JSON.stringify(this.context())}\n`; }
    private closed = false;
    async close() { if (this.closed)
        return; this.closed = true; await this.local.close(); const runs = [...this.running.values()]; for (const run of runs)
        try {
            await this.engine.request('operation.cancel', { requestId: run.requestId });
        }
        catch { } this.engine.close(); await Promise.allSettled(runs.map(r => r.promise)); this.store.save(); this.store.release(); }
}
