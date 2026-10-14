import * as assert from 'assert';
import * as http from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCPServer, ToolConfiguration, SessionLimits, isLoopbackOrigin } from '../server';
import { FileListingResult } from '../tools/file-tools';

const FILE_TOOLS_ONLY: ToolConfiguration = {
    file: true,
    edit: false,
    shell: false,
    diagnostics: false,
    symbol: false
};

const FILES: FileListingResult = [
    { path: 'a.ts', type: 'file' },
    { path: 'src', type: 'directory' }
];

const INITIALIZE_BODY = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw-client', version: '1.0.0' }
    }
};

const LIST_TOOLS_BODY = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
};

function endpoint(server: MCPServer): URL {
    const port = server.boundPort;
    assert.ok(port, 'server did not bind a port');
    return new URL(`http://127.0.0.1:${port}/mcp`);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RawResponse {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
}

/**
 * Sends a request over raw HTTP so the caller controls the exact header set.
 * `sessionHeaders` may contain repeated values to reproduce duplicate
 * Mcp-Session-Id headers, which Node joins into one comma-separated value.
 */
function rawRequest(
    port: number,
    method: string,
    body: object | undefined,
    options: { sessionHeaders?: string[]; origin?: string; accept?: string } = {}
): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        // Node emits one header line per array entry, so an array reproduces a
        // duplicate Mcp-Session-Id header.
        const headers: http.OutgoingHttpHeaders = {
            Accept: options.accept ?? 'application/json, text/event-stream'
        };
        if (payload !== undefined) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (options.origin !== undefined) {
            headers['Origin'] = options.origin;
        }
        if (options.sessionHeaders !== undefined && options.sessionHeaders.length > 0) {
            headers['Mcp-Session-Id'] = options.sessionHeaders;
        }
        const req = http.request(
            { host: '127.0.0.1', port, path: '/mcp', method, headers },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk) => chunks.push(chunk as Buffer));
                res.on('end', () => resolve({
                    status: res.statusCode ?? 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf8')
                }));
            }
        );
        req.on('error', reject);
        req.end(payload);
    });
}

function startServer(limits: SessionLimits = {}): MCPServer {
    const server = new MCPServer(0, '127.0.0.1', undefined, FILE_TOOLS_ONLY, limits);
    server.setFileListingCallback(async () => FILES);
    return server;
}

suite('MCPServer transport lifecycle', () => {
    let server: MCPServer;

    setup(async () => {
        server = startServer();
        await server.start();
    });

    teardown(async () => {
        await server.stop();
    });

    test('a single session can initialize and issue multiple requests', async () => {
        const client = new Client({ name: 'lifecycle-client', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(endpoint(server));
        try {
            await client.connect(transport);
            assert.ok(transport.sessionId, 'expected a session id after initialize');

            const tools = await client.listTools();
            assert.deepStrictEqual(
                tools.tools.map((tool) => tool.name).sort(),
                ['copy_file_code', 'list_files_code', 'move_file_code', 'read_file_code', 'rename_file_code']
            );

            const call = await client.callTool({
                name: 'list_files_code',
                arguments: { path: '.', recursive: false }
            });
            const text = (call.content as Array<{ type: string; text: string }>)[0].text;
            assert.deepStrictEqual(JSON.parse(text), FILES);

            // A third request proves the session is not consumed after one call.
            const toolsAgain = await client.listTools();
            assert.strictEqual(toolsAgain.tools.length, tools.tools.length);
        } finally {
            await client.close();
        }
    });

    test('independent sessions are isolated', async () => {
        const first = new Client({ name: 'session-one', version: '1.0.0' });
        const firstTransport = new StreamableHTTPClientTransport(endpoint(server));
        const second = new Client({ name: 'session-two', version: '1.0.0' });
        const secondTransport = new StreamableHTTPClientTransport(endpoint(server));
        try {
            await first.connect(firstTransport);
            await second.connect(secondTransport);

            assert.notStrictEqual(firstTransport.sessionId, secondTransport.sessionId);

            const [firstTools, secondTools] = await Promise.all([
                first.listTools(),
                second.listTools()
            ]);
            assert.strictEqual(firstTools.tools.length, secondTools.tools.length);
        } finally {
            await first.close();
            await second.close();
        }
    });

    test('requests with an unknown session id are rejected', async () => {
        const response = await rawRequest(server.boundPort!, 'POST', LIST_TOOLS_BODY, {
            sessionHeaders: ['does-not-exist']
        });
        assert.strictEqual(response.status, 400);
    });

    test('duplicate Mcp-Session-Id headers are rejected', async () => {
        const response = await rawRequest(server.boundPort!, 'POST', LIST_TOOLS_BODY, {
            sessionHeaders: ['first', 'second']
        });
        assert.strictEqual(response.status, 400);
    });

    test('an empty Mcp-Session-Id header is rejected', async () => {
        const response = await rawRequest(server.boundPort!, 'POST', LIST_TOOLS_BODY, {
            sessionHeaders: ['   ']
        });
        assert.strictEqual(response.status, 400);
    });

    test('DELETE reclaims a session', async () => {
        const client = new Client({ name: 'delete-client', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(endpoint(server));
        await client.connect(transport);
        const sessionId = transport.sessionId;
        assert.ok(sessionId, 'expected a session id after initialize');

        // The session is usable before deletion.
        const before = await rawRequest(server.boundPort!, 'POST', LIST_TOOLS_BODY, {
            sessionHeaders: [sessionId]
        });
        assert.strictEqual(before.status, 200);

        await transport.terminateSession();

        // The reclaimed session id is no longer accepted.
        const after = await rawRequest(server.boundPort!, 'POST', LIST_TOOLS_BODY, {
            sessionHeaders: [sessionId]
        });
        assert.strictEqual(after.status, 400);
    });

    test('a session without DELETE is retained until the idle timeout', async () => {
        const idleServer = startServer({ idleTimeoutMs: 300 });
        await idleServer.start();
        const client = new Client({ name: 'idle-client', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(endpoint(idleServer));
        try {
            await client.connect(transport);
            const sessionId = transport.sessionId;
            assert.ok(sessionId, 'expected a session id after initialize');

            // Refreshed while active: the session survives past the timeout
            // because each request resets the idle timer.
            for (let i = 0; i < 4; i++) {
                await sleep(150);
                const active = await rawRequest(idleServer.boundPort!, 'POST', LIST_TOOLS_BODY, {
                    sessionHeaders: [sessionId]
                });
                assert.strictEqual(active.status, 200, `session dropped while active on ping ${i}`);
            }

            // Abandoned: no request for longer than the timeout reclaims it.
            await sleep(500);
            const expired = await rawRequest(idleServer.boundPort!, 'POST', LIST_TOOLS_BODY, {
                sessionHeaders: [sessionId]
            });
            assert.strictEqual(expired.status, 400);
        } finally {
            await client.close();
            await idleServer.stop();
        }
    });

    test('sessions are capped at maxSessions and capacity is freed by DELETE', async () => {
        const cappedServer = startServer({ idleTimeoutMs: 60_000, maxSessions: 2 });
        await cappedServer.start();
        const first = new Client({ name: 'cap-one', version: '1.0.0' });
        const firstTransport = new StreamableHTTPClientTransport(endpoint(cappedServer));
        const second = new Client({ name: 'cap-two', version: '1.0.0' });
        const secondTransport = new StreamableHTTPClientTransport(endpoint(cappedServer));
        try {
            await first.connect(firstTransport);
            await second.connect(secondTransport);

            const rejected = await rawRequest(cappedServer.boundPort!, 'POST', INITIALIZE_BODY);
            assert.strictEqual(rejected.status, 503);

            // Reclaiming one session frees a slot for a new one.
            await firstTransport.terminateSession();
            const accepted = await rawRequest(cappedServer.boundPort!, 'POST', INITIALIZE_BODY);
            assert.strictEqual(accepted.status, 200);
        } finally {
            await first.close();
            await second.close();
            await cappedServer.stop();
        }
    });

    test('stop() is idempotent and concurrent callers share one shutdown', async () => {
        const stopServer = startServer();
        await stopServer.start();
        const client = new Client({ name: 'stop-client', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(endpoint(stopServer));
        await client.connect(transport);
        await client.close();

        await Promise.all([
            stopServer.stop(),
            stopServer.stop(),
            stopServer.stop()
        ]);
        // A later sequential caller resolves too, with no server bound.
        await stopServer.stop();
        assert.strictEqual(stopServer.boundPort, undefined);
    });
});

suite('MCPServer network exposure', () => {
    test('CORS reflects loopback origins only on OPTIONS preflight', async () => {
        const server = startServer();
        await server.start();
        try {
            const port = server.boundPort!;
            const loopback = await rawRequest(port, 'OPTIONS', undefined, { origin: 'http://localhost:5173' });
            assert.strictEqual(loopback.headers['access-control-allow-origin'], 'http://localhost:5173');
            assert.strictEqual(loopback.headers['vary'], 'Origin');

            const remote = await rawRequest(port, 'OPTIONS', undefined, { origin: 'http://evil.example.com' });
            assert.strictEqual(remote.headers['access-control-allow-origin'], undefined);
        } finally {
            await server.stop();
        }
    });

    test('CORS is applied to actual MCP responses, not only OPTIONS', async () => {
        const server = startServer();
        await server.start();
        try {
            const port = server.boundPort!;

            // A real browser-style POST (initialize) from a loopback origin
            // succeeds and is readable cross-origin.
            const init = await rawRequest(port, 'POST', INITIALIZE_BODY, { origin: 'http://localhost:5173' });
            assert.strictEqual(init.status, 200);
            assert.strictEqual(init.headers['access-control-allow-origin'], 'http://localhost:5173');
            assert.strictEqual(init.headers['access-control-expose-headers'], 'Mcp-Session-Id');
            assert.strictEqual(init.headers['vary'], 'Origin');

            const sessionId = init.headers['mcp-session-id'];
            assert.ok(typeof sessionId === 'string' && sessionId.length > 0, 'expected a session id from initialize');

            // A follow-up browser-style request on the same session is readable too.
            const listed = await rawRequest(port, 'POST', LIST_TOOLS_BODY, {
                origin: 'http://127.0.0.1:5173',
                sessionHeaders: [sessionId as string]
            });
            assert.strictEqual(listed.status, 200);
            assert.strictEqual(listed.headers['access-control-allow-origin'], 'http://127.0.0.1:5173');

            // Hostile and null origins get no Access-Control-Allow-Origin.
            for (const origin of ['http://evil.example.com', 'null', 'http://192.168.1.10']) {
                const hostile = await rawRequest(port, 'POST', INITIALIZE_BODY, { origin });
                assert.strictEqual(
                    hostile.headers['access-control-allow-origin'],
                    undefined,
                    `unexpected ACAO for origin ${origin}`
                );
                assert.strictEqual(hostile.headers['access-control-expose-headers'], undefined);
                assert.strictEqual(hostile.headers['vary'], 'Origin');
            }

            // Error responses carry the same CORS decision.
            const badSession = await rawRequest(port, 'POST', LIST_TOOLS_BODY, {
                origin: 'http://localhost:5173',
                sessionHeaders: ['nope']
            });
            assert.strictEqual(badSession.status, 400);
            assert.strictEqual(badSession.headers['access-control-allow-origin'], 'http://localhost:5173');

            // Non-browser clients send no Origin and are unaffected.
            const noOrigin = await rawRequest(port, 'POST', LIST_TOOLS_BODY, { sessionHeaders: ['nope'] });
            assert.strictEqual(noOrigin.status, 400);
            assert.strictEqual(noOrigin.headers['access-control-allow-origin'], undefined);
        } finally {
            await server.stop();
        }
    });

    test('refuses to bind a non-loopback host', async () => {
        const exposed = new MCPServer(0, '0.0.0.0', undefined, FILE_TOOLS_ONLY);
        exposed.setFileListingCallback(async () => FILES);
        await assert.rejects(() => exposed.start(), /non-loopback host/);
        assert.strictEqual(exposed.boundPort, undefined);
    });

    test('isLoopbackOrigin recognises loopback hostnames', () => {
        assert.strictEqual(isLoopbackOrigin('http://localhost:3000'), true);
        assert.strictEqual(isLoopbackOrigin('http://127.0.0.1:3000'), true);
        assert.strictEqual(isLoopbackOrigin('http://[::1]:3000'), true);
        assert.strictEqual(isLoopbackOrigin('http://192.168.1.10:3000'), false);
        assert.strictEqual(isLoopbackOrigin('null'), false);
        assert.strictEqual(isLoopbackOrigin('not a url'), false);
    });
});
