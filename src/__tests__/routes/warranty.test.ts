jest.mock('../../config/database', () => ({
  pool: { query: jest.fn() },
}));

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../../config/database';
import warrantyRouter from '../../routes/warranty';
import { errorHandler } from '../../middleware/errorHandler';

const mockQuery = pool.query as jest.Mock;
const SECRET = process.env.JWT_SECRET!;
const adminToken = jwt.sign({ id: 'u1', username: 'admin', role: 'ADMIN', branch_id: null }, SECRET, { expiresIn: '1h' });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/warranty', warrantyRouter);
  app.use(errorHandler);
  return app;
}

afterEach(() => jest.resetAllMocks());

describe('GET /api/warranty/search', () => {
  it('returns 401 without token', async () => {
    const res = await request(buildApp()).get('/api/warranty/search');
    expect(res.status).toBe(401);
  });

  it('returns empty array when q is missing', async () => {
    const res = await request(buildApp())
      .get('/api/warranty/search')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns warranty results for valid query', async () => {
    const row = { id: 'o1', serial_imei: 'SN123', warranty_status: 'ACTIVE' };
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    const res = await request(buildApp())
      .get('/api/warranty/search?q=SN123')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].warranty_status).toBe('ACTIVE');
  });
});
