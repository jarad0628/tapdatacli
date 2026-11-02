import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { openSync, closeSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
export const root = fileURLToPath(new URL('../', import.meta.url));
export class Engine extends EventEmitter {
    private child?: ChildProcessWithoutNullStreams;
    private pending = new Map<string, {
        resolve: (x: any) => void;
        reject: (x: Error) => void;
        timer: NodeJS.Timeout;
    }>();
    private ready?: Promise<any>;
    constructor(private home: string) { super(); }
    async start() {
        if (this.ready)
            return this.ready;
        this.ready = (async () => {
            const log = openSync(join(this.home, 'engine.log'), 'a', 0o600);
            const child = spawn(process.env.TAPDATACLI_JAVA || 'java', ['--add-opens=java.base/java.net=ALL-UNNAMED', '--add-opens=java.base/java.lang=ALL-UNNAMED', '-Dfile.encoding=UTF-8', '-jar', join(root, 'runtime/mini-engine.jar')], { stdio: ['pipe', 'pipe', 'pipe'] });
            this.child = child;
            child.stderr.on('data', b => { try {
                writeSync(log, b);
            }
            catch { } });
            child.stdin.on('error', () => { });
            const fail = (message: string) => { for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(new Error(message));
            } this.pending.clear(); this.child = undefined; this.ready = undefined; };
            child.once('error', e => fail(`Cannot start Java engine: ${e.message}`));
            child.once('exit', code => { closeSync(log); fail(`Java engine exited (${code}); active operations need checking`); this.emit('exit', code); });
            const lines = createInterface({ input: child.stdout });
            lines.on('line', line => { if (Buffer.byteLength(line) > 8 * 1024 * 1024) {
                child.kill();
                return;
            } try {
                const v = JSON.parse(line);
                if (v.method) {
                    this.emit('event', v);
                    return;
                }
                const p = this.pending.get(String(v.id));
                if (!p)
                    return;
                this.pending.delete(String(v.id));
                clearTimeout(p.timer);
                v.error ? p.reject(Object.assign(new Error(v.error.message), { code: v.error.code })) : p.resolve(v.result);
            }
            catch {
                child.kill();
            } });
            const hello = await this.send('engine.hello', {}, 'hello', 15000);
            if (hello.protocolVersion !== 1) {
                child.kill();
                throw new Error('Incompatible engine protocol version');
            }
            return hello;
        })();
        return this.ready;
    }
    private send(method: string, params: any, id: string = randomUUID(), timeout = 120000): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.child) {
                reject(new Error('Engine is not running'));
                return;
            }
            const timer = setTimeout(() => { this.pending.delete(id); this.child?.kill('SIGTERM'); reject(new Error('Engine timed out and was stopped; partial output may remain')); }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    }
    async request(method: string, params: any, id?: string) { await this.start(); return this.send(method, params, id, method === 'task.export' ? 24 * 60 * 60 * 1000 : 120000); }
    close() { const child = this.child; if (!child)
        return; child.stdin.end(); const timer = setTimeout(() => child.kill('SIGKILL'), 1500); timer.unref(); child.once('exit', () => clearTimeout(timer)); }
}
