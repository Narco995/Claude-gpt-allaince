import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { BridgeError, type ErrorCode } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { AuthProvider, Principal } from "../extensions/index.js";
import type { BridgeService } from "../service.js";
import type { WorkflowInput } from "../core/workflow.js";
import { createMcpServer } from "./mcp.js";

const STATUS: Record<ErrorCode, number> = { validation: 400, not_found: 404, unauthorized: 401, forbidden: 403, timeout: 504, cancelled: 499, provider: 502, rate_limited: 429, invalid_state: 409, tool: 422, config: 500 };
type AuthedReq = Request & { principal?: Principal };

const handler = (fn: (req: AuthedReq, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { fn(req as AuthedReq, res).catch(next); };
const parse = <T extends z.ZodType>(schema: T, v: unknown): z.output<T> => {
  const r = schema.safeParse(v);
  if (!r.success) throw new BridgeError("validation", r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
  return r.data;
};
/** Abort downstream work when the HTTP client disconnects before the response is sent. */
const abortOnClose = (res: Response): AbortSignal => { const c = new AbortController(); res.on("close", () => { if (!res.writableFinished) c.abort(); }); return c.signal; };

export interface AppOptions { allowedOrigins: string[]; logger: Logger }

export function createApp(svc: BridgeService, auth: AuthProvider, o: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use((_req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "no-store"); next(); });

  app.get("/healthz", (_req, res) => { res.json({ status: "ok", models: svc.listModels().map((m) => m.id) }); });

  // Origin allow-list (MCP spec: guard against DNS rebinding / browser CSRF). Non-browser clients send no Origin.
  const originGuard = (req: Request, _res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && !o.allowedOrigins.includes(origin)) return next(new BridgeError("forbidden", `Origin "${origin}" is not allowed`));
    next();
  };
  const authenticate = (req: Request, _res: Response, next: NextFunction) => {
    auth.authenticate(req.headers).then((p) => {
      if (!p) return next(new BridgeError("unauthorized", "Missing or invalid bearer token"));
      (req as AuthedReq).principal = p; next();
    }, next);
  };
  const secured = [originGuard, authenticate];

  // ---------------- MCP (stateless streamable HTTP) ----------------
  app.post("/mcp", ...secured, handler(async (req, res) => {
    const server = createMcpServer(svc, req.principal?.id);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }));
  const notAllowed = (_req: Request, res: Response) => { res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null }); };
  app.get("/mcp", notAllowed); app.delete("/mcp", notAllowed);

  // ---------------- REST (thin) ----------------
  const api = express.Router();
  api.use(...secured);
  api.get("/models", handler(async (_q, res) => { res.json({ models: svc.listModels() }); }));
  api.get("/tools", handler(async (_q, res) => { res.json({ tools: svc.listTools() }); }));
  api.post("/tools/:name/call", handler(async (req, res) => {
    const args = parse(z.object({ arguments: z.record(z.string(), z.unknown()).default({}), sessionId: z.string().uuid().optional() }), req.body ?? {});
    res.json({ result: await svc.callTool(String(req.params["name"]), args.arguments, { signal: abortOnClose(res), sessionId: args.sessionId, caller: req.principal?.id }) });
  }));

  api.post("/sessions", handler(async (req, res) => {
    const b = parse(z.object({ title: z.string().max(200).optional(), metadata: z.record(z.string(), z.unknown()).optional() }), req.body ?? {});
    res.status(201).json(await svc.createSession({ ...b, owner: req.principal?.id }));
  }));
  api.get("/sessions", handler(async (_q, res) => { res.json({ sessions: (await svc.listSessions()).map(({ messages, ...s }) => ({ ...s, messageCount: messages.length })) }); }));
  api.get("/sessions/:id", handler(async (req, res) => { res.json(await svc.getSession(String(req.params["id"]))); }));
  api.delete("/sessions/:id", handler(async (req, res) => { await svc.closeSession(String(req.params["id"])); res.status(204).end(); }));

  api.post("/delegate", handler(async (req, res) => { res.json(await svc.delegate(req.body ?? {}, { signal: abortOnClose(res), owner: req.principal?.id })); }));

  api.post("/workflows", handler(async (req, res) => {
    const { wait = true, ...input } = (req.body ?? {}) as Record<string, unknown>;
    const run = await svc.runWorkflow(input as WorkflowInput, { wait: wait !== false, owner: req.principal?.id });
    res.status(wait === false ? 202 : 200).json(run);
  }));
  api.get("/workflows", handler(async (req, res) => { res.json({ workflows: svc.listWorkflows(typeof req.query["sessionId"] === "string" ? req.query["sessionId"] : undefined) }); }));
  api.get("/workflows/:id", handler(async (req, res) => { res.json(svc.getWorkflow(String(req.params["id"]))); }));
  api.post("/workflows/:id/critique", handler(async (req, res) => { res.json(await svc.submitCritique(String(req.params["id"]), req.body)); }));
  api.post("/workflows/:id/cancel", handler(async (req, res) => { res.json(await svc.cancelWorkflow(String(req.params["id"]))); }));

  api.get("/dashboard/summary", handler(async (_q, res) => { res.json(await svc.dashboardSummary()); }));
  app.use("/api", api);

  app.use((_req, _res, next) => next(new BridgeError("not_found", "Route not found")));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    const e = err instanceof BridgeError ? err
      : (err as { type?: string }).type === "entity.parse.failed" ? new BridgeError("validation", "Malformed JSON body")
      : (err as { type?: string }).type === "entity.too.large" ? new BridgeError("validation", "Request body too large")
      : new BridgeError("provider", "Internal error");
    if (STATUS[e.code] >= 500) o.logger.error("request failed", { code: e.code, error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) res.status(STATUS[e.code]).json({ error: { code: e.code, message: e.message } });
  });
  return app;
}
