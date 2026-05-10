jest.mock('../../config/database', () => ({
  pool: { query: jest.fn() },
}));

jest.mock('../../services/revenueReport', () => ({
  generateRevenueReport: jest.fn(),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
  createReadStream: jest.fn(),
}));

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import { pool } from '../../config/database';
import reportsRouter from '../../routes/reports';
import { generateRevenueReport } from '../../services/revenueReport';
import { errorHandler } from '../../middleware/errorHandler';

const mockQuery = pool.query as jest.Mock;
const mockGenerate = generateRevenueReport as jest.Mock;
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
    const filePath = '/app/backups/reports/report-2026-04-01-2026-04-14-1234567890.xlsx';
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
