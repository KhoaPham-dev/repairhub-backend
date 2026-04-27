const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
jest.mock('../../config/database', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
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
jest.mock('sharp', () => {
  const sharpMock = jest.fn(() => ({
    resize: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toFile: jest.fn().mockResolvedValue(undefined),
  }));
  return sharpMock;
});

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../../config/database';
import ordersRouter from '../../routes/orders';
import { errorHandler } from '../../middleware/errorHandler';
import { logActivity } from '../../utils/activityLog';

const mockQuery = pool.query as jest.Mock;
const mockConnect = pool.connect as jest.Mock;
const mockLogActivity = logActivity as jest.Mock;
const SECRET = process.env.JWT_SECRET!;
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
  // Provide a transactional client mock for bulk endpoint
  mockClientQuery.mockResolvedValue({ rows: [] });
  mockConnect.mockResolvedValue({
    query: mockClientQuery,
    release: mockClientRelease,
  });
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
  it('returns status counts (all-time, no period)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'TIEP_NHAN', count: '5' }] });
    const res = await request(buildApp()).get('/api/orders/status-counts').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.TIEP_NHAN).toBe(5);
  });

  it('returns status counts filtered by period=today', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'DA_GIAO', count: '2' }] });
    const res = await request(buildApp())
      .get('/api/orders/status-counts?period=today')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.DA_GIAO).toBe(2);
  });

  it('returns status counts filtered by period=week', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'DANG_SUA_CHUA', count: '3' }] });
    const res = await request(buildApp())
      .get('/api/orders/status-counts?period=week')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.DANG_SUA_CHUA).toBe(3);
  });

  it('returns status counts filtered by period=month', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'SUA_XONG', count: '7' }] });
    const res = await request(buildApp())
      .get('/api/orders/status-counts?period=month')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.SUA_XONG).toBe(7);
  });

  it('returns all-time counts for unknown period value', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'TIEP_NHAN', count: '10' }] });
    const res = await request(buildApp())
      .get('/api/orders/status-counts?period=yearly')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.TIEP_NHAN).toBe(10);
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
        product_type: 'SPEAKER',
        device_name: 'JBL Flip 6',
        fault_description: 'no sound',
        quotation: 500000,
        warranty_period_months: 6,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.order_code).toMatch(/ORD-/);
  });

  it('creates order with default warranty_period_months when not provided', async () => {
    const created = { id: 'o2', order_code: 'ORD-20260425-00002', status: 'TIEP_NHAN' };
    mockQuery
      .mockResolvedValueOnce({ rows: [created] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customer_id: 'c1',
        branch_id: 'b1',
        product_type: 'HEADPHONE',
        device_name: 'Sony WH-1000XM5',
        fault_description: 'battery issue',
      });
    expect(res.status).toBe(201);
    // verify warranty_period_months defaulted to 3 by checking the INSERT was called
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO orders'),
      expect.arrayContaining([3])
    );
  });
});

describe('POST /api/orders/warranty-claim', () => {
  it('returns 400 when required fields are missing', async () => {
    const res = await request(buildApp())
      .post('/api/orders/warranty-claim')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ source_order_id: 'o1' }); // missing branch_id
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Thiếu thông tin/);
  });

  it('returns 404 when source order not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // source order not found
    const res = await request(buildApp())
      .post('/api/orders/warranty-claim')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ source_order_id: 'o-nonexistent', branch_id: 'b1' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/đơn gốc/);
  });

  it('returns 409 when warranty order already exists', async () => {
    const sourceOrder = {
      id: 'o1', order_code: 'ORD-20260425-00001',
      customer_id: 'c1', device_name: 'JBL Flip 6',
      serial_imei: 'SN123', warranty_period_months: 12,
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [sourceOrder] }) // source order found
      .mockResolvedValueOnce({ rows: [{ id: 'bh1' }] }); // duplicate BH order exists
    const res = await request(buildApp())
      .post('/api/orders/warranty-claim')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ source_order_id: 'o1', branch_id: 'b1' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Bảo Hành/);
  });

  it('creates warranty claim order successfully', async () => {
    const sourceOrder = {
      id: 'o1', order_code: 'ORD-20260425-00001',
      customer_id: 'c1', device_name: 'JBL Flip 6',
      serial_imei: 'SN123', warranty_period_months: 12,
    };
    const newBhOrder = {
      id: 'bh1', order_code: 'ORD-20260425-00001-BH',
      status: 'DANG_BAO_HANH', product_type: 'BAO_HANH',
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [sourceOrder] }) // source order
      .mockResolvedValueOnce({ rows: [] })            // duplicate check — none
      .mockResolvedValueOnce({ rows: [newBhOrder] })  // INSERT BH order
      .mockResolvedValueOnce({ rows: [] });            // INSERT status history
    const res = await request(buildApp())
      .post('/api/orders/warranty-claim')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ source_order_id: 'o1', branch_id: 'b1', notes: 'Loa bị hư' });
    expect(res.status).toBe(201);
    expect(res.body.data.order_code).toBe('ORD-20260425-00001-BH');
    expect(res.body.data.status).toBe('DANG_BAO_HANH');
    expect(mockLogActivity).toHaveBeenCalledWith('u1', 'CREATE_WARRANTY_ORDER', 'order', 'bh1', { source: 'o1' });
  });
});

describe('POST /api/orders/bulk', () => {
  it('returns 400 when required fields are missing', async () => {
    const res = await request(buildApp())
      .post('/api/orders/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ customer_id: 'c1', branch_id: 'b1' }); // missing products
    expect(res.status).toBe(400);
  });

  it('returns 400 when products array is empty', async () => {
    const res = await request(buildApp())
      .post('/api/orders/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ customer_id: 'c1', branch_id: 'b1', products: [] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when a product is missing required fields', async () => {
    // client.query for BEGIN succeeds; product validation fails before any INSERT
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK
    const res = await request(buildApp())
      .post('/api/orders/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customer_id: 'c1',
        branch_id: 'b1',
        products: [{ product_type: 'SPEAKER' }], // missing device_name, fault_description
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sản phẩm/);
  });

  it('creates multiple orders and returns 201 with all created', async () => {
    const order1 = { id: 'o1', order_code: 'ORD-20260425-00001', status: 'TIEP_NHAN' };
    const order2 = { id: 'o2', order_code: 'ORD-20260425-00002', status: 'TIEP_NHAN' };
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })        // BEGIN
      .mockResolvedValueOnce({ rows: [order1] })  // INSERT order 1
      .mockResolvedValueOnce({ rows: [] })        // INSERT history 1
      .mockResolvedValueOnce({ rows: [order2] })  // INSERT order 2
      .mockResolvedValueOnce({ rows: [] })        // INSERT history 2
      .mockResolvedValueOnce({ rows: [] });       // COMMIT
    const res = await request(buildApp())
      .post('/api/orders/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customer_id: 'c1',
        branch_id: 'b1',
        products: [
          { product_type: 'SPEAKER', device_name: 'JBL Flip 6', fault_description: 'no sound', quotation: 500000 },
          { product_type: 'HEADPHONE', device_name: 'Sony WH-1000XM5', fault_description: 'battery issue', quotation: 300000 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].order_code).toBe('ORD-20260425-00001');
    expect(res.body.data[1].order_code).toBe('ORD-20260425-00002');
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it('creates single order in bulk and returns 201', async () => {
    const order = { id: 'o1', order_code: 'ORD-20260425-00001', status: 'TIEP_NHAN' };
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })       // BEGIN
      .mockResolvedValueOnce({ rows: [order] })  // INSERT order
      .mockResolvedValueOnce({ rows: [] })       // INSERT history
      .mockResolvedValueOnce({ rows: [] });      // COMMIT
    const res = await request(buildApp())
      .post('/api/orders/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customer_id: 'c1',
        branch_id: 'b1',
        products: [
          { product_type: 'OTHER', device_name: 'Generic Device', fault_description: 'overheating', quotation: 200000, warranty_period_months: 6 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(1);
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

  it('rejects DANG_BAO_HANH via status update route (set only by warranty-claim)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'TIEP_NHAN' }] }); // current order
    const res = await request(buildApp())
      .put('/api/orders/o1/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'DANG_BAO_HANH' });
    expect(res.status).toBe(400);
  });

  it('uses warranty_period_months from DB when transitioning to DA_GIAO', async () => {
    const updated = { id: 'o1', status: 'DA_GIAO' };
    mockQuery
      .mockResolvedValueOnce({ rows: [{ status: 'SUA_XONG' }] })              // current order status
      .mockResolvedValueOnce({ rows: [{ warranty_period_months: 6 }] })        // fetch warranty months
      .mockResolvedValueOnce({ rows: [] })                                     // UPDATE orders
      .mockResolvedValueOnce({ rows: [] })                                     // INSERT history
      .mockResolvedValueOnce({ rows: [updated] });                             // SELECT updated
    const res = await request(buildApp())
      .put('/api/orders/o1/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'DA_GIAO' });
    expect(res.status).toBe(200);
    // New parameterized form: SQL uses INTERVAL '1 month' * $N, params include 6
    const updateCall = mockQuery.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('UPDATE orders')
    );
    expect(updateCall![0]).toContain("INTERVAL '1 month'");
    expect(updateCall![1]).toContain(6);
  });
});

describe('POST /api/orders/:id/images', () => {
  it('returns 404 when order not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // order not found
    const res = await request(buildApp())
      .post('/api/orders/o99/images')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('returns 403 when technician does not own the order', async () => {
    const techToken = jwt.sign({ id: 'u-tech', username: 'tech', role: 'TECHNICIAN', branch_id: 'b1' }, SECRET, { expiresIn: '1h' });
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: 'u-other' }] }); // order owned by someone else
    const res = await request(buildApp())
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${techToken}`);
    expect(res.status).toBe(403);
  });

  it('returns 400 when no files uploaded (admin can upload to any order)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: 'u-other' }] }); // admin bypasses ownership
    const res = await request(buildApp())
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ảnh/);
  });
});
