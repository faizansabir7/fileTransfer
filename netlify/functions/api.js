/**
 * Netlify Function — handles all /api/* routes
 * State stored in Upstash Redis (set UPSTASH_REDIS_URL + UPSTASH_REDIS_TOKEN env vars)
 */

const HOST_EXPIRY = 45; // seconds — remove hosts not heartbeated in 45s

// ── Upstash Redis REST client ────────────────────────────────────────────────

async function redis(command, ...args) {
    const res = await fetch(process.env.UPSTASH_REDIS_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.UPSTASH_REDIS_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify([command, ...args]),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.result;
}

async function pipeline(commands) {
    const res = await fetch(`${process.env.UPSTASH_REDIS_URL}/pipeline`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.UPSTASH_REDIS_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(commands),
    });
    const data = await res.json();
    return data.map(r => r.result);
}

// ── Response helpers ─────────────────────────────────────────────────────────

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

const ok = (data) => ({
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
});

const err = (status, msg) => ({
    statusCode: status,
    headers: CORS,
    body: String(msg),
});

// ── Route handlers ───────────────────────────────────────────────────────────

async function networkInfo() {
    const url = process.env.PUBLIC_URL || '';
    return ok({ local_ip: '', server_url: url, https_url: url, status: 'running' });
}

async function registerHost(body) {
    const { name } = JSON.parse(body);
    const cleanName = (name || 'Unknown Device').trim().slice(0, 50);
    const hostId    = 'host_' + Math.random().toString(36).slice(2, 14);
    const now       = Math.floor(Date.now() / 1000);
    const url       = process.env.PUBLIC_URL || '';

    await pipeline([
        ['SET', `host:${hostId}`, JSON.stringify({ name: cleanName, server_url: url, last_seen: now }), 'EX', HOST_EXPIRY * 4],
        ['SADD', 'hosts', hostId],
        ['EXPIRE', 'hosts', HOST_EXPIRY * 4],
    ]);

    return ok({ hostId, server_url: url });
}

async function heartbeat(body) {
    const { hostId } = JSON.parse(body);
    const raw = await redis('GET', `host:${hostId}`);
    if (!raw) return err(404, 'Host not found');

    const host = JSON.parse(raw);
    host.last_seen = Math.floor(Date.now() / 1000);
    await redis('SET', `host:${hostId}`, JSON.stringify(host), 'EX', HOST_EXPIRY * 4);
    return ok({ status: 'ok' });
}

async function deregisterHost(hostId) {
    const fileIds = await redis('SMEMBERS', `hostfiles:${hostId}`) || [];
    const cmds = [
        ['DEL', `host:${hostId}`],
        ['SREM', 'hosts', hostId],
        ['DEL', `hostfiles:${hostId}`],
        ...fileIds.map(fid => ['DEL', `file:${fid}`]),
    ];
    await pipeline(cmds);
    return ok({ status: 'ok' });
}

async function hostsList() {
    const now     = Math.floor(Date.now() / 1000);
    const hostIds = await redis('SMEMBERS', 'hosts') || [];

    const hosts = [];
    for (const hid of hostIds) {
        const raw = await redis('GET', `host:${hid}`);
        if (!raw) { await redis('SREM', 'hosts', hid); continue; }

        const h = JSON.parse(raw);
        if (now - h.last_seen > HOST_EXPIRY) {
            await pipeline([['DEL', `host:${hid}`], ['SREM', 'hosts', hid]]);
            continue;
        }

        const fileIds = await redis('SMEMBERS', `hostfiles:${hid}`) || [];
        hosts.push({ hostId: hid, name: h.name, ip: '', server_url: h.server_url, files_count: fileIds.length });
    }

    return ok({ hosts });
}

async function signalPost(body) {
    const msg = JSON.parse(body);
    if (!msg.to) return err(400, "Missing 'to' field");

    // Each message gets a unique key — avoids read-modify-write race conditions
    const key = `inbox:${msg.to}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await pipeline([
        ['SET', key, JSON.stringify(msg), 'EX', 60],
    ]);
    return ok({ status: 'success' });
}

async function signalGet(params) {
    const peerId = params?.peerId;
    if (!peerId) return err(400, 'Missing peerId');

    // List all messages for this peer, read them, then delete
    // Using SCAN to find keys matching inbox:{peerId}:*
    const keys = await redis('KEYS', `inbox:${peerId}:*`) || [];
    if (keys.length === 0) return ok({ messages: [] });

    const values  = await pipeline(keys.map(k => ['GET', k]));
    await pipeline(keys.map(k => ['DEL', k]));

    const messages = values
        .filter(Boolean)
        .map(v => { try { return JSON.parse(v); } catch { return null; } })
        .filter(Boolean);

    return ok({ messages });
}

async function registerFile(body) {
    const info = JSON.parse(body);
    const ttl  = HOST_EXPIRY * 4;
    await pipeline([
        ['SET', `file:${info.id}`, JSON.stringify({ name: info.name, size: info.size, type: info.type, host_id: info.hostId || '' }), 'EX', ttl],
        ['SADD', `hostfiles:${info.hostId}`, info.id],
        ['EXPIRE', `hostfiles:${info.hostId}`, ttl],
    ]);
    return ok({ status: 'success' });
}

async function fileList(params) {
    const hostId  = params?.hostId;
    let   fileIds = [];

    if (hostId) {
        fileIds = await redis('SMEMBERS', `hostfiles:${hostId}`) || [];
    } else {
        const hostIds = await redis('SMEMBERS', 'hosts') || [];
        for (const hid of hostIds) {
            const ids = await redis('SMEMBERS', `hostfiles:${hid}`) || [];
            fileIds.push(...ids);
        }
    }

    const files = [];
    for (const fid of fileIds) {
        const raw = await redis('GET', `file:${fid}`);
        if (raw) {
            const f = JSON.parse(raw);
            files.push({ id: fid, name: f.name, size: f.size, type: f.type });
        }
    }

    return ok({ files });
}

async function removeFile(fileId) {
    const raw = await redis('GET', `file:${fileId}`);
    if (!raw) return err(404, 'File not found');
    const f = JSON.parse(raw);
    await pipeline([
        ['DEL', `file:${fileId}`],
        ['SREM', `hostfiles:${f.host_id}`, fileId],
    ]);
    return ok({ status: 'success' });
}

// ── Main handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: CORS, body: '' };
    }

    const path   = event.path;        // e.g. /api/signal
    const method = event.httpMethod;
    const params = event.queryStringParameters || {};
    const body   = event.body || '{}';

    try {
        if (method === 'GET'    && path === '/api/network-info')           return networkInfo();
        if (method === 'GET'    && path === '/api/hosts')                  return hostsList();
        if (method === 'POST'   && path === '/api/register-host')          return registerHost(body);
        if (method === 'POST'   && path === '/api/heartbeat')              return heartbeat(body);
        if (method === 'GET'    && path.startsWith('/api/signal'))         return signalGet(params);
        if (method === 'POST'   && path === '/api/signal')                 return signalPost(body);
        if (method === 'POST'   && path === '/api/register-file')          return registerFile(body);
        if (method === 'GET'    && path.startsWith('/api/files'))          return fileList(params);

        const deregMatch  = path.match(/^\/api\/deregister-host\/(.+)$/);
        if (method === 'DELETE' && deregMatch)  return deregisterHost(deregMatch[1]);

        const removeMatch = path.match(/^\/api\/remove-file\/(.+)$/);
        if (method === 'DELETE' && removeMatch) return removeFile(removeMatch[1]);

        return err(404, 'Not found');
    } catch (e) {
        console.error('API error:', e);
        return err(500, e.message);
    }
};
