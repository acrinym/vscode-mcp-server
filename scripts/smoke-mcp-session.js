// Real end-to-end smoke for the MCP session lifecycle. It drives the compiled
// server over HTTP with the SDK client and exercises the in-flight/idle race
// that the unit tests also cover. It runs under plain Node (the server module
// is required after stubbing `vscode`) and is used as a verification receipt.
//
// Usage: node scripts/smoke-mcp-session.js
'use strict';

const assert = require('assert');
const http = require('http');
const Module = require('module');

// The server module imports `vscode` for the logger and terminal types; the
// smoke never starts VS Code, so provide a minimal stub before requiring it.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {
            window: {
                createOutputChannel: () => ({
                    appendLine: () => {},
                    show: () => {},
                    dispose: () => {}
                })
            }
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { MCPServer } = require('../out/server.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const FILE_TOOLS_ONLY = { file: true, edit: false, shell: false, diagnostics: false, symbol: false };
const FILES = [{ path: 'a.ts', type: 'file' }, { path: 'src', type: 'directory' }];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rawRequest(port, method, body, options = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers = { Accept: options.accept ?? 'application/json, text/event-stream' };
        if (payload !== undefined) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (options.origin) { headers['Origin'] = options.origin; }
        if (options.sessionId) { headers['Mcp-Session-Id'] = options.sessionId; }
        const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method, headers }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8')
            }));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

function newServer(limits = {}) {
    const server = new MCPServer(0, '127.0.0.1', undefined, FILE_TOOLS_ONLY, limits);
    server.setFileListingCallback(async () => FILES);
    return server;
}

function endpoint(server) {
    return new URL(`http://127.0.0.1:${server.boundPort}/mcp`);
}

const INITIALIZE_BODY = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } }
};

const passed = [];
async function step(name, fn) {
    await fn();
    passed.push(name);
    console.log(`PASS  ${name}`);
}

async function main() {
    // 1. Browser-style multi-request flow with the session id read back from
    //    the response header, plus loopback CORS reflection.
    await step('browser-style initialize -> list -> call -> list with CORS', async () => {
        const server = newServer();
        await server.start();
        try {
            const port = server.boundPort;
            const init = await rawRequest(port, 'POST', INITIALIZE_BODY, { origin: 'http://localhost:5173' });
            assert.strictEqual(init.status, 200);
            assert.strictEqual(init.headers['access-control-allow-origin'], 'http://localhost:5173');
            assert.strictEqual(init.headers['access-control-expose-headers'], 'Mcp-Session-Id');
            const sessionId = init.headers['mcp-session-id'];
            assert.ok(sessionId, 'expected session id');

            const list = await rawRequest(port, 'POST', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
                { origin: 'http://localhost:5173', sessionId });
            assert.strictEqual(list.status, 200);
            assert.strictEqual(list.headers['access-control-allow-origin'], 'http://localhost:5173');

            const call = await rawRequest(port, 'POST',
                { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_files_code', arguments: { path: '.', recursive: false } } },
                { origin: 'http://localhost:5173', sessionId });
            assert.strictEqual(call.status, 200);
            assert.deepStrictEqual(JSON.parse(call.body).result.content[0].text, JSON.stringify(FILES, null, 2));

            const listAgain = await rawRequest(port, 'POST', { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
                { origin: 'http://localhost:5173', sessionId });
            assert.strictEqual(listAgain.status, 200);

            for (const origin of ['http://evil.example.com', 'null', 'http://192.168.1.10']) {
                const hostile = await rawRequest(port, 'POST', INITIALIZE_BODY, { origin });
                assert.strictEqual(hostile.headers['access-control-allow-origin'], undefined, `ACAO for ${origin}`);
            }
        } finally {
            await server.stop();
        }
    });

    // 2. Three concurrent, isolated SDK-client sessions.
    await step('three concurrent isolated SDK sessions', async () => {
        const server = newServer();
        await server.start();
        try {
            const clients = [0, 1, 2].map((i) => ({
                client: new Client({ name: `c${i}`, version: '1.0.0' }),
                transport: new StreamableHTTPClientTransport(endpoint(server))
            }));
            try {
                await Promise.all(clients.map((c) => c.client.connect(c.transport)));
                const ids = new Set(clients.map((c) => c.transport.sessionId));
                assert.strictEqual(ids.size, 3, 'expected three distinct session ids');
                const tools = await Promise.all(clients.map((c) => c.client.listTools()));
                for (const t of tools) {
                    assert.strictEqual(t.tools.length, 5);
                }
            } finally {
                await Promise.all(clients.map((c) => c.client.close()));
            }
        } finally {
            await server.stop();
        }
    });

    // 3. The blocking defect: a tool call whose work exceeds idleTimeoutMs must
    //    still complete, keep the session usable, and expire only once idle.
    await step('work exceeding idleTimeoutMs completes and stays usable', async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const server = new MCPServer(0, '127.0.0.1', undefined, FILE_TOOLS_ONLY, { idleTimeoutMs: 300 });
        server.setFileListingCallback(async () => { await gate; return FILES; });
        await server.start();
        const client = new Client({ name: 'slow', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(endpoint(server));
        try {
            await client.connect(transport);
            const sessionId = transport.sessionId;

            const slowCall = client.callTool({ name: 'list_files_code', arguments: { path: '.', recursive: false } });
            // Let the idle timeout elapse while the request is still in flight.
            await sleep(700);
            const stillAlive = await rawRequest(server.boundPort, 'POST',
                { jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }, { sessionId });
            assert.strictEqual(stillAlive.status, 200, 'session was evicted while a request was in flight');

            release();
            const result = await slowCall;
            assert.deepStrictEqual(JSON.parse(result.content[0].text), FILES);

            // Usable after the long call.
            const tools = await client.listTools();
            assert.strictEqual(tools.tools.length, 5);

            // Idle expiry still applies: no request for longer than the timeout.
            await sleep(700);
            const expired = await rawRequest(server.boundPort, 'POST',
                { jsonrpc: '2.0', id: 100, method: 'tools/list', params: {} }, { sessionId });
            assert.strictEqual(expired.status, 400, 'idle session was not reclaimed');
        } finally {
            await client.close();
            await server.stop();
        }
    });

    // 4. DELETE reclamation and max-session capacity.
    await step('DELETE reclaims and capacity frees a slot', async () => {
        const server = newServer({ idleTimeoutMs: 60_000, maxSessions: 2 });
        await server.start();
        try {
            const a = new Client({ name: 'a', version: '1.0.0' });
            const at = new StreamableHTTPClientTransport(endpoint(server));
            const b = new Client({ name: 'b', version: '1.0.0' });
            const bt = new StreamableHTTPClientTransport(endpoint(server));
            try {
                await a.connect(at);
                await b.connect(bt);
                const rejected = await rawRequest(server.boundPort, 'POST', INITIALIZE_BODY);
                assert.strictEqual(rejected.status, 503);
                await at.terminateSession();
                const accepted = await rawRequest(server.boundPort, 'POST', INITIALIZE_BODY);
                assert.strictEqual(accepted.status, 200);
            } finally {
                await a.close();
                await b.close();
            }
        } finally {
            await server.stop();
        }
    });

    // 5. Concurrent and repeated stop() all resolve, no server bound.
    await step('concurrent and repeated stop() resolve', async () => {
        const server = newServer();
        await server.start();
        const client = new Client({ name: 'stop', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(endpoint(server)));
        await client.close();
        await Promise.all([server.stop(), server.stop(), server.stop()]);
        await server.stop();
        assert.strictEqual(server.boundPort, undefined);
    });

    console.log(`\nSmoke PASS: ${passed.length} checks`);
}

main().then(() => process.exit(0)).catch((error) => {
    console.error('\nSmoke FAIL:', error && error.stack ? error.stack : error);
    process.exit(1);
});
