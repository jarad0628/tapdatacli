import { createInterface, Interface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { App, help, commands } from './commands.js';
import { Store } from './store.js';
import { AI } from './ai.js';
import { tokenize } from './parse.js';
const args = process.argv.slice(2);
let json = false;
for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === '--json') {
        json = true;
        args.splice(i, 1);
    }
    else if (args[i] === '--output' && args[i + 1] === 'json') {
        json = true;
        args.splice(i, 2);
    }
}
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const cyan = (s: string) => color ? `\x1b[36m${s}\x1b[0m` : s;
function width(s: string) { return [...s].reduce((n, c) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60]/u.test(c) ? 2 : 1), 0); }
function table(rows: any[], columns: [
    string,
    string
][]) {
    const all = [columns.map(([, title]) => title), ...rows.map(r => columns.map(([key]) => String(r[key] ?? '—').replace(/\s+/g, ' ')))];
    const sizes = columns.map((_, i) => Math.min(38, Math.max(...all.map(row => width(row[i])))));
    return all.map((row, index) => row.map((cell, i) => { let clipped = ''; for (const c of cell) {
        if (width(clipped + c) > sizes[i])
            break;
        clipped += c;
    } return clipped + ' '.repeat(Math.max(0, sizes[i] - width(clipped))); }).join('  ')).join('\n');
}
function labelStatus(value: unknown) {
    const labels: Record<string, string> = {
        passed: '通过', failed: '失败', 'not-tested': '未测试', loaded: '已加载', stale: '需刷新',
        partial: '部分加载', 'not-loaded': '未加载', ready: '就绪', running: '运行中',
        succeeded: '成功', interrupted: '已中断', cancelling: '正在停止'
    };
    return labels[String(value)] ?? String(value ?? '—');
}
function printable(v: any) {
    if (v?.text)
        return v.text;
    if (Array.isArray(v)) {
        if (!v.length)
            return '暂无记录';
        if (v[0].connectorId)
            return table(v.map(x => ({ ...x, testStatus: labelStatus(x.testStatus), modelStatus: labelStatus(x.modelStatus) })), [['name', '数据源'], ['pdkId', '连接器'], ['testStatus', '连接测试'], ['modelStatus', '模型'], ['modelCount', '表数']]);
        if (v[0].loaded !== undefined)
            return table(v, [['id', '连接器 ID'], ['version', '版本'], ['loaded', '已装载']]);
        if (v[0].planVersion)
            return table(v.map(x => ({ ...x, status: labelStatus(x.status) })), [['name', '任务'], ['status', '状态'], ['table', '源表'], ['written', '已写行数']]);
        if (v[0].provider)
            return table(v, [['name', '绑定名'], ['provider', 'AI'], ['model', '模型']]);
    }
    if (v?.pdkId && v?.capabilities && v?.id)
        return `✓ 已装载 ${v.name} · pdkId: ${v.pdkId} · 版本: ${v.version}\n  ID: ${v.id}\n  能力: ${Object.entries(v.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(', ')}${v.notice ? '\n  ' + v.notice : ''}`;
    if (v?.tables)
        return `发现 ${v.tables.length} 张表\n\n` + table(v.tables.map((t: any) => ({ ...t, count: t.fields?.length ?? 0 })), [['id', '表名'], ['count', '字段数']]) + '\n\n查看结构：/datasource describe <连接名> --table <表名> · 查看样例：/datasource sample <连接名> --table <表名>';
    if (v?.table?.fields) {
        const t = v.table;
        const fields = t.fields.map((f: any) => ({ name: f.name ?? f.id, type: f.type ?? f.dataType ?? f.originalType, nullable: f.nullable === undefined ? '—' : f.nullable ? '是' : '否', key: f.primaryKey ? '主键' : '' }));
        return `${t.id ?? t.name ?? '表结构'} · ${fields.length} 个字段\n\n` + table(fields, [['name', '字段'], ['type', '类型'], ['nullable', '可空'], ['key', '键']]);
    }
    if (v?.name && v?.pdkId && v?.config !== undefined)
        return `数据源  ${v.name}\n连接器  ${v.pdkId}\n连接测试  ${labelStatus(v.testStatus)}\n表模型  ${labelStatus(v.modelStatus)} · ${v.modelCount ?? 0} 张表\n配置修订  #${v.revision}`;
    if (v?.rows)
        return `${v.cursor ? '查询结果' : '样例数据'}  ${v.rows.length} 行${v.count > v.rows.length ? `（共 ${v.count} 行，当前为部分结果）` : ''}\n\n` + (v.rows.length ? table(v.rows, Object.keys(v.rows[0]).slice(0, 8).map(k => [k, k])) : '没有返回记录') + (v.cursor ? `\n\n下一页：/datasource page <连接名> --table <表名> --cursor ${v.cursor}` : '');
    if (v?.checks)
        return table(v.checks, [['item', '检查项'], ['result', '结果（1通过 / 2警告 / 10失败）'], ['message', '说明']]);
    if (v?.suite && v?.tests)
        return `${v.passed ? '✓' : '✗'} ${v.module} ${v.suite} · ${v.tests.tests} tests, ${v.tests.failures} failures, ${v.tests.errors} errors, ${v.tests.skipped} skipped\n  日志：${v.log}${v.note ? `\n  ${v.note}` : ''}`;
    if (v?.steps)
        return v.message ?? '完成';
    return JSON.stringify(v, null, 2);
}
function output(v: any) { if (!json && (v === undefined || v?.steps))
    return; process.stdout.write((json ? JSON.stringify({ ok: true, data: v }) : printable(v)) + '\n'); }
function error(e: any) { const detail = { message: e.message, ...(e.details ? { details: e.details } : {}) }; (json ? process.stdout : process.stderr).write((json ? JSON.stringify({ ok: false, error: detail }) : '错误：' + e.message + (e.details ? '\n' + JSON.stringify(e.details, null, 2) : '')) + '\n'); }
let app: App | undefined;
let stopping = false;
async function main() {
    if (args[0] === '--version' || args[0] === 'version') {
        output({ version: '0.1.0' });
        return;
    }
    if (args[0] === '--help' || args[0] === 'help') {
        output({ text: help() });
        return;
    }
    const store = new Store();
    store.acquire();
    app = new App(store);
    const ai = new AI(app);
    let abort: AbortController | undefined;
    process.on('SIGINT', () => { if (!app?.interactive) { abort?.abort(); app?.local.close(); } });
    const dispatch = async (argv: string[]) => {
        if (argv[0] === 'datasource' && argv[1] === 'stream' && !app!.interactive)
            app!.notify = text => process.stdout.write(json ? JSON.stringify({ event: 'stream', message: text }) + '\n' : text + '\n');
        if (argv[0] === 'ask') {
            abort = new AbortController();
            try {
                return await ai.ask(argv.slice(1).join(' '), abort.signal, text => { if (!json)
                    console.log(text); });
            }
            finally {
                abort = undefined;
            }
        }
        if (argv[0] === 'ai' && argv[1] === 'models')
            return ai.models(new AbortController().signal);
        if (argv[0] === 'ai' && argv[1] === 'native')
            return ai.native();
        let result;
        if (argv[0] === 'local' || argv[0] === 'connector' || argv[0] === 'test' || (argv[0] === 'datasource' && argv[1] === 'stream')) {
            abort = new AbortController();
            try { result = await app!.execute(argv, { signal: abort.signal, onOutput: text => { if (!json) process.stdout.write(text); } }); }
            finally { abort = undefined; }
        } else result = await app!.execute(argv);
        if (argv[0] === 'model' || (argv[0] === 'ai' && ['use', 'bind', 'unbind'].includes(argv[1])))
            ai.reset();
        return result;
    };
    if (args.length) {
        try {
            output(await dispatch(args));
        }
        finally {
            await app.close();
        }
        return;
    }
    if (!process.stdin.isTTY) {
        const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
        try {
            for await (const line of input) {
                if (!line.trim())
                    continue;
                try {
                    output(await dispatch(line.startsWith('/') ? tokenize(line.slice(1)) : ['ask', line]));
                }
                catch (e) {
                    error(e);
                    process.exitCode = 1;
                }
            }
        }
        finally {
            await app.close();
        }
        return;
    }
    app.interactive = true;
    const historyPath = join(store.home, 'history');
    const history = existsSync(historyPath) ? readFileSync(historyPath, 'utf8').split('\n').filter(Boolean).reverse().slice(0, 200) : [];
    const complete = (line: string): [string[], string] => {
        const words = line.trimStart().split(/\s+/);
        const slash = words[0]?.startsWith('/');
        if (!slash) return [[], line];
        const bare = words.map((x, i) => i === 0 ? x.slice(1) : x);
        const group = bare[0] ?? '';
        const action = bare[1] ?? '';
        const choices = commands.map(([name]) => '/' + name);
        const options: Record<string, string[]> = {
            'connector load': ['--jar', '--deps', '--class', '--version', '--repository'],
            'datasource create': ['--pdk-id', '--connector', '--config', '--set'],
            'datasource modify': ['--config', '--set'],
            'datasource load': ['--table', '--refresh'], 'datasource page': ['--table', '--limit', '--cursor'], 'datasource stream': ['--table', '--since', '--record-size'],
            'datasource describe': ['--table'], 'datasource sample': ['--table', '--limit'],
            'datasource query': ['--table', '--filter', '--sort', '--skip', '--limit', '--fields'], 'datasource sql': ['--type', '--sql', '--yes'], 'datasource command': ['--command', '--params', '--yes'],
            'task create': ['--source', '--table', '--output', '--exclude']
        };
        if (words.length >= 3 && words.at(-1) === '') choices.push(...(options[`${group} ${action}`] ?? []).map(x => `/${group} ${action} ${x}`));
        const dataSources = store.state.datasources.map(x => x.name);
        if (group === 'datasource' && ['test', 'load', 'describe', 'sample', 'page', 'stream', 'query', 'sql', 'command', 'modify', 'drop'].includes(action) && words.length >= 3) {
            if (['sample', 'query', 'stream'].includes(action) && words.length >= 4 && words[2]) {
                const ds = store.state.datasources.find(x => x.name === words[2]);
                choices.push(...(ds?.models ?? []).map((t: any) => `/${group} ${action} ${words[2]} --table ${t.id}`));
            } else choices.push(...dataSources.map(name => `/${group} ${action} ${name}`));
        }
        if (group === 'task' && ['describe', 'status', 'stop', 'start', 'drop'].includes(action) && words.length >= 3)
            choices.push(...store.state.tasks.map(x => `/task ${action} ${x.name}`));
        if (group === 'task' && action === 'create' && words.length >= 3 && words[2] === '--source')
            choices.push(...dataSources.map(name => `/task create --source ${name}`));
        if (group === 'connector' && ['describe', 'unload', 'update'].includes(action) && words.length >= 3)
            choices.push(...store.state.connectors.map(x => `/connector ${action} ${x.id}`));
        const hits = [...new Set(choices)].filter(x => x.startsWith(line));
        return [hits, line];
    };
    let rl: Interface = createInterface({ input: process.stdin, output: process.stdout, history, historySize: 200, removeHistoryDuplicates: true, completer: complete });
    console.log(cyan('\n  tapdatacli') + '  v0.1.0 · AI + PDK Mini Engine\n');
    console.log('数据库工作区：连接器 · 数据源 · 表结构 · 样例 · 导出任务');
    console.log('输入自然语言，或输入 / 查看命令。Tab 补全命令、连接名、表名和任务名 · ↑ 历史 · /exit 退出');
    console.log('常用操作：/connector search · /datasource list · /datasource load <连接名> · /task list');
    console.log('多行输入：行末 \\ 继续；Ctrl+C 停止当前操作，数据任务使用 /task stop。\n');
    const question = (s: string) => new Promise<string>(resolve => rl.question(s, resolve));
    if (!store.state.bindings.length) {
        console.log('首次使用：绑定 AI 后可以用自然语言操作，稍后也可用 /ai bind 配置。');
        const choice = (await question('选择 1 Codex / 2 Claude / 3 自定义 API / Enter 稍后配置：')).trim();
        try {
            if (choice === '1' || choice === '2')
                output(await dispatch(['ai', 'bind', choice === '1' ? 'codex' : 'claude']));
            if (choice === '3') {
                const url = await question('API Base URL（例如 https://api.deepseek.com）：');
                const model = await question('模型 ID：');
                const keyEnv = (await question('保存 API Key 的环境变量名 [TAPDATACLI_API_KEY]：')) || 'TAPDATACLI_API_KEY';
                output(await dispatch(['ai', 'bind', 'api', '--url', url, '--model', model, '--key-env', keyEnv]));
                console.log(`请在启动终端设置 ${keyEnv}；本程序不回显或保存 Key 明文。`);
            }
        }
        catch (e) {
            error(e);
        }
    }
    console.log(`工作区 ${store.home} · AI ${store.state.activeBinding ?? '未绑定'}\n`);
    const setPrompt = () => {
        const tableCount = store.state.datasources.reduce((n, ds: any) => n + (ds.models?.length ?? 0), 0);
        rl.setPrompt(cyan(`tapdata${store.state.datasources.length ? ` [${store.state.datasources.length} 连接 · ${tableCount} 表]` : ''} › `));
    };
    setPrompt();
    let busy = false, multiline = '';
    let lastProgress = 0;
    app.notify = text => { if (Date.now() - lastProgress < 500 && text.includes('已写出'))
        return; lastProgress = Date.now(); console.log('\n' + text); if (!busy)
        rl.prompt(true); };
    rl.on('SIGINT', () => { if (abort) {
        abort.abort();
        console.log(app?.streamRequestId ? '\n已请求停止 streamRead；正在等待连接器关闭。' : '\n已请求停止 AI 回答或当前本地进程。');
    }
    else if (busy) {
        console.log('\n操作仍在运行；任务使用 /task stop 取消。');
    }
    else {
        multiline = '';
        console.log('\n使用 /exit 退出，或继续输入。');
        rl.prompt();
    } });
    rl.on('line', line => {
        if (busy) {
            console.log('上一条命令仍在处理，请稍候。');
            return;
        }
        if (line.endsWith('\\')) {
            multiline += line.slice(0, -1) + '\n';
            rl.setPrompt('       … ');
            rl.prompt();
            return;
        }
        line = multiline + line;
        multiline = '';
        setPrompt();
        if (!line.trim()) {
            rl.prompt();
            return;
        }
        if (['/exit', '/quit'].includes(line.trim())) {
            rl.close();
            return;
        }
        busy = true;
        void (async () => {
            try {
                if (line.trim() === '/clear') {
                    ai.reset();
                    console.log('AI 对话上下文已清空。');
                }
                else {
                    const argv = line.startsWith('/') ? tokenize(line.slice(1)) : ['ask', line];
                    if (argv[0] === 'ai' && argv[1] === 'native') {
                        rl.pause();
                        try {
                            await dispatch(argv);
                        }
                        finally {
                            rl.resume();
                        }
                    }
                    else
                        output(await dispatch(argv));
                }
            }
            catch (e) {
                error(e);
            }
            finally {
                busy = false;
                if (!stopping)
                    rl.prompt();
            }
        })();
    });
    await new Promise<void>(resolve => { rl.once('close', () => { stopping = true; abort?.abort(); resolve(); }); rl.prompt(); });
    // Save only command names, never free-form input or credential-bearing arguments.
    const safeHistory = (rl as any).history.filter((s: string) => s.startsWith('/') && !/^\/local\b|--set|--config|password|secret|token|key/i.test(s)).slice(0, 200);
    writeFileSync(historyPath, safeHistory.reverse().join('\n'), { mode: 0o600 });
    if (app.running.size)
        console.log('正在停止本次会话的数据任务；未完成的 .partial 文件会保留。');
    await app.close();
}
process.on('SIGTERM', () => { void (async () => { stopping = true; await app?.close(); process.exit(143); })(); });
main().catch(async (e) => { error(e); await app?.close(); process.exitCode = 1; });
