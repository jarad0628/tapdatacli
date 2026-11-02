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
    async search(name?: string, version?: string, signal?: AbortSignal): Promise<RemoteConnector[]> {
        const artifact = name ? connectorName(name) : undefined;
        const found: RemoteConnector[] = [];
        const tokens = new Set<string>();
        let token: string | undefined;
        do {
            const url = new URL('service/rest/v1/search', this.base);
            url.searchParams.set('repository', this.repository);
            url.searchParams.set('group', 'io.tapdata');
            url.searchParams.set('sort', 'version'); url.searchParams.set('direction', 'desc');
            if (artifact) url.searchParams.set('name', artifact);
            if (version) url.searchParams.set('version', version);
            if (token) url.searchParams.set('continuationToken', token);
            const page: any = await (await this.request(url, signal)).json();
            if (!Array.isArray(page.items)) throw new Error('Invalid Nexus search response');
            for (const item of page.items) {
                if (item.group !== 'io.tapdata' || !/^[a-z0-9][a-z0-9._-]*-connector$/.test(item.name) || (artifact && item.name !== artifact) || (version && item.version !== version)) continue;
                for (const asset of item.assets ?? []) {
                    // Only the runnable main JAR; never sources, javadoc, tests or arbitrary classifiers.
                    if (asset.maven2?.extension !== 'jar' || asset.maven2?.classifier) continue;
                    const download = new URL(asset.downloadUrl);
                    const prefix = new URL(`repository/${this.repository}/io/tapdata/`, this.base);
                    if (download.origin !== this.base.origin || !download.pathname.startsWith(prefix.pathname) || download.username || download.password || download.search || download.hash)
                        throw new Error('Nexus returned an untrusted download URL');
                    if (!/^[a-f0-9]{64}$/i.test(asset.checksum?.sha256 ?? '')) throw new Error('Nexus artifact is missing SHA-256');
                    found.push({ artifactId: item.name, group: item.group, version: item.version, repository: this.repository, url: download.href, sha256: asset.checksum.sha256.toLowerCase(), size: asset.fileSize });
                }
            }
            token = page.continuationToken || undefined;
            if (token && (tokens.has(token) || tokens.size >= 1000)) throw new Error('Nexus pagination did not complete');
            if (token) tokens.add(token);
        } while (token);
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
