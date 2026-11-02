import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type ExecutionOptions = { signal?: AbortSignal; onOutput?: (text: string) => void; env?: NodeJS.ProcessEnv };

/** Host-owned processes, shared by all AI providers and direct commands. */
export class LocalProcesses {
    private active = new Map<() => void, Promise<void>>();
    constructor(private home: string) {}
    async close() {
        const pending = [...this.active.values()];
        for (const stop of this.active.keys()) stop();
        await Promise.all(pending);
    }
    async execute(cwd: string, argv: string[], timeout: number, options: ExecutionOptions = {}) {
        options.signal?.throwIfAborted();
        const folder = join(this.home, 'logs');
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const log = join(folder, `local-${randomUUID()}.log`);
        const fd = openSync(log, 'wx', 0o600);
        return new Promise<any>((resolve, reject) => {
            let stdout = '', stderr = '', truncated = false, reason = '';
            let killTimer: NodeJS.Timeout | undefined;
            const grouped = process.platform !== 'win32';
            const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'], env: options.env ? { ...process.env, ...options.env } : process.env });
            const kill = (signal: NodeJS.Signals) => {
                try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {}
            };
            const stop = (why: string) => {
                if (reason) return;
                reason = why;
                kill('SIGTERM');
                killTimer = setTimeout(() => kill('SIGKILL'), 2000);
            };
            const close = () => stop('cancelled');
            let finished!: () => void;
            this.active.set(close, new Promise<void>(resolve => { finished = resolve; }));
            const abort = () => stop('cancelled');
            options.signal?.addEventListener('abort', abort, { once: true });
            const timer = setTimeout(() => stop('timeout'), timeout * 1000);
            let lastUpdate = 0, pending = '';
            const flush = () => { if (pending) { options.onOutput?.(pending); pending = ''; lastUpdate = Date.now(); } };
            const consume = (stream: 'stdout' | 'stderr', text: string) => {
                writeSync(fd, text);
                const previous = stream === 'stdout' ? stdout : stderr;
                const tail = previous + text;
                if (tail.length > 12000) truncated = true;
                if (stream === 'stdout') stdout = tail.slice(-12000); else stderr = tail.slice(-12000);
                // Bounded live updates; the complete raw output stays in the private log.
                pending = (pending + text).slice(-2000);
                if (Date.now() - lastUpdate >= 500) flush();
            };
            child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
            child.stdout.on('data', text => consume('stdout', text));
            child.stderr.on('data', text => consume('stderr', text));
            let failure: Error | undefined;
            child.once('error', e => { failure = e; });
            child.once('close', (exitCode, signal) => {
                if (reason && grouped) kill('SIGKILL');
                clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
                options.signal?.removeEventListener('abort', abort);
                this.active.delete(close); closeSync(fd); flush(); finished();
                const result = { cwd, argv, exitCode, signal, status: reason || (exitCode === 0 ? 'succeeded' : 'failed'), stdout, stderr, truncated, log };
                if (failure || reason || exitCode !== 0) reject(Object.assign(new Error(failure ? `Cannot start ${argv[0]}: ${failure.message}` : `Local process ${result.status} (exit ${exitCode ?? signal})`), { details: result }));
                else resolve(result);
            });
            if (options.signal?.aborted) abort();
        });
    }
}
