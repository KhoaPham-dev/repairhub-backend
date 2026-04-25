jest.mock('../../config/database', () => ({
  pool: { query: jest.fn() },
}));
jest.mock('../../utils/activityLog', () => ({
  logActivity: jest.fn().mockResolvedValue(undefined),
}));
// multer needs the uploads dir — use memoryStorage to avoid FS side effects
jest.mock('multer', () => {
  const multer = () => ({
    array: () => (req: any, res: any, next: any) => next(),
  });
  multer.diskStorage = () => ({});
  return multer;
});

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../../config/database';
import ordersRouter from '../../routes/orders';
import { errorHandler } from '../../middleware/errorHandler';
import { logActivity } from '../../utils/activityLog';

const mockQuery = pool.query as jest.Mock;
const mockLogActivity = logActivity as jest.Mock;
const SECRET = 'change-me';
const adminToken = jwt.sign({ id: 'u1', username: 'admin', role: 'ADMIN', branch_id: null }, SECRET, { expiresIn: '1h' });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/orders', ordersRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  mockLogActivity.mockResolvedValue(undefined);
});

afterEach(() => jest.resetAllMocks());

describe('GET /api/orders', () => {
  it('returns 401 without token', async () => {
    const res = await request(buildApp()).get('/api/orders');
    expect(res.status).toBe(401);
  });

  it('returns orders list with priority', async () => {
    const order = { id: 'o1', status: 'TIEP_NHAN', created_at: new Date(Date.now() - 86400000 * 2).toISOString() };
    mockQuery
      .mockResolvedValueOnce({ rows: [order] }) // orders query
      .mockResolvedValueOnce({ rows: [{ key: 'priority_low_days', value: '3' }, { key: 'priority_medium_days', value: '7' }] }); // config
    const res = await request(buildApp()).get('/api/orders').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data[0].priority).toBeDefined();
  });
});

describe('GET /api/orders/status-counts', () => {
  it('returns status counts', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'TIEP_NHAN', count: '5' }] });
    const res = await request(buildApp()).get('/api/orders/status-counts').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.TIEP_NHAN).toBe(5);
  });
});

describe('POST /api/orders', () => {
  it('returns 400 when required fields are missing', async () => {
    const res = await request(buildApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ customer_id: 'c1' });
    expect(res.status).toBe(400);
  });

  it('creates order and returns 201', async () => {
    const created = { id: 'o1', order_code: 'ORD-20260425-00001', status: 'TIEP_NHAN' };
    mockQuery
      .mockResolvedValueOnce({ rows: [created] }) // INSERT orders
      .mockResolvedValueOnce({ rows: [] }); // INSERT order_status_history
    const res = await request(buildApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customer_id: 'c1',
        branch_id: 'b1',
        product_type: 'phone',
        device_name: 'iPhone 14',
        fault_description: 'broken screen',
        quotation: 1000000,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.order_code).toMatch(/ORD-/);
  });
});

describe('GET /api/orders/:id', () => {
  it('returns 404 when order not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp()).get('/api/orders/o99').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('returns order with history and images', async () => {
    const order = { id: 'o1', status: 'TIEP_NHAN' };
    mockQuery
      .mockResolvedValueOnce({ rows: [order] })
      .mockResolvedValueOnce({ rows: [] }) // history
      .mockResolvedValueOnce({ rows: [] }); // images
    const res = await request(buildApp()).get('/api/orders/o1').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.history).toEqual([]);
    expect(res.body.data.images).toEqual([]);
  });
});

describe('PUT /api/orders/:id/status', () => {
  it('returns 404 when order not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .put('/api/orders/o99/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'DANG_SUA_CHUA' });
    expect(res.status).toBe(404);
  });

  it('returns 400 for terminal order status', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'DA_GIAO' }] });
    const res = await request(buildApp())
      .put('/api/orders/o1/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'TIEP_NHAN' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hoàn thành/);
  });

  it('returns 400 for invalid status value', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'TIEP_NHAN' }] });
    const res = await request(buildApp())
      .put('/api/orders/o1/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'INVALID_STATUS' });
    expect(res.status).toBe(400);
  });

  it('updates status successfully', async () => {
    const updated = { id: 'o1', status: 'DANG_SUA_CHUA' };
    mockQuery
      .mockResolvedValueOnce({ rows: [{ status: 'TIEP_NHAN' }] }) // current order
      .mockResolvedValueOnce({ rows: [] }) // UPDATE orders
      .mockResolvedValueOnce({ rows: [] }) // INSERT history
      .mockResolvedValueOnce({ rows: [updated] }); // SELECT updated
    const res = await request(buildApp())
      .put('/api/orders/o1/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'DANG_SUA_CHUA' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('DANG_SUA_CHUA');
  });
});
