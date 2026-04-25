jest.mock('../../config/database', () => ({
  pool: { query: jest.fn() },
}));
jest.mock('../../utils/activityLog', () => ({
  logActivity: jest.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../../config/database';
import customersRouter from '../../routes/customers';
import { errorHandler } from '../../middleware/errorHandler';
import { logActivity } from '../../utils/activityLog';

const mockQuery = pool.query as jest.Mock;
const mockLogActivity = logActivity as jest.Mock;
const SECRET = process.env.JWT_SECRET!;
const adminToken = jwt.sign({ id: 'u1', username: 'admin', role: 'ADMIN', branch_id: null }, SECRET, { expiresIn: '1h' });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/customers', customersRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  mockLogActivity.mockResolvedValue(undefined);
});

afterEach(() => jest.resetAllMocks());

describe('GET /api/customers', () => {
  it('returns 401 without token', async () => {
    const res = await request(buildApp()).get('/api/customers');
    expect(res.status).toBe(401);
  });

  it('returns list of customers', async () => {
    const row = { id: 'c1', phone: '0900000000', name: 'John' };
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    const res = await request(buildApp()).get('/api/customers').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('John');
  });
});

describe('GET /api/customers/search', () => {
  it('returns empty array when q is missing', async () => {
    const res = await request(buildApp()).get('/api/customers/search').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns search results', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c2', phone: '0911', name: 'Jane' }] });
    const res = await request(buildApp()).get('/api/customers/search?q=jane').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].name).toBe('Jane');
  });
});

describe('POST /api/customers', () => {
  it('returns 400 when phone or name is missing', async () => {
    const res = await request(buildApp())
      .post('/api/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '0900000000' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('creates a customer and returns 201', async () => {
    const created = { id: 'c3', phone: '0900000001', name: 'Alice', type: 'RETAIL' };
    mockQuery.mockResolvedValueOnce({ rows: [created] }); // INSERT
    const res = await request(buildApp())
      .post('/api/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '0900000001', name: 'Alice' });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Alice');
  });
});

describe('GET /api/customers/:id', () => {
  it('returns 404 when customer not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp()).get('/api/customers/nonexistent').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('returns customer with orders', async () => {
    const customer = { id: 'c1', phone: '0900000000', name: 'John' };
    mockQuery.mockResolvedValueOnce({ rows: [customer] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // orders query
    const res = await request(buildApp()).get('/api/customers/c1').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('John');
    expect(res.body.data.orders).toEqual([]);
  });
});

describe('PUT /api/customers/:id', () => {
  it('returns 404 when customer not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .put('/api/customers/c99')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Updated' });
    expect(res.status).toBe(404);
  });

  it('updates customer and returns updated data', async () => {
    const updated = { id: 'c1', phone: '0900000000', name: 'Updated' };
    mockQuery.mockResolvedValueOnce({ rows: [updated] });
    const res = await request(buildApp())
      .put('/api/customers/c1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Updated');
  });
});

describe('DELETE /api/customers/:id', () => {
  it('deletes customer and returns success', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // DELETE
    const res = await request(buildApp())
      .delete('/api/customers/c1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
