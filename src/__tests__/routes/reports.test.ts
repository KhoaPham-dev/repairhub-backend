jest.mock('../../config/database', () => ({
  pool: { query: jest.fn() },
}));

jest.mock('../../services/revenueReport', () => {
  const path = require('path');
  return {
    generateRevenueReport: jest.fn(),
    todayVN: jest.fn(() => new Date('2026-05-11T00:00:00Z')),
    REPORTS_DIR: path.join(process.cwd(), 'backups', 'reports'),
  };
});

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
  createReadStream: jest.fn(),
}));

jest.mock('xlsx', () => {
  const actual = jest.requireActual('xlsx');
  return {
    ...actual,
    write: jest.fn((_wb: unknown, _opts: unknown) => Buffer.from('fake-xlsx-content')),
  };
});

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import { pool } from '../../config/database';
import reportsRouter from '../../routes/reports';
import { generateRevenueReport, todayVN } from '../../services/revenueReport';
import { errorHandler } from '../../middleware/errorHandler';

const mockQuery = pool.query as jest.Mock;
const mockGenerate = generateRevenueReport as jest.Mock;
const mockTodayVN = todayVN as jest.Mock;
const mockExistsSync = fs.existsSync as jest.Mock;
const mockCreateReadStream = fs.createReadStream as jest.Mock;

const SECRET = process.env.JWT_SECRET!;
const adminToken = jwt.sign({ id: 'u1', username: 'admin', role: 'ADMIN', branch_id: null }, SECRET, { expiresIn: '1h' });
const techToken  = jwt.sign({ id: 'u2', username: 'tech',  role: 'TECHNICIAN', branch_id: null }, SECRET, { expiresIn: '1h' });

// A valid UUID for use in download tests
const VALID_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/reports', reportsRouter);
  app.use(errorHandler);
  return app;
}

afterEach(() => jest.resetAllMocks());

// Restore todayVN default implementation after each resetAllMocks so the route
// always has a callable function even when the test doesn't set it explicitly.
beforeEach(() => {
  mockTodayVN.mockImplementation(() => new Date('2026-05-11T00:00:00Z'));
});

const VALID_PARTNER_UUID = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

// ────────────────────────────────────────────────
// Auth guard tests (shared across all endpoints)
// ────────────────────────────────────────────────
describe('auth guards', () => {
  it('GET / returns 401 without token', async () => {
    const res = await request(buildApp()).get('/api/reports');
    expect(res.status).toBe(401);
  });

  it('GET / returns 403 for non-admin', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp()).get('/api/reports').set('Authorization', `Bearer ${techToken}`);
    expect(res.status).toBe(403);
  });

  it('POST /generate returns 401 without token', async () => {
    const res = await request(buildApp()).post('/api/reports/generate');
    expect(res.status).toBe(401);
  });

  it('POST /generate returns 403 for non-admin', async () => {
    const res = await request(buildApp()).post('/api/reports/generate').set('Authorization', `Bearer ${techToken}`);
    expect(res.status).toBe(403);
  });
});

// ────────────────────────────────────────────────
// GET /
// ────────────────────────────────────────────────
describe('GET /api/reports', () => {
  it('returns list of reports for admin', async () => {
    const rows = [
      { id: 'r1', period_start: '2026-04-01', period_end: '2026-04-14', generated_at: '2026-04-15T00:00:00Z', status: 'done', error: null },
    ];
    mockQuery.mockResolvedValueOnce({ rows });

    const res = await request(buildApp()).get('/api/reports').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('r1');
  });

  it('returns empty array when no reports', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp()).get('/api/reports').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

// ────────────────────────────────────────────────
// POST /generate
// ────────────────────────────────────────────────
describe('POST /api/reports/generate', () => {
  it('generates report with explicit dates and returns 201', async () => {
    const REPORT_ID = 'rr-111';
    mockGenerate.mockResolvedValueOnce(REPORT_ID);
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: REPORT_ID, period_start: '2026-04-01', period_end: '2026-04-14', generated_at: '2026-04-15T00:00:00Z', status: 'done', error: null, file_path: '/app/backups/reports/report-2026-04-01-2026-04-14-1234567890.xlsx' }],
    });

    const res = await request(buildApp())
      .post('/api/reports/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ period_start: '2026-04-01', period_end: '2026-04-14' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(REPORT_ID);
    expect(res.body.data.status).toBe('done');
    expect(mockGenerate).toHaveBeenCalledWith(
      new Date('2026-04-01'),
      new Date('2026-04-14'),
      'u1'
    );
  });

  it('defaults to last 14 days when no dates provided', async () => {
    const REPORT_ID = 'rr-222';
    mockGenerate.mockResolvedValueOnce(REPORT_ID);
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: REPORT_ID, status: 'done', period_start: '2026-04-27', period_end: '2026-05-10', generated_at: '2026-05-10T00:00:00Z', error: null, file_path: null }],
    });

    const res = await request(buildApp())
      .post('/api/reports/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(201);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    // Verify date range spans 13 days back
    const [start, end] = mockGenerate.mock.calls[0] as [Date, Date];
    const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(13);
  });

  it('generates report for this_month when period=this_month', async () => {
    const REPORT_ID = 'rr-333';
    mockGenerate.mockResolvedValueOnce(REPORT_ID);
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: REPORT_ID, status: 'done', period_start: '2026-05-01', period_end: '2026-05-11', generated_at: '2026-05-11T00:00:00Z', error: null, file_path: null }],
    });

    const res = await request(buildApp())
      .post('/api/reports/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ period: 'this_month' });

    expect(res.status).toBe(201);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const [start, end] = mockGenerate.mock.calls[0] as [Date, Date];
    // Should be from 1st of current month to today
    expect(start.getDate()).toBe(1);
    expect(start.getMonth()).toBe(4); // May (0-indexed)
    expect(start.getFullYear()).toBe(2026);
    // End should be today (mocked to May 11)
    expect(end.getDate()).toBe(11);
    expect(end.getMonth()).toBe(4);
    expect(end.getFullYear()).toBe(2026);
  });

  it('generates report for last_month when period=last_month', async () => {
    const REPORT_ID = 'rr-444';
    mockGenerate.mockResolvedValueOnce(REPORT_ID);
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: REPORT_ID, status: 'done', period_start: '2026-04-01', period_end: '2026-04-30', generated_at: '2026-05-01T00:00:00Z', error: null, file_path: null }],
    });

    const res = await request(buildApp())
      .post('/api/reports/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ period: 'last_month' });

    expect(res.status).toBe(201);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const [start, end] = mockGenerate.mock.calls[0] as [Date, Date];
    // Should be full previous month (April 1-30, given mock today is May 11)
    expect(start.getDate()).toBe(1);
    expect(start.getMonth()).toBe(3); // April (0-indexed)
    expect(start.getFullYear()).toBe(2026);
    expect(end.getDate()).toBe(30);
    expect(end.getMonth()).toBe(3);
    expect(end.getFullYear()).toBe(2026);
  });

  it('returns 400 when period_start is invalid', async () => {
    const res = await request(buildApp())
      .post('/api/reports/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ period_start: 'not-a-date', period_end: '2026-04-14' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Ngày không hợp lệ');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('returns 400 when period_end is invalid', async () => {
    const res = await request(buildApp())
      .post('/api/reports/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ period_start: '2026-04-01', period_end: 'bad-date' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Ngày không hợp lệ');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('returns 400 when period_end is before period_start', async () => {
    const res = await request(buildApp())
      .post('/api/reports/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ period_start: '2026-04-14', period_end: '2026-04-01' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Ngày kết thúc phải sau ngày bắt đầu');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('returns 400 when period_end equals period_start', async () => {
    const res = await request(buildApp())
      .post('/api/reports/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ period_start: '2026-04-01', period_end: '2026-04-01' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Ngày kết thúc phải sau ngày bắt đầu');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('returns 500 when generation fails', async () => {
    mockGenerate.mockRejectedValueOnce(new Error('disk full'));
    const res = await request(buildApp())
      .post('/api/reports/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(500);
  });
});

// ────────────────────────────────────────────────
// GET /:id/download
// ────────────────────────────────────────────────
describe('GET /api/reports/:id/download', () => {
  it('returns 404 when id is not a valid UUID', async () => {
    const res = await request(buildApp())
      .get('/api/reports/not-a-uuid/download')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 404 when report id not found in DB', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .get(`/api/reports/${VALID_UUID}/download`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when file_path is null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ file_path: null }] });
    const res = await request(buildApp())
      .get(`/api/reports/${VALID_UUID}/download`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when file does not exist on disk', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ file_path: '/app/backups/reports/report-x-1234567890.xlsx' }] });
    mockExistsSync.mockReturnValueOnce(false);
    const res = await request(buildApp())
      .get(`/api/reports/${VALID_UUID}/download`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('returns 403 when file_path resolves outside reports directory (path traversal)', async () => {
    // A path that uses traversal to escape the reports directory
    const maliciousPath = '/app/backups/reports/../../../etc/passwd';
    mockQuery.mockResolvedValueOnce({ rows: [{ file_path: maliciousPath }] });
    mockExistsSync.mockReturnValueOnce(true);

    const res = await request(buildApp())
      .get(`/api/reports/${VALID_UUID}/download`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
    expect(mockCreateReadStream).not.toHaveBeenCalled();
  });

  it('streams file with correct headers when file exists', async () => {
    const path = require('path');
    const filePath = path.join(process.cwd(), 'backups', 'reports', 'report-2026-04-01-2026-04-14-1234567890.xlsx');
    mockQuery.mockResolvedValueOnce({ rows: [{ file_path: filePath }] });
    mockExistsSync.mockReturnValueOnce(true);

    // Provide a readable stream mock that ends immediately
    const { Readable } = require('stream');
    const fakeStream = new Readable({ read() { this.push(null); } });
    mockCreateReadStream.mockReturnValueOnce(fakeStream);

    const res = await request(buildApp())
      .get(`/api/reports/${VALID_UUID}/download`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('report-2026-04-01-2026-04-14-1234567890.xlsx');
    expect(res.headers['content-type']).toContain('spreadsheetml');
  });
});

// ────────────────────────────────────────────────
// GET /partner
// ────────────────────────────────────────────────
describe('GET /api/reports/partner', () => {
  const baseQuery = `/api/reports/partner?partner_id=${VALID_PARTNER_UUID}&start=2026-04-01&end=2026-04-30`;

  it('returns 400 when partner_id is missing', async () => {
    const res = await request(buildApp())
      .get('/api/reports/partner?start=2026-04-01&end=2026-04-30')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 when start is missing', async () => {
    const res = await request(buildApp())
      .get(`/api/reports/partner?partner_id=${VALID_PARTNER_UUID}&end=2026-04-30`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 when end is missing', async () => {
    const res = await request(buildApp())
      .get(`/api/reports/partner?partner_id=${VALID_PARTNER_UUID}&start=2026-04-01`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 when partner_id is not a valid UUID', async () => {
    const res = await request(buildApp())
      .get('/api/reports/partner?partner_id=not-a-uuid&start=2026-04-01&end=2026-04-30')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 when start date is invalid', async () => {
    const res = await request(buildApp())
      .get(`/api/reports/partner?partner_id=${VALID_PARTNER_UUID}&start=not-a-date&end=2026-04-30`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 when end date is invalid', async () => {
    const res = await request(buildApp())
      .get(`/api/reports/partner?partner_id=${VALID_PARTNER_UUID}&start=2026-04-01&end=bad-date`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 when end is before start', async () => {
    const res = await request(buildApp())
      .get(`/api/reports/partner?partner_id=${VALID_PARTNER_UUID}&start=2026-04-30&end=2026-04-01`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 404 when partner does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .get(baseQuery)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('returns 404 when customer exists but is not a partner', async () => {
    // The query filters by customer_type = 'partner' so returns empty rows
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .get(baseQuery)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('returns 200 with xlsx buffer when valid request and orders exist', async () => {
    // First query: partner lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: VALID_PARTNER_UUID, name: 'Cong Ty ABC' }],
    });
    // Second query: orders
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          order_code: 'ORD-001',
          status: 'done',
          notes: 'Some note',
          created_at: '2026-04-15T10:00:00.000Z',
          device_name: 'iPhone 14',
          quotation: '500000',
        },
      ],
    });

    const res = await request(buildApp())
      .get(baseQuery)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('attachment');
    // filename uses normalized start (startNorm) and endNorm (end + 1 day for inclusive range)
    expect(res.headers['content-disposition']).toContain('partner-report-Cong-Ty-ABC-2026-04-01-2026-05-01.xlsx');
    expect(res.body).toBeTruthy();
  });

  it('returns 200 with xlsx (headers only) when no orders found', async () => {
    // First query: partner lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: VALID_PARTNER_UUID, name: 'Partner Empty' }],
    });
    // Second query: no orders
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get(baseQuery)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('attachment');
  });
});
