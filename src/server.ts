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
    // share either.
    private transports: Map<string, StreamableHTTPServerTransport> = new Map();
    private pendingTransports: Set<StreamableHTTPServerTransport> = new Set();
    private servers: Map<string, McpServer> = new Map();
    private isClosing: boolean = false;

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

    constructor(port: number = 3000, host: string = '127.0.0.1', terminal?: vscode.Terminal, toolConfig?: ToolConfiguration) {
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
        this.app = express();
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
    public setupTools(): void {
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
     * Creates a fresh transport and its server for a new MCP session. The
     * transport is tracked immediately (before it has a session id) and moved to
     * its session id once initialization assigns one.
     */
    private async createSession(req: Request, res: Response): Promise<void> {
        const server = this.createServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (sessionId: string) => {
                this.pendingTransports.delete(transport);
                this.transports.set(sessionId, transport);
                this.servers.set(sessionId, server);
            },
        });
        // Track while pending so it is always reachable for cleanup.
        this.pendingTransports.add(transport);

        transport.onclose = () => {
            this.pendingTransports.delete(transport);
            const sessionId = transport.sessionId;
            if (sessionId) {
                this.transports.delete(sessionId);
                const sessionServer = this.servers.get(sessionId);
                this.servers.delete(sessionId);
                sessionServer?.close().catch((error) => {
                    logger.error(`Error closing session server: ${error instanceof Error ? error.message : String(error)}`);
                });
            }
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    }

    private async closeAllTransports(): Promise<void> {
        const allTransports = [
            ...this.transports.values(),
            ...this.pendingTransports.values(),
        ];
        const closing = allTransports.map((transport) =>
            transport.close().catch((error) => {
                logger.error(`Error closing transport: ${error instanceof Error ? error.message : String(error)}`);
            })
        );
        await Promise.all(closing);
        this.transports.clear();
        this.pendingTransports.clear();

        const closingServers = Array.from(this.servers.values()).map((server) =>
            server.close().catch((error) => {
                logger.error(`Error closing session server: ${error instanceof Error ? error.message : String(error)}`);
            })
        );
        await Promise.all(closingServers);
        this.servers.clear();
    }

    private async handlePost(req: Request, res: Response): Promise<void> {
        logger.info(`Request received: ${req.method} ${req.url}`);
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        try {
            if (sessionId) {
                const transport = this.transports.get(sessionId);
                if (!transport) {
                    res.status(400).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32000,
                            message: 'Bad Request: No valid session ID provided',
                        },
                        id: null,
                    });
                    return;
                }
                await transport.handleRequest(req, res, req.body);
                return;
            }

            if (isInitializeRequest(req.body)) {
                await this.createSession(req, res);
                return;
            }

            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided',
                },
                id: null,
            });
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

    private async handleSessionRequest(req: Request, res: Response): Promise<void> {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const transport = sessionId ? this.transports.get(sessionId) : undefined;

        if (!transport) {
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided',
                },
                id: null,
            });
            return;
        }

        try {
            await transport.handleRequest(req as IncomingMessage, res);
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

    private setupRoutes(): void {
        // Handle POST requests for client-to-server communication
        this.app.post('/mcp', (req, res) => this.handlePost(req, res));

        // Handle GET requests (SSE stream) and DELETE (session termination) for an
        // existing session. These are handled by the transport bound to that session.
        this.app.get('/mcp', (req, res) => this.handleSessionRequest(req, res));
        this.app.delete('/mcp', (req, res) => this.handleSessionRequest(req, res));

        // Handle OPTIONS requests for CORS. Only loopback origins are reflected,
        // so an arbitrary web page cannot drive this server cross-origin. The
        // server has no authentication, so a wildcard origin would let any site
        // the user visits invoke its tools.
        this.app.options('/mcp', (req, res) => {
            const origin = req.headers.origin;
            if (origin && isLoopbackOrigin(origin)) {
                res.setHeader('Access-Control-Allow-Origin', origin);
                res.setHeader('Vary', 'Origin');
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
        logger.info('[MCPServer.stop] Starting server shutdown process');
        const stopStartTime = Date.now();

        if (this.isClosing) {
            logger.warn('[MCPServer.stop] Shutdown already in progress');
            return;
        }
        this.isClosing = true;

        try {
            // Close HTTP server with timeout
            if (this.httpServer) {
                logger.info('[MCPServer.stop] Closing HTTP server (with timeout)');
                const httpServerCloseStart = Date.now();
                
                await Promise.race([
                    // Normal close operation
                    new Promise<void>((resolve, reject) => {
                        this.httpServer!.close((err) => {
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
        } finally {
            this.isClosing = false;
        }
    }
}