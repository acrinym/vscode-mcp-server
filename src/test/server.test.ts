import * as assert from 'assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCPServer, ToolConfiguration, isLoopbackOrigin } from '../server';
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

function endpoint(server: MCPServer): URL {
    const port = server.boundPort;
    assert.ok(port, 'server did not bind a port');
    return new URL(`http://127.0.0.1:${port}/mcp`);
}

suite('MCPServer transport lifecycle', () => {
    let server: MCPServer;

    setup(async () => {
        server = new MCPServer(0, '127.0.0.1', undefined, FILE_TOOLS_ONLY);
        server.setFileListingCallback(async () => FILES);
        server.setupTools();
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
        const port = server.boundPort;
        const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                'mcp-session-id': 'does-not-exist'
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        });
        assert.strictEqual(response.status, 400);
    });
});

suite('MCPServer network exposure', () => {
    test('CORS reflects loopback origins only', async () => {
        const server = new MCPServer(0, '127.0.0.1', undefined, FILE_TOOLS_ONLY);
        server.setFileListingCallback(async () => FILES);
        server.setupTools();
        await server.start();
        try {
            const port = server.boundPort;
            const loopback = await fetch(`http://127.0.0.1:${port}/mcp`, {
                method: 'OPTIONS',
                headers: { 'Origin': 'http://localhost:5173' }
            });
            assert.strictEqual(loopback.headers.get('access-control-allow-origin'), 'http://localhost:5173');

            const remote = await fetch(`http://127.0.0.1:${port}/mcp`, {
                method: 'OPTIONS',
                headers: { 'Origin': 'http://evil.example.com' }
            });
            assert.strictEqual(remote.headers.get('access-control-allow-origin'), null);
        } finally {
            await server.stop();
        }
    });

    test('refuses to bind a non-loopback host', async () => {
        const server = new MCPServer(0, '0.0.0.0', undefined, FILE_TOOLS_ONLY);
        server.setFileListingCallback(async () => FILES);
        server.setupTools();
        await assert.rejects(() => server.start(), /non-loopback host/);
    });

    test('isLoopbackOrigin recognises loopback hostnames', () => {
        assert.strictEqual(isLoopbackOrigin('http://localhost:3000'), true);
        assert.strictEqual(isLoopbackOrigin('http://127.0.0.1:3000'), true);
        assert.strictEqual(isLoopbackOrigin('http://[::1]:3000'), true);
        assert.strictEqual(isLoopbackOrigin('http://192.168.1.10:3000'), false);
        assert.strictEqual(isLoopbackOrigin('not a url'), false);
    });
});
