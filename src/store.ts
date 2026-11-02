import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export type RecordData = Record<string, any>;
export interface State {
    version: 1;
    connectors: RecordData[];
    datasources: RecordData[];
    tasks: RecordData[];
    bindings: RecordData[];
    activeBinding?: string;
}
export function redact(v: any): any {
    if (Array.isArray(v))
        return v.map(redact);
    if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /password|secret|token|api.?key|credential|private.?key/i.test(k) ? '***' : redact(x)]));
    return v;
}
export class Store {
    home: string;
    state: State;
    private key: Buffer;
    private lock?: number;
    constructor(home = process.env.TAPDATACLI_HOME || join(homedir(), '.tapdatacli')) {
        this.home = resolve(home);
        mkdirSync(this.home, { recursive: true, mode: 0o700 });
        chmodSync(this.home, 0o700);
        const keyPath = join(this.home, 'key');
        if (!existsSync(keyPath))
            try {
                writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
            }
            catch (e: any) {
                if (e.code !== 'EEXIST')
                    throw e;
            }
        this.key = readFileSync(keyPath);
        if (this.key.length !== 32)
            throw new Error('Invalid local encryption key');
        this.state = existsSync(join(this.home, 'state.json')) ? JSON.parse(readFileSync(join(this.home, 'state.json'), 'utf8')) : { version: 1, connectors: [], datasources: [], tasks: [], bindings: [] };
        if (this.state.version !== 1)
            throw new Error('Unsupported state version');
    }
    acquire() {
        const path = join(this.home, 'session.lock');
        try {
            this.lock = openSync(path, 'wx', 0o600);
            writeFileSync(this.lock, String(process.pid));
        }
        catch (e: any) {
            if (e.code !== 'EEXIST')
                throw e;
            const pid = Number(readFileSync(path, 'utf8'));
            let alive = true;
            try {
                process.kill(pid, 0);
            }
            catch (x: any) {
                alive = x.code !== 'ESRCH';
            }
            if (alive)
                throw new Error(`Another tapdatacli session owns this workspace (PID ${pid}). Use TAPDATACLI_HOME for a separate workspace.`);
            unlinkSync(path);
            this.acquire();
        }
    }
    release() { if (this.lock !== undefined) {
        closeSync(this.lock);
        unlinkSync(join(this.home, 'session.lock'));
        this.lock = undefined;
    } }
    save() { const path = join(this.home, 'state.json'), tmp = path + `.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 }); renameSync(tmp, path); }
    seal(v: any) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv); const encrypted = Buffer.concat([cipher.update(JSON.stringify(v), 'utf8'), cipher.final()]); return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64')).join('.'); }
    unseal(v: string) { const [iv, tag, data] = v.split('.').map(x => Buffer.from(x, 'base64')); const d = createDecipheriv('aes-256-gcm', this.key, iv); d.setAuthTag(tag); return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8')); }
}
