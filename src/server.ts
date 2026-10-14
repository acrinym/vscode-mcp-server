import express from "express";
import * as vscode from 'vscode';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Server, IncomingMessage } from 'http';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { registerFileTools, FileListingCallback } from './tools/file-tools';
import { registerEditTools } from './tools/edit-tools';
import { registerShellTools } from './tools/shell-tools';
import { registerDiagnosticsTools } from './tools/diagnostics-tools';
import { registerSymbolTools } from './tools/symbol-tools';
import { logger } from './utils/logger';

export interface ToolConfiguration {
    file: boolean;
    edit: boolean;
    shell: boolean;
    diagnostics: boolean;
    symbol: boolean;
}

/**
 * Optional bounds on server-side MCP session state. Both default to a value
 * that keeps a single local client comfortable while still capping the memory
 * an unauthenticated client can pin.
 */
export interface SessionLimits {
    /** Close a session after this many ms without a request. */
    idleTimeoutMs?: number;
    /** Reject new sessions once this many are concurrently tracked. */
    maxSessions?: number;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_SESSIONS = 100;

/**
 * Returns true only for origins served from the loopback interface. Browser
 * clients running on the local machine are allowed; any other origin is not,
 * so a page on the network cannot drive this (unauthenticated) server.
 */
export function isLoopbackOrigin(origin: string): boolean {
    try {
        const { hostname } = new URL(origin);
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
    } catch {
        return false;
    }
}

export class MCPServer {
    private app: express.Application;
    private httpServer?: Server;
    private port: number;
    private host: string;
    private fileListingCallback?: FileListingCallback;
    private terminal?: vscode.Terminal;
    private toolConfig: ToolConfiguration;
    // MCP sessions are independent: each initialized session gets its own
    // transport and its own McpServer. A single transport must not be reused
    // across requests (the SDK rejects stateless reuse), and a single McpServer
    // can only be connected to one transport at a time, so sessions cannot
    // share either. Sessions are keyed by the id the transport reports.
    private transports: Map<string, StreamableHTTPServerTransport> = new Map();
    private servers: Map<string, McpServer> = new Map();
    // Transports that are mid-initialization, before they have reported a
    // session id. Tracked so a request that fails before initialization is
    // still reachable for cleanup.
    private pendingTransports: Set<StreamableHTTPServerTransport> = new Set();
    // Idle sessions are reclaimed after idleTimeoutMs of inactivity and the
    // number of concurrent sessions is capped at maxSessions. Both bound the
    // state an unauthenticated client can pin on the server.
    private idleTimers: Map<string, NodeJS.Timeout> = new Map();
    private readonly idleTimeoutMs: number;
    private readonly maxSessions: number;
    // Concurrent stop() callers await the same in-flight shutdown.
    private stopPromise?: Promise<void>;

    public setFileListingCallback(callback: FileListingCallback) {
        this.fileListingCallback = callback;
    }

    /**
     * The port the HTTP server is actually bound to. Resolves ephemeral ports
     * (port 0) and returns undefined before start() or after stop().
     */
    public get boundPort(): number | undefined {
        const address = this.httpServer?.address();
        return typeof address === 'object' && address !== null ? address.port : undefined;
    }

    constructor(port: number = 3000, host: string = '127.0.0.1', terminal?: vscode.Terminal, toolConfig?: ToolConfiguration, limits: SessionLimits = {}) {
        this.port = port;
        this.host = host;
        this.terminal = terminal;
        this.toolConfig = toolConfig || {
            file: true,
            edit: true,
            shell: true,
            diagnostics: true,
            symbol: true
        };
        this.idleTimeoutMs = limits.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
        this.maxSessions = limits.maxSessions ?? DEFAULT_MAX_SESSIONS;
        this.app = express();
        this.setupCors();
        this.app.use(express.json());

        this.setupRoutes();
        this.setupEventHandlers();
    }

    /**
     * Creates a new McpServer with all configured tools registered. A separate
     * server instance is created for every session because an McpServer can only
     * be connected to a single transport at a time.
     */
    private createServer(): McpServer {
        const server = new McpServer({
            name: "vscode-mcp-server",
            version: "1.0.0",
        }, {
            capabilities: {
                logging: {},
                tools: {
                    listChanged: false
                }
            }
        });
        this.registerTools(server);
        return server;
    }

    /**
     * Validates the tool configuration. Tools are registered on each session's
     * server instance when a session is initialized.
     */
    private logToolConfiguration(): void {
        if (!this.fileListingCallback) {
            logger.warn('File listing callback not set during tools setup');
            return;
        }
        logger.info(`MCP tools configured: ${JSON.stringify(this.toolConfig)}`);
    }

    private registerTools(server: McpServer): void {
        if (!this.fileListingCallback) {
            logger.warn('File listing callback not set - no tools will be registered');
            return;
        }

        // Register file tools if enabled
        if (this.toolConfig.file) {
            registerFileTools(server, this.fileListingCallback);
        }

        // Register edit tools if enabled
        if (this.toolConfig.edit) {
            registerEditTools(server);
        }

        // Register shell tools if enabled
        if (this.toolConfig.shell) {
            registerShellTools(server, this.terminal);
        }

        // Register diagnostics tools if enabled
        if (this.toolConfig.diagnostics) {
            registerDiagnosticsTools(server);
        }

        // Register symbol tools if enabled
        if (this.toolConfig.symbol) {
            registerSymbolTools(server);
        }
    }

    /**
     * Reads the Mcp-Session-Id header. A session id must be a single opaque
     * token: Node joins repeated headers with ", " and may hand back an array,
     * so a duplicate/array header is reported as invalid rather than being
     * concatenated into a value that can never match a session.
     */
    private readSessionId(req: Request): { status: 'absent' } | { status: 'invalid' } | { status: 'ok'; sessionId: string } {
        const raw = req.headers['mcp-session-id'];
        if (raw === undefined) {
            return { status: 'absent' };
        }
        if (typeof raw !== 'string') {
            return { status: 'invalid' };
        }
        const sessionId = raw.trim();
        if (sessionId.length === 0 || sessionId.includes(',')) {
            return { status: 'invalid' };
        }
        return { status: 'ok', sessionId };
    }

    /**
     * Creates a fresh transport and its server for a new MCP session. The
     * transport generates its own session id during initialization and reports
     * it via onsessioninitialized, so the session is registered under that id.
     * While initialization is in flight the transport is held in
     * pendingTransports so it is always reachable for cleanup.
     */
    private async createSession(req: Request, res: Response): Promise<void> {
        if (this.sessionCount() >= this.maxSessions) {
            logger.warn(`[MCPServer] Refusing new MCP session: ${this.sessionCount()} sessions already tracked (max ${this.maxSessions})`);
            res.status(503).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Server busy: too many active MCP sessions',
                },
                id: null,
            });
            return;
        }

        const server = this.createServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (sessionId: string) => {
                this.pendingTransports.delete(transport);
                this.transports.set(sessionId, transport);
                this.servers.set(sessionId, server);
                this.touchSession(sessionId);
            },
        });

        transport.onclose = () => {
            const closedId = transport.sessionId;
            if (closedId) {
                // Deleting before closing makes the re-entrant close() triggered
                // by Protocol.close() a no-op.
                this.closeSession(closedId);
            } else {
                this.pendingTransports.delete(transport);
            }
        };

        this.pendingTransports.add(transport);

        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            if (transport.sessionId) {
                this.closeSession(transport.sessionId);
            } else {
                this.pendingTransports.delete(transport);
                await server.close().catch((closeError) => {
                    logger.error(`Error closing session server: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
                });
            }
            throw error;
        }
    }

    /** Number of tracked sessions, including those still initializing. */
    private sessionCount(): number {
        return this.transports.size + this.pendingTransports.size;
    }

    /**
     * (Re)starts the idle timer for a live session. Sessions that go idle are
     * reclaimed so an abandoned client cannot pin a transport and server
     * forever.
     */
    private touchSession(sessionId: string): void {
        if (!this.transports.has(sessionId)) {
            return;
        }
        this.clearIdleTimer(sessionId);
        const timer = setTimeout(() => {
            logger.info(`[MCPServer] Closing idle MCP session ${sessionId} after ${this.idleTimeoutMs}ms`);
            this.closeSession(sessionId);
        }, this.idleTimeoutMs);
        timer.unref?.();
        this.idleTimers.set(sessionId, timer);
    }

    private clearIdleTimer(sessionId: string): void {
        const timer = this.idleTimers.get(sessionId);
        if (timer) {
            clearTimeout(timer);
            this.idleTimers.delete(sessionId);
        }
    }

    /**
     * Tears down one session. Removing it from the maps first makes repeated
     * calls (for example from the transport's own onclose) safe no-ops.
     */
    private closeSession(sessionId: string): void {
        this.clearIdleTimer(sessionId);
        const transport = this.transports.get(sessionId);
        this.transports.delete(sessionId);
        const server = this.servers.get(sessionId);
        this.servers.delete(sessionId);

        transport?.close().catch((error) => {
            logger.error(`Error closing session transport: ${error instanceof Error ? error.message : String(error)}`);
        });
        server?.close().catch((error) => {
            logger.error(`Error closing session server: ${error instanceof Error ? error.message : String(error)}`);
        });
    }

    private async closeAllTransports(): Promise<void> {
        const transports = [
            ...this.transports.values(),
            ...this.pendingTransports.values(),
        ];
        const servers = Array.from(this.servers.values());
        for (const sessionId of Array.from(this.idleTimers.keys())) {
            this.clearIdleTimer(sessionId);
        }
        // Clear the maps before closing so the onclose handlers triggered by
        // transport.close() do not attempt to close anything a second time.
        this.transports.clear();
        this.pendingTransports.clear();
        this.servers.clear();

        await Promise.all(transports.map((transport) =>
            transport.close().catch((error) => {
                logger.error(`Error closing transport: ${error instanceof Error ? error.message : String(error)}`);
            })
        ));
        await Promise.all(servers.map((server) =>
            server.close().catch((error) => {
                logger.error(`Error closing session server: ${error instanceof Error ? error.message : String(error)}`);
            })
        ));
    }

    private async handlePost(req: Request, res: Response): Promise<void> {
        logger.info(`Request received: ${req.method} ${req.url}`);
        const parsed = this.readSessionId(req);

        try {
            if (parsed.status === 'invalid') {
                this.sendInvalidSession(res);
                return;
            }

            if (parsed.status === 'ok') {
                const transport = this.transports.get(parsed.sessionId);
                if (!transport) {
                    this.sendInvalidSession(res);
                    return;
                }
                // Refresh before and after so a slow in-flight request cannot be
                // reclaimed by a timer left over from the previous request.
                this.touchSession(parsed.sessionId);
                await transport.handleRequest(req, res, req.body);
                this.touchSession(parsed.sessionId);
                return;
            }

            if (isInitializeRequest(req.body)) {
                await this.createSession(req, res);
                return;
            }

            this.sendInvalidSession(res);
        } catch (error) {
            logger.error(`Error handling MCP request: ${error instanceof Error ? error.message : String(error)}`);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32603,
                        message: 'Internal server error',
                    },
                    id: null,
                });
            }
        }
    }

    private sendInvalidSession(res: Response): void {
        res.status(400).json({
            jsonrpc: '2.0',
            error: {
                code: -32000,
                message: 'Bad Request: No valid session ID provided',
            },
            id: null,
        });
    }

    private async handleSessionRequest(req: Request, res: Response): Promise<void> {
        const parsed = this.readSessionId(req);
        const transport = parsed.status === 'ok' ? this.transports.get(parsed.sessionId) : undefined;

        if (!transport) {
            this.sendInvalidSession(res);
            return;
        }

        try {
            if (parsed.status === 'ok') {
                this.touchSession(parsed.sessionId);
            }
            await transport.handleRequest(req as IncomingMessage, res);
            if (parsed.status === 'ok') {
                this.touchSession(parsed.sessionId);
            }
        } catch (error) {
            logger.error(`Error handling MCP session request: ${error instanceof Error ? error.message : String(error)}`);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32603,
                        message: 'Internal server error',
                    },
                    id: null,
                });
            }
        }
    }

    private setupCors(): void {
        // Reflect loopback origins on every /mcp response (not only OPTIONS), so
        // a real browser-style request can read the response. Origins are never
        // wildcarded: this server has no authentication, so a wildcard would let
        // any site the user visits drive it. Non-browser clients (for example
        // mcp-remote) send no Origin header and are unaffected.
        this.app.use('/mcp', (req, res, next) => {
            const origin = req.headers.origin;
            if (origin && isLoopbackOrigin(origin)) {
                res.setHeader('Access-Control-Allow-Origin', origin);
                // A browser client must be able to read the session id back.
                res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
            }
            // Always vary on Origin so shared caches never reuse a response
            // across origins, whether or not one was approved.
            res.setHeader('Vary', 'Origin');
            next();
        });
    }

    private setupRoutes(): void {
        // Handle POST requests for client-to-server communication
        this.app.post('/mcp', (req, res) => this.handlePost(req, res));

        // Handle GET requests (SSE stream) and DELETE (session termination) for an
        // existing session. These are handled by the transport bound to that session.
        this.app.get('/mcp', (req, res) => this.handleSessionRequest(req, res));
        this.app.delete('/mcp', (req, res) => this.handleSessionRequest(req, res));

        // Handle OPTIONS preflight requests for CORS. The reflected origin and
        // Vary header are added by the CORS middleware above.
        this.app.options('/mcp', (req, res) => {
            const origin = req.headers.origin;
            if (origin && isLoopbackOrigin(origin)) {
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version');
            }
            res.status(204).end();
        });
    }

    private setupEventHandlers(): void {
        // Log HTTP server events
        if (this.httpServer) {
            this.httpServer.on('error', (error: Error) => {
                logger.error(`[Server] HTTP Server Error: ${error.message}`);
            });

            this.httpServer.on('listening', () => {
                logger.info(`[Server] HTTP Server ready`);
            });

            this.httpServer.on('close', () => {
                logger.info(`[Server] HTTP Server closed`);
            });
        }
    }

    /**
     * The server has no authentication, so binding to a non-loopback interface
     * would expose VS Code's filesystem, edit and shell tools to the network.
     * Refuse to start in that configuration.
     */
    private requireLoopbackHost(): void {
        const hostForUrl = this.host.includes(':') && !this.host.startsWith('[') ? `[${this.host}]` : this.host;
        if (isLoopbackOrigin(`http://${hostForUrl}`)) {
            return;
        }
        throw new Error(
            `Refusing to bind the MCP server to non-loopback host "${this.host}". ` +
            `The server has no authentication and exposes shell and file access; ` +
            `use 127.0.0.1 (default) or localhost.`
        );
    }

    public async start(): Promise<void> {
        try {
            logger.info('[MCPServer.start] Starting MCP server');
            const startTime = Date.now();

            // A fresh start begins a new lifecycle, so a completed stop() must
            // not make a later stop() await the old shutdown.
            this.stopPromise = undefined;
            this.logToolConfiguration();

            this.requireLoopbackHost();

            // Start HTTP server. Transports are created per session on demand.
            logger.info('[MCPServer.start] Starting HTTP server');
            const httpServerStartTime = Date.now();
            
            return new Promise((resolve) => {
                // Bind to localhost only for security
                this.httpServer = this.app.listen(this.port, this.host, () => {
                    const httpStartTime = Date.now() - httpServerStartTime;
                    logger.info(`[MCPServer.start] HTTP Server started (took ${httpStartTime}ms)`);
                    logger.info(`MCP Server listening on ${this.host}:${this.port}`);
                    
                    const totalTime = Date.now() - startTime;
                    logger.info(`[MCPServer.start] Server startup complete (total: ${totalTime}ms)`);
                    
                    resolve();
                });
            });
        } catch (error) {
            logger.error(`[MCPServer.start] Failed to start MCP Server: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    public async stop(forceTimeout: number = 5000): Promise<void> {
        // Idempotent and concurrency-safe: the first caller starts the shutdown,
        // every later caller (concurrent or sequential) awaits the same promise.
        if (this.stopPromise) {
            logger.info('[MCPServer.stop] Shutdown already in progress or complete; awaiting it');
            return this.stopPromise;
        }
        this.stopPromise = this.performStop(forceTimeout);
        return this.stopPromise;
    }

    private async performStop(forceTimeout: number): Promise<void> {
        logger.info('[MCPServer.stop] Starting server shutdown process');
        const stopStartTime = Date.now();

        try {
            // Close HTTP server with timeout
            if (this.httpServer) {
                logger.info('[MCPServer.stop] Closing HTTP server (with timeout)');
                const httpServerCloseStart = Date.now();
                const httpServer = this.httpServer;
                this.httpServer = undefined;
                
                await Promise.race([
                    // Normal close operation
                    new Promise<void>((resolve, reject) => {
                        httpServer.close((err) => {
                            const httpCloseTime = Date.now() - httpServerCloseStart;
                            if (err) {
                                logger.error(`[MCPServer.stop] HTTP server closed with error: ${err.message} (took ${httpCloseTime}ms)`);
                                reject(err);
                            } else {
                                logger.info(`[MCPServer.stop] HTTP server closed successfully (took ${httpCloseTime}ms)`);
                                resolve();
                            }
                        });
                    }),
                    
                    // Timeout fallback
                    new Promise<void>((resolve) => {
                        setTimeout(() => {
                            logger.warn(`[MCPServer.stop] HTTP server close timed out after ${forceTimeout}ms - forcing close`);
                            // We resolve anyway to continue with the shutdown process
                            resolve();
                        }, forceTimeout);
                    })
                ]);
            }

            logger.info('[MCPServer.stop] Closing MCP sessions');
            const serverCloseStart = Date.now();
            await this.closeAllTransports();
            const serverCloseTime = Date.now() - serverCloseStart;
            logger.info(`[MCPServer.stop] MCP sessions closed (took ${serverCloseTime}ms)`);
            
            const totalStopTime = Date.now() - stopStartTime;
            logger.info(`[MCPServer.stop] MCP Server shutdown complete (total: ${totalStopTime}ms)`);
        } catch (error) {
            logger.error(`[MCPServer.stop] Error during server shutdown: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
}