import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import crypto from 'crypto';
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

// Auth: `X-Agent-Key` header compared (constant-time) against AGENT_API_KEY,
// but only once checkAgentApiConfig() confirms the whole API is enabled —
// see checkAgentApiConfig for why an invalid/missing PUBLIC_MEDIA_BASE_URL
// disables the API exactly like a missing AGENT_API_KEY. Disabled -> 404
// rather than always-401, since 401 would imply "a correct key would work,"
// which is false when the server has no usable configuration at all.
function authenticateAgent(req: Request, res: Response, next: NextFunction): void {
  if (!checkAgentApiConfig().enabled) {
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
// it exceeds `max` (when `max` is provided).
function parseIntParam(raw: unknown, def: number, max?: number): number | null {
  if (raw === undefined) return def;
  const str = Array.isArray(raw) ? raw[0] : raw;
  if (typeof str !== 'string' || !/^\d+$/.test(str)) return null;
  const n = Number(str);
  if (max !== undefined && n > max) return null;
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
  const limit = parseIntParam(req.query.limit, 20, 100);
  if (limit === null) {
    res.status(400).json({ success: false, data: null, error: 'Invalid limit' });
    return;
  }
  const offset = parseIntParam(req.query.offset, 0);
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

  const orderResult = await pool.query<OrderRow>(
    isUuid
      ? `SELECT id, order_code, product_type, device_name, fault_description, status, created_at, updated_at
         FROM orders WHERE id = $1 OR order_code = $1`
      : `SELECT id, order_code, product_type, device_name, fault_description, status, created_at, updated_at
         FROM orders WHERE order_code = $1`,
    [idOrCode]
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
