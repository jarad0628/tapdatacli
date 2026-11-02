export function tokenize(text: string): string[] {
    const out: string[] = [];
    let value = '', quote = '', escaped = false, started = false;
    for (const c of text.trim()) {
        if (escaped) {
            value += c;
            escaped = false;
            continue;
        }
        if (c === '\\' && quote !== "'") {
            escaped = true;
            started = true;
            continue;
        }
        if (quote) {
            if (c === quote)
                quote = '';
            else
                value += c;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            started = true;
            continue;
        }
        if (/\s/.test(c)) {
            if (started) {
                out.push(value);
                value = '';
                started = false;
            }
            continue;
        }
        value += c;
        started = true;
    }
    if (quote || escaped)
        throw new Error('Unclosed quote or escape');
    if (started)
        out.push(value);
    return out;
}
export function parse(argv: string[]) {
    const positional: string[] = [], flags: Record<string, string[]> = {};
    for (let i = 0; i < argv.length; i++) {
        const x = argv[i];
        if (!x.startsWith('--')) {
            positional.push(x);
            continue;
        }
        const eq = x.indexOf('=');
        const key = x.slice(2, eq < 0 ? undefined : eq);
        let value = eq < 0 ? 'true' : x.slice(eq + 1);
        if (eq < 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--'))
            value = argv[++i];
        (flags[key] ??= []).push(value);
    }
    return { positional, flags, get: (k: string) => flags[k]?.at(-1), all: (k: string) => flags[k] ?? [] };
}
