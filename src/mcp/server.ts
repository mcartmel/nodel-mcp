import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getSupportedElicitationModes } from "@modelcontextprotocol/sdk/client/index.js";
import { InitializeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { createServer, type Server as NodeHttpServer } from "node:http";
import type { Socket } from "node:net";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import { NodelClient } from "../nodel/client.js";
import { getRequestContext, requestIdFromHeader, runWithRequestContext } from "../shared/requestContext.js";
import { timingSafeStringEqual } from "../shared/secret.js";
import { sanitizeSensitiveMessage } from "../shared/publicErrors.js";
import { stateStore, type StateStore } from "../state/store.js";
import { registerWorkflowPrompts } from "./prompts.js";
import { collectToolSpecs } from "./registry/toolRegistry.js";
import { StableMcpServer } from "./sdkBoundary.js";
import type { ElicitInput } from "./tools/approvals.js";
import packageJson from "../../package.json" with { type: "json" };

type ActiveMcpRequest = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  closing?: Promise<void>;
  forcedClosing?: Promise<void>;
  cleanup?: () => void;
};

type StatefulMcpSession = ActiveMcpRequest & {
  lastActivity: number;
};

export const MAX_STATEFUL_MCP_SESSIONS = 32;
export const STATEFUL_MCP_SESSION_IDLE_MS = 10 * 60 * 1000;

export type HttpAppOptions = {
  nodelClient?: NodelClient;
  nodelClientFactory?: (config: AppConfig) => NodelClient;
  /** Test seam for exercising bounded shutdown when graceful close cannot finish. */
  closeActiveMcpRequest?: (close: () => Promise<void>) => Promise<void>;
  /** Bounded session seams for HTTP integration tests. */
  maxStatefulMcpSessions?: number;
  statefulMcpSessionIdleMs?: number;
};

export type HttpAppRuntime = {
  app: express.Express;
  config: AppConfig;
  nodelClient: NodelClient;
  activeMcpRequests: ReadonlySet<ActiveMcpRequest>;
  closeActiveMcpRequests(): Promise<void>;
};

export type HttpServerRuntime = NodeHttpServer & {
  runtime: HttpAppRuntime;
  shutdown(): Promise<{ forced: boolean }>;
};

function createMcpServer(config: AppConfig, nodelClient: NodelClient) {
  const server = new StableMcpServer({ name: "nodel-ai", version: packageJson.version });
  registerWorkflowPrompts(server, config);
  const elicitInput: ElicitInput = server.server.elicitInput.bind(server.server);
  for (const spec of collectToolSpecs(config, nodelClient, elicitInput)) {
    server.registerTool(
      spec.name,
      spec.definition as Parameters<McpServer["registerTool"]>[1],
      spec.handler as Parameters<McpServer["registerTool"]>[2],
    );
  }
  return server;
}

function requestId(req: Request) {
  return getRequestContext()?.requestId ?? resLocalsRequestId(req) ?? "unknown";
}

function resLocalsRequestId(req: Request) {
  return (req.res?.locals as { requestId?: string } | undefined)?.requestId;
}

function errorBody(req: Request, error: string) {
  return { error, requestId: requestId(req) };
}

function sendError(req: Request, res: Response, status: number, error: string) {
  res.status(status).json(errorBody(req, error));
}

/** Enforces a strict Bearer scheme without exposing supplied credentials. */
export function requireBearerToken(config: Pick<AppConfig, "mcpToken">) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.mcpToken) return next();
    const expected = `Bearer ${config.mcpToken}`;
    if (!timingSafeStringEqual(req.header("authorization") ?? "", expected)) {
      logger.warn("HTTP request unauthorized");
      sendError(req, res, 401, "unauthorized");
      return;
    }
    next();
  };
}

/** Origin is an exact, configured browser boundary; non-browser clients omit it. */
export function requireAllowedOrigin(config: Pick<AppConfig, "allowedOrigins">) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.header("origin");
    if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
      logger.warn("HTTP request origin rejected");
      sendError(req, res, 403, "origin_forbidden");
      return;
    }
    next();
  };
}

function requireJsonContentType(req: Request, res: Response, next: NextFunction) {
  if (!req.is("application/json")) {
    logger.warn("HTTP request content type rejected");
    sendError(req, res, 415, "unsupported_media_type");
    return;
  }
  next();
}

/** Schema parsing prevents malformed initialization envelopes from influencing HTTP session routing. */
function normalizeInitializeRequest(body: unknown) {
  const parsed = InitializeRequestSchema.safeParse(body);
  if (!parsed.success) return { body, supportsFormMode: false };
  const elicitation = parsed.data.params.capabilities.elicitation;
  const supportsFormMode = getSupportedElicitationModes(elicitation).supportsFormMode;
  // The SDK recognizes legacy empty elicitation capability on clients but its server
  // requires the normalized form marker before issuing elicitation/create.
  if (!supportsFormMode || !elicitation || elicitation.form !== undefined) return { body, supportsFormMode };
  return {
    body: {
      ...(body as Record<string, unknown>),
      params: {
        ...(parsed.data.params as Record<string, unknown>),
        capabilities: { ...parsed.data.params.capabilities, elicitation: { ...elicitation, form: {} } },
      },
    },
    supportsFormMode,
  };
}

function requestContext(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = requestIdFromHeader(req.header("x-request-id"), config.trustInboundRequestId);
    res.locals.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    runWithRequestContext(requestId, next);
  };
}

function jsonErrorHandler(error: unknown, req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(error);
  const type = (error as { type?: unknown }).type;
  if (type === "entity.too.large") {
    logger.warn("HTTP request body too large");
    return sendError(req, res, 413, "request_too_large");
  }
  if (type === "entity.parse.failed") {
    logger.warn("HTTP request JSON parsing failed");
    return sendError(req, res, 400, "invalid_json");
  }
  logger.error("HTTP request failed", { error: sanitizeSensitiveMessage(error) });
  return sendError(req, res, 400, "invalid_request");
}

function closeActiveRequest(
  active: Set<ActiveMcpRequest>,
  entry: ActiveMcpRequest,
  closeSeam?: HttpAppOptions["closeActiveMcpRequest"],
  force = false,
) {
  const close = () =>
    Promise.allSettled([
      Promise.resolve().then(() => entry.transport.close()),
      Promise.resolve().then(() => entry.server.close()),
    ])
      .then(() => undefined)
      .finally(() => {
        active.delete(entry);
        entry.cleanup?.();
      });
  if (force && entry.closing) return (entry.forcedClosing ??= close());
  if (entry.closing) return entry.closing;
  entry.closing = force || !closeSeam ? close() : Promise.resolve().then(() => closeSeam(close));
  return entry.closing;
}

/**
 * Builds an unbound HTTP app. Tests can inject a fake Nodel facade and bind it
 * to an ephemeral port without acquiring the production state-directory lock.
 */
export function createHttpApp(config: AppConfig, options: HttpAppOptions = {}): HttpAppRuntime {
  const app = express();
  const nodelClient = options.nodelClient ?? options.nodelClientFactory?.(config) ?? new NodelClient(config);
  const active = new Set<ActiveMcpRequest>();
  const sessions = new Map<string, StatefulMcpSession>();
  const maxStatefulSessions = options.maxStatefulMcpSessions ?? MAX_STATEFUL_MCP_SESSIONS;
  const statefulSessionIdleMs = options.statefulMcpSessionIdleMs ?? STATEFUL_MCP_SESSION_IDLE_MS;
  let reservedStatefulSessions = 0;
  let sessionExpiryTimer: NodeJS.Timeout | undefined;

  const scheduleSessionExpiry = () => {
    if (sessionExpiryTimer) clearTimeout(sessionExpiryTimer);
    if (sessions.size === 0) return;
    sessionExpiryTimer = setTimeout(() => {
      sessionExpiryTimer = undefined;
      pruneExpiredSessions();
      scheduleSessionExpiry();
    }, statefulSessionIdleMs);
    sessionExpiryTimer.unref();
  };
  const closeSession = (session: StatefulMcpSession) => {
    for (const [id, current] of sessions) if (current === session) sessions.delete(id);
    void closeActiveRequest(active, session, options.closeActiveMcpRequest);
  };
  const pruneExpiredSessions = () => {
    const expiredAt = Date.now() - statefulSessionIdleMs;
    for (const session of sessions.values()) if (session.lastActivity <= expiredAt) closeSession(session);
  };
  const handleStatefulSession = async (session: StatefulMcpSession, req: Request, res: Response, body?: unknown) => {
    session.lastActivity = Date.now();
    // Streamable HTTP correlates concurrent requests by JSON-RPC request ID. Serializing
    // them deadlocks elicitation because the client response arrives while tools/call waits.
    await session.transport.handleRequest(req, res, body);
    session.lastActivity = Date.now();
  };

  app.disable("x-powered-by");
  app.use(requestContext(config));

  app.get("/healthz", (_req, res) => {
    // Liveness is deliberately independent of Nodel and configuration state.
    res.status(200).json({ ok: true, version: packageJson.version });
  });

  app.get("/readyz", requireBearerToken(config), requireAllowedOrigin(config), async (req, res) => {
    try {
      await nodelClient.getHostStatus();
      res.status(200).json({ ok: true, requestId: requestId(req) });
    } catch (error) {
      logger.warn("Nodel readiness check failed", { error: sanitizeSensitiveMessage(error) });
      res.status(503).json({ ok: false, error: "nodel_unavailable", requestId: requestId(req) });
    }
  });

  app.post(
    "/mcp",
    requireBearerToken(config),
    requireAllowedOrigin(config),
    requireJsonContentType,
    express.json({ limit: config.requestBodyLimitBytes, strict: true }),
    async (req, res) => {
      pruneExpiredSessions();
      scheduleSessionExpiry();
      const sessionId = req.header("mcp-session-id");
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !session) return sendError(req, res, 404, "session_not_found");
      if (session) {
        try {
          await handleStatefulSession(session, req, res, req.body);
        } catch (error) {
          logger.error("MCP request failed", { error: sanitizeSensitiveMessage(error) });
          if (!res.headersSent) sendError(req, res, 500, "mcp_request_failed");
        }
        return;
      }

      const initialization = normalizeInitializeRequest(req.body);
      const retainsClientCapabilities =
        config.writesEnabled && config.writeApprovalRequired && initialization.supportsFormMode;
      if (retainsClientCapabilities && sessions.size + reservedStatefulSessions >= maxStatefulSessions)
        return sendError(req, res, 503, "session_capacity_reached");
      if (retainsClientCapabilities) reservedStatefulSessions += 1;
      const server = createMcpServer(config, nodelClient);
      const sessionPublisher: { publish?: (sessionId: string) => void } = {};
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: retainsClientCapabilities ? randomUUID : undefined,
        onsessioninitialized: retainsClientCapabilities
          ? (sessionId) => sessionPublisher.publish?.(sessionId)
          : undefined,
      });
      const activeEntry: ActiveMcpRequest = {
        server,
        transport,
        cleanup: () => {
          if (retainsClientCapabilities && reservedStatefulSessions > 0 && !transport.sessionId)
            reservedStatefulSessions -= 1;
          const sessionId = transport.sessionId;
          if (sessionId && sessions.get(sessionId) === activeEntry) sessions.delete(sessionId);
          scheduleSessionExpiry();
        },
      };
      sessionPublisher.publish = (sessionId) => {
        const session = activeEntry as StatefulMcpSession;
        reservedStatefulSessions -= 1;
        session.lastActivity = Date.now();
        sessions.set(sessionId, session);
        scheduleSessionExpiry();
      };
      if (retainsClientCapabilities) Object.assign(activeEntry, { lastActivity: Date.now() });
      active.add(activeEntry);
      if (retainsClientCapabilities) {
        transport.onclose = () => {
          if (!activeEntry.closing) void closeActiveRequest(active, activeEntry);
        };
      } else {
        res.once("close", () => {
          void closeActiveRequest(active, activeEntry);
        });
      }
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, initialization.body);
      } catch (error) {
        logger.error("MCP request failed", { error: sanitizeSensitiveMessage(error) });
        if (!res.headersSent) sendError(req, res, 500, "mcp_request_failed");
      } finally {
        // Stateless transports complete with their response; close also covers aborted requests.
        if (!retainsClientCapabilities && res.writableEnded) void closeActiveRequest(active, activeEntry);
        if (retainsClientCapabilities && !transport.sessionId) void closeActiveRequest(active, activeEntry);
      }
    },
  );

  app.get("/mcp", requireBearerToken(config), requireAllowedOrigin(config), async (req, res) => {
    pruneExpiredSessions();
    scheduleSessionExpiry();
    const sessionId = req.header("mcp-session-id");
    if (!sessionId) return sendError(req, res, 405, "method_not_allowed");
    const session = sessions.get(sessionId);
    if (!session) return sendError(req, res, 404, "session_not_found");
    try {
      await handleStatefulSession(session, req, res);
    } catch (error) {
      logger.error("MCP request failed", { error: sanitizeSensitiveMessage(error) });
      if (!res.headersSent) sendError(req, res, 500, "mcp_request_failed");
    }
  });
  app.delete("/mcp", requireBearerToken(config), requireAllowedOrigin(config), async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    if (!sessionId) return sendError(req, res, 400, "session_id_required");
    pruneExpiredSessions();
    scheduleSessionExpiry();
    const session = sessions.get(sessionId);
    if (!session) return sendError(req, res, 404, "session_not_found");
    try {
      await handleStatefulSession(session, req, res);
    } catch (error) {
      logger.error("MCP session termination failed", { error: sanitizeSensitiveMessage(error) });
      if (!res.headersSent) sendError(req, res, 500, "mcp_request_failed");
    }
  });
  app.use(jsonErrorHandler);

  return {
    app,
    config,
    nodelClient,
    activeMcpRequests: active,
    async closeActiveMcpRequests() {
      if (sessionExpiryTimer) clearTimeout(sessionExpiryTimer);
      await Promise.allSettled(
        [...active].map((entry) => closeActiveRequest(active, entry, options.closeActiveMcpRequest)),
      );
    },
  };
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Acquires the single-instance lock and starts listening. The returned server
 * retains the Node HTTP API and adds a bounded, idempotent shutdown method.
 */
export async function startHttpServer(
  config: AppConfig,
  options: HttpAppOptions & { store?: StateStore } = {},
): Promise<HttpServerRuntime> {
  const store = options.store ?? stateStore(config.stateDir);
  store.acquireStartupLock();
  try {
    const runtime = createHttpApp(config, options);
    const server = createServer(runtime.app) as HttpServerRuntime;
    const sockets = new Set<Socket>();
    let shutdownPromise: Promise<{ forced: boolean }> | undefined;

    server.on("connection", (socket: Socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.once("listening", () => {
      logger.info("Nodel MCP sidecar listening", {
        bindAddress: config.mcpBindAddress,
        port: config.mcpPort,
        tokenConfigured: Boolean(config.mcpToken),
        writesEnabled: config.writesEnabled,
        nodeLifecycleEnabled: config.nodeLifecycleEnabled,
        deletesEnabled: config.deletesEnabled,
      });
    });
    server.once("close", () => store.close());

    server.runtime = runtime;
    server.shutdown = () =>
      (shutdownPromise ??= (async () => {
        let closeError: Error | undefined;
        const listeningClosed = new Promise<void>((resolve) => {
          try {
            server.close((error) => {
              if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") closeError = error;
              resolve();
            });
          } catch (error) {
            closeError = error as Error;
            resolve();
          }
        });
        const completed = await Promise.race([
          Promise.all([listeningClosed, runtime.closeActiveMcpRequests()]).then(() => true),
          wait(config.shutdownTimeoutMs).then(() => false),
        ]);
        if (!completed) {
          logger.warn("HTTP shutdown timed out; force-closing remaining sockets", {
            activeMcpRequests: runtime.activeMcpRequests.size,
            socketCount: sockets.size,
          });
          for (const socket of sockets) socket.destroy();
          void Promise.allSettled(
            [...runtime.activeMcpRequests].map((entry) =>
              closeActiveRequest(runtime.activeMcpRequests as Set<ActiveMcpRequest>, entry, undefined, true),
            ),
          );
        }
        store.close();
        if (closeError) logger.error("HTTP server shutdown failed", { error: sanitizeSensitiveMessage(closeError) });
        return { forced: !completed };
      })());
    await new Promise<void>((resolve, reject) => {
      const started = () => {
        server.off("error", failed);
        resolve();
      };
      const failed = (error: Error) => {
        server.off("listening", started);
        logger.error("Failed to bind Nodel MCP sidecar", { error: sanitizeSensitiveMessage(error) });
        void Promise.allSettled([
          runtime.closeActiveMcpRequests(),
          new Promise<void>((done) => server.close(() => done())),
        ]).finally(() => {
          for (const socket of sockets) socket.destroy();
          store.close();
          reject(error);
        });
      };
      server.once("listening", started);
      server.once("error", failed);
      server.listen(config.mcpPort, config.mcpBindAddress);
    });
    return server;
  } catch (error) {
    store.close();
    throw error;
  }
}
