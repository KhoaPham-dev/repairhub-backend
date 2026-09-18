jest.mock('../../config/database', () => ({
  pool: { query: jest.fn() },
}));

import request from 'supertest';
import express from 'express';
import agentRouter from '../../routes/agent';
import { errorHandler } from '../../middleware/errorHandler';
import { pool } from '../../config/database';

const mockQuery = pool.query as jest.Mock;
const AGENT_KEY = 'test-agent-key-123';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRouter);
  app.use(errorHandler);
  return app;
}

// Request logging (agentRequestLogger) is exercised for real on every
// request in this file (it's mounted unconditionally, before auth) — quiet
// its console.log output here since this file isn't the one asserting on
// it (see agentRequestLogging.test.ts for that).
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  (console.log as jest.Mock).mockRestore();
});

beforeEach(() => {
  process.env.AGENT_API_KEY = AGENT_KEY;
  process.env.PUBLIC_MEDIA_BASE_URL = 'https://media.example.com';
});

afterEach(() => {
  jest.resetAllMocks();
  delete process.env.AGENT_API_KEY;
  delete process.env.PUBLIC_MEDIA_BASE_URL;
});

// ── Auth ─────────────────────────────────────────────────────────────────────

describe('Agent API auth', () => {
  it('returns 401 Unauthorized (standard shape) when X-Agent-Key is missing', async () => {
    const res = await request(buildApp()).get('/api/agent/orders');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, data: null, error: 'Unauthorized' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 401 Unauthorized when X-Agent-Key is wrong', async () => {
    const res = await request(buildApp()).get('/api/agent/orders').set('X-Agent-Key', 'wrong-key');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('returns 401 for a key that only partially matches (no length/prefix leak)', async () => {
    const res = await request(buildApp())
      .get('/api/agent/orders')
      .set('X-Agent-Key', AGENT_KEY.slice(0, -1)); // one character short
    expect(res.status).toBe(401);
  });

  it('never accepts a user JWT in place of the agent key', async () => {
    const res = await request(buildApp())
      .get('/api/agent/orders')
      .set('Authorization', 'Bearer some.jwt.token');
    expect(res.status).toBe(401);
  });

  it('returns 404 on every route when AGENT_API_KEY is unset, even with a header sent', async () => {
    delete process.env.AGENT_API_KEY;
    const app = buildApp();

    const resOrders = await request(app).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
    expect(resOrders.status).toBe(404);

    const resDetail = await request(app).get('/api/agent/orders/20260918-00007').set('X-Agent-Key', AGENT_KEY);
    expect(resDetail.status).toBe(404);

    const resFeatured = await request(app).get('/api/agent/featured').set('X-Agent-Key', AGENT_KEY);
    expect(resFeatured.status).toBe(404);

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 404 (not 401) when AGENT_API_KEY is unset and no header is sent at all', async () => {
    delete process.env.AGENT_API_KEY;
    const res = await request(buildApp()).get('/api/agent/orders');
    expect(res.status).toBe(404);
  });

  it('returns 404 on every route when PUBLIC_MEDIA_BASE_URL is unset, even with a valid key', async () => {
    delete process.env.PUBLIC_MEDIA_BASE_URL;
    const app = buildApp();

    const resOrders = await request(app).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
    expect(resOrders.status).toBe(404);
    expect(resOrders.body).toEqual({ success: false, data: null, error: 'Not found' });

    const resDetail = await request(app).get('/api/agent/orders/20260918-00007').set('X-Agent-Key', AGENT_KEY);
    expect(resDetail.status).toBe(404);

    const resFeatured = await request(app).get('/api/agent/featured').set('X-Agent-Key', AGENT_KEY);
    expect(resFeatured.status).toBe(404);

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each([
    'not-a-url',
    '/uploads', // relative path — not absolute
    'ftp://media.example.com', // not http(s)
    'media.example.com', // missing scheme
  ])('returns 404 when PUBLIC_MEDIA_BASE_URL is set but not a valid absolute http(s) URL: %s', async (value) => {
    process.env.PUBLIC_MEDIA_BASE_URL = value;
    const res = await request(buildApp()).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(404);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('accepts a valid http:// (not just https://) PUBLIC_MEDIA_BASE_URL', async () => {
    process.env.PUBLIC_MEDIA_BASE_URL = 'http://media.example.com';
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }).mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp()).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(200);
  });

  it('passes through with the correct key and valid config', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }).mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp()).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(200);
  });
});

describe('Agent API — misc parsing edge cases', () => {
  it('strips a trailing slash from PUBLIC_MEDIA_BASE_URL when building media URLs', async () => {
    process.env.PUBLIC_MEDIA_BASE_URL = 'https://media.example.com/';
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'o1', order_code: '20260918-00007', product_type: 'SPEAKER', device_name: 'JBL Flip 6',
          fault_description: 'x', status: 'SUA_XONG', created_at: 'x', updated_at: 'y',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'img1', order_id: 'o1', image_path: 'abc.jpg', image_type: 'INTAKE', uploaded_at: 'x' }],
      });

    const res = await request(buildApp()).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
    expect(res.body.data.items[0].media[0].url).toBe('https://media.example.com/uploads/abc.jpg');
  });

  it('strips multiple trailing slashes from PUBLIC_MEDIA_BASE_URL', async () => {
    process.env.PUBLIC_MEDIA_BASE_URL = 'https://media.example.com///';
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'o1', order_code: '20260918-00007', product_type: 'SPEAKER', device_name: 'JBL Flip 6',
          fault_description: 'x', status: 'SUA_XONG', created_at: 'x', updated_at: 'y',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'img1', order_id: 'o1', image_path: 'abc.jpg', image_type: 'INTAKE', uploaded_at: 'x' }],
      });

    const res = await request(buildApp()).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
    expect(res.body.data.items[0].media[0].url).toBe('https://media.example.com/uploads/abc.jpg');
  });

  it('uses only the first value when a query param is repeated (array form)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }).mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .get('/api/agent/orders?limit=5&limit=10')
      .set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.limit).toBe(5);
  });
});

// ── GET /api/agent/orders — validation ──────────────────────────────────────

describe('GET /api/agent/orders — validation', () => {
  it.each([
    ['date_from=not-a-date', 'Invalid date_from'],
    ['date_to=2026-02-30', 'Invalid date_to'],
    ['status=NOT_A_STATUS', 'Invalid status'],
    ['product_type=NOT_A_TYPE', 'Invalid product_type'],
    ['limit=abc', 'Invalid limit'],
    ['limit=101', 'Invalid limit'],
    ['limit=-1', 'Invalid limit'],
    ['limit=0', 'Invalid limit'],
    ['offset=abc', 'Invalid offset'],
    ['offset=-1', 'Invalid offset'],
  ])('returns 400 for %s', async (qs, expectedError) => {
    const res = await request(buildApp()).get(`/api/agent/orders?${qs}`).set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe(expectedError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('accepts a valid status/product_type/date range/limit/offset', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }).mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .get('/api/agent/orders?date_from=2026-09-01&date_to=2026-09-18&status=SUA_XONG&product_type=SPEAKER&limit=5&offset=10')
      .set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(200);
  });

  it('accepts limit=1 (the minimum) and offset=0 (the minimum)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }).mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .get('/api/agent/orders?limit=1&offset=0')
      .set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.limit).toBe(1);
    expect(res.body.data.offset).toBe(0);
  });
});

// ── GET /api/agent/orders ────────────────────────────────────────────────────

describe('GET /api/agent/orders', () => {
  const ORDER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  it('returns items with the safe projection, masked fault_description, and media', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: ORDER_ID, order_code: '20260918-00007', product_type: 'SPEAKER', device_name: 'JBL Flip 6',
          fault_description: 'Khách gọi 0912345678', status: 'SUA_XONG',
          created_at: '2026-09-18T02:11:00Z', updated_at: '2026-09-18T09:40:00Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: 'img1', order_id: ORDER_ID, image_path: 'abc.jpg', image_type: 'INTAKE', uploaded_at: '2026-09-18T02:12:00Z' },
          { id: 'img2', order_id: ORDER_ID, image_path: 'def.mp4', image_type: 'COMPLETION', uploaded_at: '2026-09-18T09:30:00Z' },
        ],
      });

    const res = await request(buildApp()).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.limit).toBe(20);
    expect(res.body.data.offset).toBe(0);
    expect(res.body.data.items[0]).toEqual({
      id: ORDER_ID, order_code: '20260918-00007', product_type: 'SPEAKER', device_name: 'JBL Flip 6',
      fault_description: 'Khách gọi [đã ẩn]', status: 'SUA_XONG',
      created_at: '2026-09-18T02:11:00Z', updated_at: '2026-09-18T09:40:00Z',
      media: [
        { id: 'img1', kind: 'photo', stage: 'INTAKE', url: 'https://media.example.com/uploads/abc.jpg' },
        { id: 'img2', kind: 'video', stage: 'COMPLETION', url: 'https://media.example.com/uploads/def.mp4' },
      ],
    });
  });

  it('does not query for media when there are no orders in the page', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }).mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp()).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(2); // count + orders only, no media query
  });

  it('applies date_from/date_to as VN-day window boundaries, status, product_type, and has_media filters', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }).mockResolvedValueOnce({ rows: [] });
    await request(buildApp())
      .get('/api/agent/orders?date_from=2026-09-18&date_to=2026-09-18&status=SUA_XONG&product_type=SPEAKER&has_media=true')
      .set('X-Agent-Key', AGENT_KEY);

    const countCall = mockQuery.mock.calls[0];
    expect(countCall[0]).toContain('o.created_at >= $1');
    expect(countCall[0]).toContain('o.created_at < $2');
    expect(countCall[0]).toContain('o.status = $3');
    expect(countCall[0]).toContain('o.product_type = $4');
    expect(countCall[0]).toContain('EXISTS (SELECT 1 FROM order_images');
    // date_from lower bound = VN midnight of 2026-09-18 = 2026-09-17T17:00:00Z
    expect((countCall[1][0] as Date).toISOString()).toBe('2026-09-17T17:00:00.000Z');
    // date_to upper bound (exclusive) = VN midnight of 2026-09-19 = 2026-09-18T17:00:00Z
    expect((countCall[1][1] as Date).toISOString()).toBe('2026-09-18T17:00:00.000Z');
    expect(countCall[1][2]).toBe('SUA_XONG');
    expect(countCall[1][3]).toBe('SPEAKER');
  });

  it('every query is parameterised (no interpolated filter values in the SQL text)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }).mockResolvedValueOnce({ rows: [] });
    await request(buildApp())
      .get('/api/agent/orders?status=SUA_XONG&product_type=SPEAKER')
      .set('X-Agent-Key', AGENT_KEY);
    for (const call of mockQuery.mock.calls) {
      expect(call[0]).not.toContain('SUA_XONG');
      expect(call[0]).not.toContain('SPEAKER');
    }
  });
});

// ── GET /api/agent/orders/:idOrCode ─────────────────────────────────────────

describe('GET /api/agent/orders/:idOrCode', () => {
  const UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  it('looks up by order_code only when :idOrCode is not UUID-shaped', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(buildApp()).get('/api/agent/orders/20260918-00007').set('X-Agent-Key', AGENT_KEY);
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('WHERE order_code = $1');
    expect(call[0]).not.toContain('id = $1 OR');
    expect(call[1]).toEqual(['20260918-00007']);
  });

  it('looks up by id OR order_code when :idOrCode is UUID-shaped, with an explicit ::uuid cast and separate placeholders', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(buildApp()).get(`/api/agent/orders/${UUID}`).set('X-Agent-Key', AGENT_KEY);
    const call = mockQuery.mock.calls[0];
    // id is a uuid column and order_code is varchar — reusing a single $1
    // for both sides of the OR fails Postgres's PREPARE/EXECUTE parameter
    // type unification (one $N can't be both uuid and text). The uuid side
    // must have an explicit cast, and each side must get its own
    // placeholder (same JS value passed twice).
    expect(call[0]).toContain('WHERE id = $1::uuid OR order_code = $2');
    expect(call[0]).not.toContain('id = $1 OR order_code = $1');
    expect(call[1]).toEqual([UUID, UUID]);
  });

  it('returns 404 "Not found" (English, per contract) when no order matches', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp()).get('/api/agent/orders/does-not-exist').set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, data: null, error: 'Not found' });
  });

  it('returns the safe projection, media[], and a status_timeline with only old_status/new_status/changed_at', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: UUID, order_code: '20260918-00007', product_type: 'SPEAKER', device_name: 'JBL Flip 6',
          fault_description: 'Không lên nguồn', status: 'SUA_XONG',
          created_at: '2026-09-18T02:11:00Z', updated_at: '2026-09-18T09:40:00Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // media
      .mockResolvedValueOnce({
        rows: [
          { old_status: null, new_status: 'TIEP_NHAN', changed_at: '2026-09-18T02:11:00Z' },
          { old_status: 'TIEP_NHAN', new_status: 'DANG_SUA_CHUA', changed_at: '2026-09-18T05:00:00Z' },
        ],
      });

    const res = await request(buildApp()).get(`/api/agent/orders/${UUID}`).set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.status_timeline).toEqual([
      { old_status: null, new_status: 'TIEP_NHAN', changed_at: '2026-09-18T02:11:00Z' },
      { old_status: 'TIEP_NHAN', new_status: 'DANG_SUA_CHUA', changed_at: '2026-09-18T05:00:00Z' },
    ]);
    expect(res.body.data.media).toEqual([]);
    const timelineCall = mockQuery.mock.calls[2];
    expect(timelineCall[0]).not.toContain('notes');
    expect(timelineCall[0]).not.toContain('changed_by');
  });
});

// ── GET /api/agent/featured — validation ────────────────────────────────────

describe('GET /api/agent/featured — validation', () => {
  it('returns 400 for an invalid date', async () => {
    const res = await request(buildApp()).get('/api/agent/featured?date=2026-02-30').set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid date');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('clamps limit above 20 to 20 rather than rejecting', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp()).get('/api/agent/featured?limit=999').set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.orders).toEqual([]);
  });
});

// ── GET /api/agent/featured — business rules (SQL-encoded; asserted via query text) ─

describe('GET /api/agent/featured — candidate query encodes the business rules', () => {
  it('excludes HUY_TRA_MAY and TRA_HANG', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(buildApp()).get('/api/agent/featured?date=2026-09-18').set('X-Agent-Key', AGENT_KEY);
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("o.status NOT IN ('HUY_TRA_MAY', 'TRA_HANG')");
  });

  it('requires at least 1 media item', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(buildApp()).get('/api/agent/featured?date=2026-09-18').set('X-Agent-Key', AGENT_KEY);
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain('EXISTS (SELECT 1 FROM order_images oi WHERE oi.order_id = o.id)');
  });

  it('counts a real status change (old_status IS DISTINCT FROM new_status) as activity, excluding notes-only rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(buildApp()).get('/api/agent/featured?date=2026-09-18').set('X-Agent-Key', AGENT_KEY);
    const sql = mockQuery.mock.calls[0][0];
    // Every reference to order_status_history in the candidate query must
    // filter on a REAL transition — a notes-only history row (old_status =
    // new_status, e.g. from PATCH /orders/:id) must never count as activity.
    const historyReferences = sql.split('order_status_history').length - 1;
    const distinctFromCount = sql.split('old_status IS DISTINCT FROM').length - 1;
    expect(historyReferences).toBeGreaterThan(0);
    expect(distinctFromCount).toBe(historyReferences);
    expect(sql).toContain('h.old_status IS DISTINCT FROM h.new_status');
  });

  it('counts a media upload (uploaded_at in window) as activity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(buildApp()).get('/api/agent/featured?date=2026-09-18').set('X-Agent-Key', AGENT_KEY);
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain('oi.uploaded_at >= $1 AND oi.uploaded_at < $2');
  });

  it('passes the resolved VN window boundaries as the only query parameters', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(buildApp()).get('/api/agent/featured?date=2026-09-18').set('X-Agent-Key', AGENT_KEY);
    const params = mockQuery.mock.calls[0][1];
    expect(params).toHaveLength(2);
    expect((params[0] as Date).toISOString()).toBe('2026-09-17T17:00:00.000Z');
    expect((params[1] as Date).toISOString()).toBe('2026-09-18T17:00:00.000Z');
  });
});

// ── GET /api/agent/featured — response assembly ─────────────────────────────

describe('GET /api/agent/featured — response assembly', () => {
  it('returns date, window, total_candidates, and scored/sorted orders with media', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'o1', order_code: '20260918-00007', product_type: 'SPEAKER', device_name: 'JBL Flip 6',
            fault_description: 'Hỏng, gọi 0912345678', status: 'SUA_XONG',
            created_at: '2026-09-18T02:11:00Z', updated_at: '2026-09-18T09:40:00Z',
            latest_activity: '2026-09-18T09:40:00Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: 'img1', order_id: 'o1', image_path: 'abc.jpg', image_type: 'INTAKE', uploaded_at: '2026-09-18T02:12:00Z' },
          { id: 'img2', order_id: 'o1', image_path: 'def.jpg', image_type: 'COMPLETION', uploaded_at: '2026-09-18T09:30:00Z' },
        ],
      });

    const res = await request(buildApp()).get('/api/agent/featured?date=2026-09-18').set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.date).toBe('2026-09-18');
    expect(res.body.data.window).toEqual({
      start: '2026-09-17T17:00:00.000Z',
      end: '2026-09-18T17:00:00.000Z',
    });
    expect(res.body.data.total_candidates).toBe(1);
    expect(res.body.data.orders).toHaveLength(1);
    const order = res.body.data.orders[0];
    expect(order.score).toBe(3 + 2 + 2); // completion +3, both stages +2, SUA_XONG +2
    expect(order.reasons).toEqual(['Có ảnh/video sau sửa', 'Có ảnh trước & sau', 'Đã sửa xong']);
    expect(order.fault_description).toBe('Hỏng, gọi [đã ẩn]');
    expect(order.media).toHaveLength(2);
  });

  it('applies the variety guard (max 3 per product_type) without backfilling a 4th of the same type when other types fill the limit', async () => {
    // 4 SPEAKER + 4 HEADPHONE, limit exactly matches 3+3 — the capped
    // selection alone satisfies the limit, so no backfill (which would
    // otherwise re-admit a 4th SPEAKER) is needed.
    const speakers = Array.from({ length: 4 }, (_, i) => ({
      id: `s${i}`, order_code: `20260918-0000${i}`, product_type: 'SPEAKER', device_name: 'Speaker',
      fault_description: 'x', status: 'DANG_SUA_CHUA', created_at: '2026-09-18T02:00:00Z',
      updated_at: '2026-09-18T02:00:00Z', latest_activity: '2026-09-18T02:00:00Z',
    }));
    const headphones = Array.from({ length: 4 }, (_, i) => ({
      id: `h${i}`, order_code: `20260918-1000${i}`, product_type: 'HEADPHONE', device_name: 'Headphone',
      fault_description: 'x', status: 'DANG_SUA_CHUA', created_at: '2026-09-18T02:00:00Z',
      updated_at: '2026-09-18T02:00:00Z', latest_activity: '2026-09-18T02:00:00Z',
    }));
    mockQuery.mockResolvedValueOnce({ rows: [...speakers, ...headphones] }).mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp()).get('/api/agent/featured?date=2026-09-18&limit=6').set('X-Agent-Key', AGENT_KEY);
    expect(res.body.data.total_candidates).toBe(8);
    expect(res.body.data.orders).toHaveLength(6);
    const byType = res.body.data.orders.reduce((acc: Record<string, number>, o: { product_type: string }) => {
      acc[o.product_type] = (acc[o.product_type] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType).toEqual({ SPEAKER: 3, HEADPHONE: 3 });
  });

  it('sorts by score desc, then media_count desc, then latest activity desc, then order_code asc', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          // Same score (0), same media_count (1) — tie-break must be order_code asc
          {
            id: 'o-late', order_code: '20260918-00002', product_type: 'SPEAKER', device_name: 'X',
            fault_description: 'x', status: 'DANG_SUA_CHUA', created_at: '2026-09-18T02:00:00Z',
            updated_at: '2026-09-18T02:00:00Z', latest_activity: '2026-09-18T02:00:00Z',
          },
          {
            id: 'o-early', order_code: '20260918-00001', product_type: 'HEADPHONE', device_name: 'Y',
            fault_description: 'x', status: 'DANG_SUA_CHUA', created_at: '2026-09-18T02:00:00Z',
            updated_at: '2026-09-18T02:00:00Z', latest_activity: '2026-09-18T02:00:00Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: 'm1', order_id: 'o-late', image_path: 'a.jpg', image_type: 'INTAKE', uploaded_at: 'x' },
          { id: 'm2', order_id: 'o-early', image_path: 'b.jpg', image_type: 'INTAKE', uploaded_at: 'x' },
        ],
      });

    const res = await request(buildApp()).get('/api/agent/featured?date=2026-09-18').set('X-Agent-Key', AGENT_KEY);
    expect(res.body.data.orders.map((o: { order_code: string }) => o.order_code)).toEqual([
      '20260918-00001', '20260918-00002',
    ]);
  });
});

// ── No PII leaks (FR-17.11) ──────────────────────────────────────────────────

describe('No PII leaks (FR-17.11) — allow-list projection enforcement', () => {
  const SEEDED = {
    customer_name: 'Nguyễn Văn A',
    customer_phone: '0912345678',
    customer_address: '123 Đường Láng, Hà Nội',
    customer_type: 'RETAIL',
    serial_imei: 'SN-IMEI-999888',
    accessories: 'Tai nghe kèm hộp và sạc',
    created_by: 'user-uuid-1111',
    created_by_name: 'Nhân viên Bảo',
    changed_by: 'user-uuid-2222',
    changed_by_name: 'Nhân viên Chi',
    notes: 'Ghi chú nội bộ nhạy cảm',
  };
  const SEEDED_VALUES = Object.values(SEEDED);
  const EXCLUDED_FIELD_NAMES = [
    'customer_id', 'customer_name', 'customer_phone', 'customer_address', 'customer_type',
    'serial_imei', 'accessories', 'created_by', 'created_by_name', 'changed_by', 'changed_by_name', 'notes',
  ];

  function tainted(base: Record<string, unknown>) {
    return { ...base, ...SEEDED, customer_id: 'cust-uuid-3333' };
  }

  it('GET /orders response contains none of the seeded PII values or excluded field names', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({
        rows: [tainted({
          id: 'o1', order_code: '20260918-00007', product_type: 'SPEAKER', device_name: 'JBL Flip 6',
          fault_description: 'Sửa xong', status: 'SUA_XONG', created_at: 'x', updated_at: 'y',
        })],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp()).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
    const serialized = JSON.stringify(res.body);
    for (const value of SEEDED_VALUES) expect(serialized).not.toContain(value);
    for (const key of EXCLUDED_FIELD_NAMES) {
      expect(Object.keys(res.body.data.items[0])).not.toContain(key);
    }
  });

  it('GET /orders/:idOrCode response contains none of the seeded PII values or excluded field names', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [tainted({
          id: 'o1', order_code: '20260918-00007', product_type: 'SPEAKER', device_name: 'JBL Flip 6',
          fault_description: 'Sửa xong', status: 'SUA_XONG', created_at: 'x', updated_at: 'y',
        })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ old_status: null, new_status: 'TIEP_NHAN', changed_at: 'z', ...SEEDED }],
      });

    const res = await request(buildApp()).get('/api/agent/orders/20260918-00007').set('X-Agent-Key', AGENT_KEY);
    const serialized = JSON.stringify(res.body);
    for (const value of SEEDED_VALUES) expect(serialized).not.toContain(value);
    for (const key of EXCLUDED_FIELD_NAMES) {
      expect(Object.keys(res.body.data)).not.toContain(key);
      expect(Object.keys(res.body.data.status_timeline[0])).not.toContain(key);
    }
  });

  it('GET /featured response contains none of the seeded PII values or excluded field names', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [tainted({
          id: 'o1', order_code: '20260918-00007', product_type: 'SPEAKER', device_name: 'JBL Flip 6',
          fault_description: 'Sửa xong', status: 'SUA_XONG', created_at: 'x', updated_at: 'y',
          latest_activity: 'z',
        })],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'img1', order_id: 'o1', image_path: 'a.jpg', image_type: 'COMPLETION', uploaded_at: 'x' }],
      });

    const res = await request(buildApp()).get('/api/agent/featured?date=2026-09-18').set('X-Agent-Key', AGENT_KEY);
    const serialized = JSON.stringify(res.body);
    for (const value of SEEDED_VALUES) expect(serialized).not.toContain(value);
    for (const key of EXCLUDED_FIELD_NAMES) {
      expect(Object.keys(res.body.data.orders[0])).not.toContain(key);
    }
  });

  it('fault_description masks a phone number and an email seeded together', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'o1', order_code: '20260918-00007', product_type: 'SPEAKER', device_name: 'JBL Flip 6',
          fault_description: 'Gọi 0912345678 hoặc email khach@example.com', status: 'SUA_XONG',
          created_at: 'x', updated_at: 'y',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp()).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
    expect(res.body.data.items[0].fault_description).toBe('Gọi [đã ẩn] hoặc email [đã ẩn]');
    expect(JSON.stringify(res.body)).not.toContain('0912345678');
    expect(JSON.stringify(res.body)).not.toContain('khach@example.com');
  });
});
