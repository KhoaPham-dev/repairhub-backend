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
const techToken = jwt.sign({ id: 'u2', username: 'tech', role: 'TECHNICIAN', branch_id: 'b1' }, SECRET, { expiresIn: '1h' });

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

  it('creates a customer and returns 201 when phone is not taken', async () => {
    const created = { id: 'c3', phone: '0900000001', name: 'Alice', type: 'RETAIL' };
    mockQuery.mockResolvedValueOnce({ rows: [] });         // duplicate pre-check — no match
    mockQuery.mockResolvedValueOnce({ rows: [created] }); // INSERT
    const res = await request(buildApp())
      .post('/api/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '0900000001', name: 'Alice' });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Alice');
    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      'SELECT id FROM customers WHERE phone = $1',
      ['0900000001']
    );
  });

  it('returns 409 with existingCustomerId when phone is already taken', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c5' }] }); // duplicate pre-check — match found
    const res = await request(buildApp())
      .post('/api/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '0900000001', name: 'Bob' });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Số điện thoại đã tồn tại');
    expect(res.body.data.existingCustomerId).toBe('c5');
    // INSERT should NOT have been called
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('trims whitespace from phone before duplicate pre-check on create', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c5' }] }); // duplicate found
    const res = await request(buildApp())
      .post('/api/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '  0900000001  ', name: 'Bob' });
    expect(res.status).toBe(409);
    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      'SELECT id FROM customers WHERE phone = $1',
      ['0900000001']
    );
  });

  it('returns 409 when a concurrent insert wins the race (unique_violation 23505)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // pre-check — no match at check time
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('duplicate key value'), { code: '23505' })); // INSERT loses the race
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c9' }] }); // recheck — existing id
    const res = await request(buildApp())
      .post('/api/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '0900000002', name: 'Bob' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Số điện thoại đã tồn tại');
    expect(res.body.data.existingCustomerId).toBe('c9');
    expect(mockQuery).toHaveBeenCalledTimes(3);
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
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE returns no rows
    const res = await request(buildApp())
      .put('/api/customers/c99')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Updated' });
    expect(res.status).toBe(404);
  });

  it('updates customer and returns updated data (no phone change)', async () => {
    const updated = { id: 'c1', phone: '0900000000', name: 'Updated' };
    mockQuery.mockResolvedValueOnce({ rows: [updated] }); // UPDATE
    const res = await request(buildApp())
      .put('/api/customers/c1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Updated');
  });

  it('updates customer phone when phone is unique', async () => {
    const updated = { id: 'c1', phone: '0911111111', name: 'John' };
    mockQuery.mockResolvedValueOnce({ rows: [] });    // uniqueness check — no duplicate
    mockQuery.mockResolvedValueOnce({ rows: [updated] }); // UPDATE
    const res = await request(buildApp())
      .put('/api/customers/c1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '0911111111', name: 'John' });
    expect(res.status).toBe(200);
    expect(res.body.data.phone).toBe('0911111111');
    // verify uniqueness check was called with trimmed phone and correct id
    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      'SELECT id FROM customers WHERE phone = $1 AND id != $2',
      ['0911111111', 'c1']
    );
  });

  it('trims whitespace from phone before uniqueness check', async () => {
    const updated = { id: 'c1', phone: '0911111111', name: 'John' };
    mockQuery.mockResolvedValueOnce({ rows: [] });    // uniqueness check — no duplicate
    mockQuery.mockResolvedValueOnce({ rows: [updated] }); // UPDATE
    const res = await request(buildApp())
      .put('/api/customers/c1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '  0911111111  ' });
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      'SELECT id FROM customers WHERE phone = $1 AND id != $2',
      ['0911111111', 'c1']
    );
  });

  it('returns 409 when phone is already used by another customer', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c2' }] }); // uniqueness check — duplicate found
    const res = await request(buildApp())
      .put('/api/customers/c1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '0999999999' });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Số điện thoại đã tồn tại');
    // UPDATE should NOT have been called
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when phone is an empty string', async () => {
    const res = await request(buildApp())
      .put('/api/customers/c1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Số điện thoại không được để trống');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 when phone is whitespace-only', async () => {
    const res = await request(buildApp())
      .put('/api/customers/c1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Số điện thoại không được để trống');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 403 when called by a non-admin user', async () => {
    const res = await request(buildApp())
      .put('/api/customers/c1')
      .set('Authorization', `Bearer ${techToken}`)
      .send({ name: 'Updated' });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
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
