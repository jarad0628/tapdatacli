import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ExecutionOptions } from './local.js';

export type RemoteConnector = {
    artifactId: string; group: string; version: string; repository: string;
    url: string; sha256: string; size?: number;
};
export function connectorName(input: string) {
    const name = input.toLowerCase();
    const alias: Record<string, string> = { pg: 'postgres', postgresql: 'postgres', mongo: 'mongodb' };
    const artifact = (alias[name] ?? name).replace(/-connector$/, '') + '-connector';
    if (!/^[a-z0-9][a-z0-9._-]*-connector$/.test(artifact)) throw new Error('Invalid connector name');
    return artifact;
}
const hashFile = async (file: string) => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
};
export class Nexus {
    readonly base: URL;
    readonly repository: string;
    constructor(private home: string, repository?: string) {
        this.base = new URL(process.env.TAPDATACLI_NEXUS_URL || 'https://nexus.tapdata.net');
        if (this.base.username || this.base.password || this.base.search || this.base.hash || !['http:', 'https:'].includes(this.base.protocol))
            throw new Error('Invalid TAPDATACLI_NEXUS_URL; use a server URL without credentials');
        if (this.base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname))
            throw new Error('Nexus requires HTTPS (HTTP is allowed for local testing only)');
        this.base.pathname = this.base.pathname.replace(/\/$/, '') + '/';
        this.repository = repository ?? process.env.TAPDATACLI_NEXUS_REPOSITORY ?? 'maven-releases';
        if (!/^[a-zA-Z0-9._-]+$/.test(this.repository)) throw new Error('Invalid Nexus repository');
    }
    private async request(url: URL, signal?: AbortSignal, timeout = 30000) {
        const headers: Record<string, string> = {};
        if (process.env.TAPDATACLI_NEXUS_TOKEN) headers.Authorization = `Bearer ${process.env.TAPDATACLI_NEXUS_TOKEN}`;
        else if (process.env.TAPDATACLI_NEXUS_USER && process.env.TAPDATACLI_NEXUS_PASSWORD)
            headers.Authorization = 'Basic ' + Buffer.from(`${process.env.TAPDATACLI_NEXUS_USER}:${process.env.TAPDATACLI_NEXUS_PASSWORD}`).toString('base64');
        let response: Response;
        try {
            response = await fetch(url, { headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
        } catch (e: any) {
            signal?.throwIfAborted();
            throw new Error(`Nexus request failed (${e.cause?.code ?? e.name}); check network and TLS trust. For a private CA use NODE_EXTRA_CA_CERTS.`);
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Nexus HTTP ${response.status}${[401, 403].includes(response.status) ? '; configure TAPDATACLI_NEXUS_TOKEN or TAPDATACLI_NEXUS_USER / TAPDATACLI_NEXUS_PASSWORD' : ''}`);
        }
        return response;
    }
    private repositoryUrl(path = '') {
        return new URL(`${encodeURIComponent(this.repository)}/${path}`, this.base);
    }
    private async directoryEntries(url: URL, signal?: AbortSignal): Promise<{ name: string; directory: boolean }[]> {
        let response: Response;
        try { response = await this.request(url, signal); }
        catch (e) { if (e instanceof Error && e.message.startsWith('Nexus HTTP 404')) return []; throw e; }
        const html = await response.text();
        const entries: { name: string; directory: boolean }[] = [];
        for (const match of html.matchAll(/<li class=["'](directory|file)["'][^>]*>\s*<a href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi)) {
            const directory = match[1].toLowerCase() === 'directory';
            const href = match[2].replace(/&amp;/g, '&');
            const name = match[3].trim().replace(/\/$/, '');
            if (!name || name === 'Parent Directory') continue;
            const target = new URL(href, url);
            if (target.origin !== this.base.origin || !target.pathname.startsWith(url.pathname)) throw new Error('Repository index returned an untrusted path');
            entries.push({ name, directory });
        }
        return entries;
    }
    private async sha256(url: URL, signal?: AbortSignal) {
        const response = await this.request(url, signal);
        const digest = (await response.text()).trim().split(/\s+/)[0]?.toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(digest ?? '')) throw new Error(`Invalid SHA-256 file at ${url.pathname}`);
        return digest;
    }
    async search(name?: string, version?: string, signal?: AbortSignal): Promise<RemoteConnector[]> {
        const artifact = name ? connectorName(name) : undefined;
        const found: RemoteConnector[] = [];
        // nexus.tapdata.net publishes Maven artifacts through the /<repo>/ layout
        // (Reposilite index); its Nexus REST search endpoint can return an empty
        // catalog for artifacts that are directly downloadable from that layout.
        const root = this.repositoryUrl('io/tapdata/');
        const artifacts = artifact ? [{ name: artifact, directory: true }] : (await this.directoryEntries(root, signal))
            .filter(x => x.directory && /^[a-z0-9][a-z0-9._-]*-connector$/.test(x.name));
        for (const item of artifacts) {
            const itemUrl = this.repositoryUrl(`io/tapdata/${encodeURIComponent(item.name)}/`);
            const versions = (await this.directoryEntries(itemUrl, signal))
                .filter(x => x.directory && (!version || x.name === version));
            for (const entry of versions) {
                const dir = this.repositoryUrl(`io/tapdata/${encodeURIComponent(item.name)}/${encodeURIComponent(entry.name)}/`);
                const files = await this.directoryEntries(dir, signal);
                const jarName = `${item.name}-${entry.name}.jar`;
                if (!files.some(x => !x.directory && x.name === jarName) || !files.some(x => !x.directory && x.name === `${jarName}.sha256`)) continue;
                const download = this.repositoryUrl(`io/tapdata/${encodeURIComponent(item.name)}/${encodeURIComponent(entry.name)}/${encodeURIComponent(jarName)}`);
                const digest = await this.sha256(new URL(`${download.pathname}.sha256`, this.base), signal);
                found.push({ artifactId: item.name, group: 'io.tapdata', version: entry.name, repository: this.repository, url: download.href, sha256: digest });
            }
        }
        found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true, sensitivity: 'base' }));
        return found;
    }
    async download(name: string, version?: string, options: ExecutionOptions = {}) {
        options.signal?.throwIfAborted();
        options.onOutput?.(`正在查询 Nexus：${connectorName(name)}${version ? '@' + version : ''}\n`);
        const choices = await this.search(name, version, options.signal);
        const remote = choices[0]; // Nexus Maven version ordering, descending.
        if (!remote) throw new Error(`Nexus ${this.repository} has no published io.tapdata:${connectorName(name)}${version ? ':' + version : ''}. Publish the connector first, choose --repository maven-snapshots, or use --jar PATH.`);
        if (choices.filter(x => x.version === remote.version).length !== 1) throw new Error('Ambiguous Nexus JARs for this version');
        const folder = join(this.home, 'downloads', remote.sha256);
        const jar = join(folder, 'connector.jar');
        if (existsSync(jar) && await hashFile(jar) === remote.sha256) return { ...remote, jar, cached: true };
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const temp = join(folder, randomUUID() + '.partial');
        options.onOutput?.(`正在下载 ${remote.artifactId}@${remote.version}\n`);
        const hash = createHash('sha256');
        let size = 0;
        try {
            const response = await this.request(new URL(remote.url), options.signal, 300000);
            if (!response.body) throw new Error('Empty Nexus download');
            await pipeline(Readable.fromWeb(response.body as any), new Transform({ transform(chunk, _encoding, callback) {
                size += chunk.length;
                if (size > 512 * 1024 * 1024) return callback(new Error('Connector exceeds 512 MiB download limit'));
                hash.update(chunk); callback(null, chunk);
            } }), createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal: options.signal });
            if (hash.digest('hex') !== remote.sha256) throw new Error('Nexus JAR SHA-256 mismatch; download rejected');
            if (remote.size !== undefined && remote.size !== size) throw new Error('Nexus JAR size mismatch');
            options.signal?.throwIfAborted();
            renameSync(temp, jar);
        } finally { rmSync(temp, { force: true }); }
        return { ...remote, jar, cached: false };
    }
}
