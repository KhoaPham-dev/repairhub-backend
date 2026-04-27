jest.mock('../../config/database', () => ({
  pool: {
    query: jest.fn(),
  },
}));

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../../config/database';
import dashboardRouter from '../../routes/dashboard';
import { errorHandler } from '../../middleware/errorHandler';

const mockQuery = pool.query as jest.Mock;
const SECRET = process.env.JWT_SECRET!;
const adminToken = jwt.sign(
  { id: 'u1', username: 'admin', role: 'ADMIN', branch_id: null },
  SECRET,
  { expiresIn: '1h' }
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/dashboard', dashboardRouter);
  app.use(errorHandler);
  return app;
}

afterEach(() => jest.resetAllMocks());

describe('GET /api/dashboard/revenue - auth', () => {
  it('returns 401 for unauthenticated request', async () => {
    const res = await request(buildApp()).get('/api/dashboard/revenue?period=week');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/dashboard/revenue?period=week', () => {
  it('returns 7 items for week period', async () => {
    // Simulate 7 rows returned by generate_series query
    const weekRows = Array.from({ length: 7 }, (_, i) => ({
      date: `2026-04-${21 + i}`,
      dow: ((1 + i) % 7).toString(), // Mon=1 .. Sun=0
      revenue: '0',
    }));
    mockQuery.mockResolvedValueOnce({ rows: weekRows });

    const res = await request(buildApp())
      .get('/api/dashboard/revenue?period=week')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(7);
    // First day of the week should be T2 (Monday DOW=1)
    expect(res.body.data[0].day).toBe('T2');
    expect(res.body.data[0]).toHaveProperty('date');
    expect(res.body.data[0]).toHaveProperty('revenue');
  });
});

describe('GET /api/dashboard/revenue?period=today', () => {
  it('returns data entry for today', async () => {
    const todayRow = {
      date: '2026-04-27',
      dow: '1', // Monday
      revenue: '150000',
    };
    mockQuery.mockResolvedValueOnce({ rows: [todayRow] });

    const res = await request(buildApp())
      .get('/api/dashboard/revenue?period=today')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].day).toBe('T2');
    expect(res.body.data[0].date).toBe('2026-04-27');
    expect(res.body.data[0].revenue).toBe(150000);
  });
});

describe('GET /api/dashboard/revenue?period=month', () => {
  it('returns items for the current month', async () => {
    // April has 30 days
    const monthRows = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-04-${String(i + 1).padStart(2, '0')}`,
      dow: String(((2 + i) % 7)), // arbitrary DOW sequence
      revenue: String(i * 10000),
    }));
    mockQuery.mockResolvedValueOnce({ rows: monthRows });

    const res = await request(buildApp())
      .get('/api/dashboard/revenue?period=month')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    // Each item should have the required shape
    for (const item of res.body.data) {
      expect(item).toHaveProperty('day');
      expect(item).toHaveProperty('date');
      expect(item).toHaveProperty('revenue');
    }
  });
});

describe('GET /api/dashboard/revenue - unknown period', () => {
  it('returns empty data array for unknown period', async () => {
    const res = await request(buildApp())
      .get('/api/dashboard/revenue?period=unknown')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
  });
});
