import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import crypto from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { pool } from '../config/database';
import { asyncHandler } from '../utils/asyncHandler';
import { maskFaultDescription } from '../services/agentPrivacy';
import { computeVnDayWindow, isValidDateString, resolveFeaturedDate } from '../services/agentWindow';
import {
  FeaturedMediaSignal,
  applyVarietyGuard,
  clampFeaturedLimit,
  compareFeaturedCandidates,
  scoreOrder,
} from '../services/featuredScoring';

// ── Read-only Agent API (/api/agent/*) ──────────────────────────────────────
// Consumed exclusively by the repairhub-mcp service (ADR-0009), never by
// staff/frontend traffic. Deliberately does NOT use the staff `authenticate`
// JWT middleware — auth here is a single static header key, and every
// response field comes from an explicit allow-list projection (never a raw
// row / SELECT *). See repos/tech-docs/systems/repair-hub/api-contracts.md
// ("Agent API") and srs.md FR-17 / NFR-08 for the full contract.

const router = Router();

const UNAUTHORIZED_BODY = { success: false, data: null, error: 'Unauthorized' };
const NOT_FOUND_BODY = { success: false, data: null, error: 'Not found' };
const TOO_MANY_REQUESTS_BODY = { success: false, data: null, error: 'Too Many Requests' };

// Hashing both sides to a fixed-length digest before crypto.timingSafeEqual
// avoids both (a) the length-mismatch throw timingSafeEqual raises for
// unequal-length inputs, and (b) any length-based timing signal from a
// naive left-to-right comparison.
function constantTimeEquals(a: string, b: string): boolean {
  const aHash = crypto.createHash('sha256').update(a).digest();
  const bHash = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(aHash, bHash);
}

function isValidAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

interface AgentApiConfig {
  enabled: boolean;
  /** Trailing slash(es) stripped. Only meaningful when `enabled` is true. */
  mediaBaseUrl: string;
}

// The whole Agent API is disabled (every route returns 404, see
// authenticateAgent below) unless BOTH AGENT_API_KEY and a valid absolute
// http(s) PUBLIC_MEDIA_BASE_URL are configured. A relative media URL is
// useless to an external AI agent — the MCP server's `xem_anh` tool only
// ever fetches from the one configured absolute origin — so a missing/
// invalid PUBLIC_MEDIA_BASE_URL is treated exactly like a missing
// AGENT_API_KEY: the API is not usable, so it should not appear to exist.
// Read from process.env on every call (not cached at module load) so a
// config change followed by a process restart takes effect immediately and
// so this stays testable without module-reload gymnastics.
function checkAgentApiConfig(): AgentApiConfig {
  const key = process.env.AGENT_API_KEY;
  const rawMediaBaseUrl = process.env.PUBLIC_MEDIA_BASE_URL;

  if (!key || !rawMediaBaseUrl || !isValidAbsoluteHttpUrl(rawMediaBaseUrl)) {
    return { enabled: false, mediaBaseUrl: '' };
  }

  return { enabled: true, mediaBaseUrl: rawMediaBaseUrl.replace(/\/+$/, '') };
}

let startupWarningLogged = false;

/**
 * Logs one warning (never the key itself) at process startup if the Agent
 * API is disabled due to missing/invalid configuration. Called once from
 * src/index.ts at server boot — NOT wired into any per-request path, so it
 * never fires during tests (which never import index.ts) and never repeats
 * during the life of the process.
 */
export function logAgentApiStartupStatus(): void {
  if (startupWarningLogged) return;
  if (checkAgentApiConfig().enabled) return;
  startupWarningLogged = true;

  const reasons: string[] = [];
  if (!process.env.AGENT_API_KEY) reasons.push('AGENT_API_KEY is not set');
  if (!process.env.PUBLIC_MEDIA_BASE_URL) {
    reasons.push('PUBLIC_MEDIA_BASE_URL is not set');
  } else if (!isValidAbsoluteHttpUrl(process.env.PUBLIC_MEDIA_BASE_URL)) {
    reasons.push('PUBLIC_MEDIA_BASE_URL is not a valid absolute http(s) URL');
  }

  console.warn(
    `[agent-api] Disabled: ${reasons.join('; ')}. ` +
    'Set both to enable /api/agent/* (every route responds 404 until then).'
  );
}

// ── Client IP resolution (NFR-08.5 logging + rate limiting) ─────────────────
// In the tunnel deployment, requests arrive through `cloudflared` on
// loopback, so the socket-level address (`req.ip`) is not the real client
// IP — Cloudflare's `CF-Connecting-IP` header carries that instead. That
// header is trivially spoofable by anyone who can reach the server directly
// (bypassing the tunnel), so it is only trusted when the operator has
// explicitly confirmed all traffic is tunnel-only via `TRUST_CLOUDFLARE_IP`.
function resolveClientIp(req: Request): string {
  if (process.env.TRUST_CLOUDFLARE_IP === 'true') {
    const cfIp = req.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string' && cfIp.trim().length > 0) return cfIp.trim();
  }
  return req.ip ?? 'unknown';
}

// ── Request logging (NFR-08.5) ──────────────────────────────────────────────
type AgentOutcome = 'ok' | 'unauthorized' | 'disabled' | 'bad_request' | 'error';

// Most outcomes are inferred from the final status code; 'disabled' is the
// one ambiguous case (a config-disabled response and a legitimate "order
// not found" response are both 404), so authenticateAgent tags it
// explicitly via res.locals.agentOutcome before responding.
function resolveOutcome(res: Response): AgentOutcome {
  const explicit = res.locals.agentOutcome as AgentOutcome | undefined;
  if (explicit) return explicit;
  const status = res.statusCode;
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401) return 'unauthorized';
  if (status >= 400 && status < 500) return 'bad_request';
  return 'error';
}

// req.route is only populated once Express has matched a specific
// `router.get(...)` layer; early-exit responses (auth failure, disabled API,
// rate limited) never reach one, so this falls back to the query-string-free
// request path in that case — the parameterised form is preferred when
// available so a specific order id/code is never itself logged.
function resolveLoggedPath(req: Request): string {
  const routePath = (req as Request & { route?: { path?: string } }).route?.path;
  return typeof routePath === 'string' ? `/api/agent${routePath}` : req.path;
}

// Logs one structured line per request, written once the response finishes,
// so every outcome — success, unauthorized, disabled, rate-limited, or a
// validation/server error — is captured (NFR-08.5). Mounted before auth AND
// before rate limiting so both of those are logged too. NEVER logs the
// X-Agent-Key value or any query-string values (which can contain free
// text, e.g. an MCP-supplied date/status) — only the resolved path (see
// resolveLoggedPath), which excludes the query string entirely.
function agentRequestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  res.on('finish', () => {
    const entry = {
      ts: new Date().toISOString(),
      method: req.method,
      path: resolveLoggedPath(req),
      status: res.statusCode,
      duration_ms: Date.now() - startedAt,
      ip: resolveClientIp(req),
      outcome: resolveOutcome(res),
    };
    console.log(`[agent-api] ${JSON.stringify(entry)}`);
  });
  next();
}

router.use(agentRequestLogger);

// ── Rate limiting ────────────────────────────────────────────────────────────
// All four bounds are configurable via env (defaults match the NFR-08
// targets: 120 req/min global, 20 failed-auth attempts per 15 min) so ops
// can tune them without a code change, and so tests can use small
// windows/limits instead of waiting on real wall-clock time.
const RATE_LIMIT_WINDOW_MS = Number(process.env.AGENT_API_RATE_LIMIT_WINDOW_MS) || 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.AGENT_API_RATE_LIMIT_MAX) || 120;
const AUTH_FAIL_WINDOW_MS = Number(process.env.AGENT_API_AUTH_FAIL_WINDOW_MS) || 15 * 60 * 1000;
const AUTH_FAIL_MAX = Number(process.env.AGENT_API_AUTH_FAIL_LIMIT_MAX) || 20;

function tooManyRequestsHandler(_req: Request, res: Response): void {
  res.status(429).json(TOO_MANY_REQUESTS_BODY);
}

// Global per-IP bound on all /api/agent/* traffic, regardless of outcome.
const globalRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  limit: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false, // custom keyGenerator already normalises the IP itself
  keyGenerator: (req) => ipKeyGenerator(resolveClientIp(req)),
  handler: tooManyRequestsHandler,
});

// Stricter per-IP bound counting ONLY failed-auth (401) responses, so a
// brute-forced or leaked key is bounded independently of normal traffic —
// a burst of valid or merely-invalid (400/404) requests never counts
// against it. `skipSuccessfulRequests` + a `requestWasSuccessful` override
// is express-rate-limit's supported way to define "successful" as anything
// other than the one status this limiter cares about, per its own
// skip-counting hook (this is the library's "counter on 401s" mechanism).
const authFailureRateLimiter = rateLimit({
  windowMs: AUTH_FAIL_WINDOW_MS,
  limit: AUTH_FAIL_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  keyGenerator: (req) => ipKeyGenerator(resolveClientIp(req)),
  handler: tooManyRequestsHandler,
});

router.use(globalRateLimiter);
router.use(authFailureRateLimiter);

// Auth: `X-Agent-Key` header compared (constant-time) against AGENT_API_KEY,
// but only once checkAgentApiConfig() confirms the whole API is enabled —
// see checkAgentApiConfig for why an invalid/missing PUBLIC_MEDIA_BASE_URL
// disables the API exactly like a missing AGENT_API_KEY. Disabled -> 404
// rather than always-401, since 401 would imply "a correct key would work,"
// which is false when the server has no usable configuration at all.
function authenticateAgent(req: Request, res: Response, next: NextFunction): void {
  if (!checkAgentApiConfig().enabled) {
    res.locals.agentOutcome = 'disabled' satisfies AgentOutcome;
    res.status(404).json(NOT_FOUND_BODY);
    return;
  }

  const configuredKey = process.env.AGENT_API_KEY!;
  const providedKey = req.headers['x-agent-key'];
  if (typeof providedKey !== 'string' || !constantTimeEquals(providedKey, configuredKey)) {
    res.status(401).json(UNAUTHORIZED_BODY);
    return;
  }

  next();
}

router.use(authenticateAgent);

// ── Allow-list projection & shared helpers ──────────────────────────────────

const ALL_ORDER_STATUSES = new Set([
  'TIEP_NHAN', 'DANG_KIEM_TRA', 'BAO_GIA', 'DANG_SUA_CHUA',
  'SUA_XONG', 'DA_GIAO', 'TRA_HANG', 'HUY_TRA_MAY', 'DANG_BAO_HANH',
]);
const ALL_PRODUCT_TYPES = new Set(['SPEAKER', 'HEADPHONE', 'OTHER', 'BAO_HANH']);

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);
function mediaKindFromPath(imagePath: string): 'photo' | 'video' {
  return VIDEO_EXTENSIONS.has(path.extname(imagePath).toLowerCase()) ? 'video' : 'photo';
}

function buildMediaUrl(imagePath: string): string {
  // Safe to call unconditionally: every route handler below only runs after
  // authenticateAgent has already confirmed checkAgentApiConfig().enabled,
  // so mediaBaseUrl is always a valid, normalised absolute http(s) URL here.
  const { mediaBaseUrl } = checkAgentApiConfig();
  return `${mediaBaseUrl}/uploads/${imagePath}`;
}

interface OrderRow {
  id: string;
  order_code: string;
  product_type: string;
  device_name: string;
  fault_description: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MediaRow {
  id: string;
  order_id: string;
  image_path: string;
  image_type: 'INTAKE' | 'COMPLETION';
  uploaded_at: Date | string;
}

// Explicit allow-list projection (FR-17.4 / FR-17.7) — every field named
// here individually; never spreads a raw DB row.
function toSafeOrderSummary(row: OrderRow) {
  return {
    id: row.id,
    order_code: row.order_code,
    product_type: row.product_type,
    device_name: row.device_name,
    fault_description: maskFaultDescription(row.fault_description),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toSafeMedia(row: MediaRow) {
  return {
    id: row.id,
    kind: mediaKindFromPath(row.image_path),
    stage: row.image_type,
    url: buildMediaUrl(row.image_path),
  };
}

async function fetchMediaByOrderIds(orderIds: string[]): Promise<Map<string, MediaRow[]>> {
  const byOrder = new Map<string, MediaRow[]>();
  if (orderIds.length === 0) return byOrder;

  const result = await pool.query<MediaRow>(
    `SELECT id, order_id, image_path, image_type, uploaded_at
     FROM order_images
     WHERE order_id = ANY($1)
     ORDER BY uploaded_at ASC`,
    [orderIds]
  );
  for (const row of result.rows) {
    if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, []);
    byOrder.get(row.order_id)!.push(row);
  }
  return byOrder;
}

// Non-negative integer query param, defaulting to `def` when absent;
// returns null when present but not a valid non-negative integer, or when
// it falls outside [opts.min, opts.max] (either bound optional).
function parseIntParam(raw: unknown, def: number, opts: { min?: number; max?: number } = {}): number | null {
  if (raw === undefined) return def;
  const str = Array.isArray(raw) ? raw[0] : raw;
  if (typeof str !== 'string' || !/^\d+$/.test(str)) return null;
  const n = Number(str);
  if (opts.min !== undefined && n < opts.min) return null;
  if (opts.max !== undefined && n > opts.max) return null;
  return n;
}

// ── GET /api/agent/orders ────────────────────────────────────────────────────

router.get('/orders', asyncHandler(async (req: Request, res: Response) => {
  const { date_from, date_to, status, product_type, has_media } = req.query as Record<string, string | undefined>;

  if (date_from !== undefined && !isValidDateString(date_from)) {
    res.status(400).json({ success: false, data: null, error: 'Invalid date_from' });
    return;
  }
  if (date_to !== undefined && !isValidDateString(date_to)) {
    res.status(400).json({ success: false, data: null, error: 'Invalid date_to' });
    return;
  }
  if (status !== undefined && !ALL_ORDER_STATUSES.has(status)) {
    res.status(400).json({ success: false, data: null, error: 'Invalid status' });
    return;
  }
  if (product_type !== undefined && !ALL_PRODUCT_TYPES.has(product_type)) {
    res.status(400).json({ success: false, data: null, error: 'Invalid product_type' });
    return;
  }
  const limit = parseIntParam(req.query.limit, 20, { min: 1, max: 100 });
  if (limit === null) {
    res.status(400).json({ success: false, data: null, error: 'Invalid limit' });
    return;
  }
  const offset = parseIntParam(req.query.offset, 0, { min: 0 });
  if (offset === null) {
    res.status(400).json({ success: false, data: null, error: 'Invalid offset' });
    return;
  }

  let where = 'WHERE 1=1';
  const params: unknown[] = [];
  if (date_from !== undefined) {
    params.push(computeVnDayWindow(date_from).start);
    where += ` AND o.created_at >= $${params.length}`;
  }
  if (date_to !== undefined) {
    params.push(computeVnDayWindow(date_to).end);
    where += ` AND o.created_at < $${params.length}`;
  }
  if (status !== undefined) {
    params.push(status);
    where += ` AND o.status = $${params.length}`;
  }
  if (product_type !== undefined) {
    params.push(product_type);
    where += ` AND o.product_type = $${params.length}`;
  }
  if (has_media === 'true') {
    where += ' AND EXISTS (SELECT 1 FROM order_images oi WHERE oi.order_id = o.id)';
  }

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) FROM orders o ${where}`,
    params
  );
  const total = Number(countResult.rows[0].count);

  const dataParams = [...params, limit, offset];
  const ordersResult = await pool.query<OrderRow>(
    `SELECT o.id, o.order_code, o.product_type, o.device_name, o.fault_description,
            o.status, o.created_at, o.updated_at
     FROM orders o
     ${where}
     ORDER BY o.created_at DESC
     LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams
  );

  const mediaByOrder = await fetchMediaByOrderIds(ordersResult.rows.map((r) => r.id));
  const items = ordersResult.rows.map((row) => ({
    ...toSafeOrderSummary(row),
    media: (mediaByOrder.get(row.id) ?? []).map(toSafeMedia),
  }));

  res.json({ success: true, data: { items, total, limit, offset }, error: null });
}));

// ── GET /api/agent/orders/:idOrCode ─────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/orders/:idOrCode', asyncHandler(async (req: Request, res: Response) => {
  const { idOrCode } = req.params;
  const isUuid = UUID_RE.test(idOrCode);

  // `id` is a uuid column and `order_code` is varchar — a single $1 reused
  // for both sides of an OR can't type-unify across the two (Postgres's
  // PREPARE/EXECUTE parameter typing picks one type for $1 and fails, or
  // errors, for the other), so the id side needs an explicit ::uuid cast
  // and the value must be passed once per placeholder ($1 for the uuid
  // comparison, $2 for the text comparison — same JS value, two params).
  const orderResult = await pool.query<OrderRow>(
    isUuid
      ? `SELECT id, order_code, product_type, device_name, fault_description, status, created_at, updated_at
         FROM orders WHERE id = $1::uuid OR order_code = $2`
      : `SELECT id, order_code, product_type, device_name, fault_description, status, created_at, updated_at
         FROM orders WHERE order_code = $1`,
    isUuid ? [idOrCode, idOrCode] : [idOrCode]
  );
  const order = orderResult.rows[0];
  if (!order) {
    res.status(404).json(NOT_FOUND_BODY);
    return;
  }

  const [mediaResult, timelineResult] = await Promise.all([
    pool.query<MediaRow>(
      `SELECT id, order_id, image_path, image_type, uploaded_at
       FROM order_images WHERE order_id = $1 ORDER BY uploaded_at ASC`,
      [order.id]
    ),
    pool.query<{ old_status: string | null; new_status: string; changed_at: Date | string }>(
      `SELECT old_status, new_status, changed_at
       FROM order_status_history WHERE order_id = $1 ORDER BY changed_at ASC`,
      [order.id]
    ),
  ]);

  res.json({
    success: true,
    data: {
      ...toSafeOrderSummary(order),
      media: mediaResult.rows.map(toSafeMedia),
      status_timeline: timelineResult.rows.map((r) => ({
        old_status: r.old_status,
        new_status: r.new_status,
        changed_at: r.changed_at,
      })),
    },
    error: null,
  });
}));

// ── GET /api/agent/featured ──────────────────────────────────────────────────

interface FeaturedCandidateRow extends OrderRow {
  latest_activity: Date | string;
}

router.get('/featured', asyncHandler(async (req: Request, res: Response) => {
  const dateParam = req.query.date as string | undefined;
  const date = resolveFeaturedDate(dateParam);
  if (date === null) {
    res.status(400).json({ success: false, data: null, error: 'Invalid date' });
    return;
  }

  const limit = clampFeaturedLimit(req.query.limit);
  const { start, end } = computeVnDayWindow(date);

  const candidatesResult = await pool.query<FeaturedCandidateRow>(
    `SELECT o.id, o.order_code, o.product_type, o.device_name, o.fault_description,
            o.status, o.created_at, o.updated_at,
            GREATEST(
              CASE WHEN o.created_at >= $1 AND o.created_at < $2 THEN o.created_at ELSE '-infinity' END,
              COALESCE((
                SELECT MAX(h.changed_at) FROM order_status_history h
                WHERE h.order_id = o.id AND h.old_status IS DISTINCT FROM h.new_status
                  AND h.changed_at >= $1 AND h.changed_at < $2
              ), '-infinity'),
              COALESCE((
                SELECT MAX(oi.uploaded_at) FROM order_images oi
                WHERE oi.order_id = o.id AND oi.uploaded_at >= $1 AND oi.uploaded_at < $2
              ), '-infinity')
            ) AS latest_activity
     FROM orders o
     WHERE o.status NOT IN ('HUY_TRA_MAY', 'TRA_HANG')
       AND EXISTS (SELECT 1 FROM order_images oi WHERE oi.order_id = o.id)
       AND (
         (o.created_at >= $1 AND o.created_at < $2)
         OR EXISTS (
           SELECT 1 FROM order_status_history h
           WHERE h.order_id = o.id AND h.old_status IS DISTINCT FROM h.new_status
             AND h.changed_at >= $1 AND h.changed_at < $2
         )
         OR EXISTS (
           SELECT 1 FROM order_images oi
           WHERE oi.order_id = o.id AND oi.uploaded_at >= $1 AND oi.uploaded_at < $2
         )
       )`,
    [start, end]
  );

  const totalCandidates = candidatesResult.rows.length;
  const mediaByOrder = await fetchMediaByOrderIds(candidatesResult.rows.map((r) => r.id));

  const scored = candidatesResult.rows.map((row) => {
    const mediaRows = mediaByOrder.get(row.id) ?? [];
    const media = mediaRows.map(toSafeMedia);
    const maskedFault = maskFaultDescription(row.fault_description);
    const signals: FeaturedMediaSignal[] = media.map((m) => ({ stage: m.stage, kind: m.kind }));
    const { score, reasons } = scoreOrder({
      orderCode: row.order_code,
      status: row.status,
      maskedFaultDescription: maskedFault,
      media: signals,
    });
    return {
      id: row.id,
      order_code: row.order_code,
      product_type: row.product_type,
      device_name: row.device_name,
      fault_description: maskedFault,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      media,
      score,
      reasons,
      mediaCount: media.length,
      latestActivity: row.latest_activity,
      productType: row.product_type,
      orderCode: row.order_code,
    };
  });

  scored.sort(compareFeaturedCandidates);
  const selected = applyVarietyGuard(scored, limit);

  res.json({
    success: true,
    data: {
      date,
      window: { start: start.toISOString(), end: end.toISOString() },
      total_candidates: totalCandidates,
      orders: selected.map((o) => ({
        id: o.id,
        order_code: o.order_code,
        product_type: o.product_type,
        device_name: o.device_name,
        fault_description: o.fault_description,
        status: o.status,
        created_at: o.created_at,
        updated_at: o.updated_at,
        score: o.score,
        reasons: o.reasons,
        media: o.media,
      })),
    },
    error: null,
  });
}));

export default router;
