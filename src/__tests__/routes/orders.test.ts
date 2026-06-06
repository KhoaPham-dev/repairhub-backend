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
    mockQuery.mockResolvedValueOnce({ rows: [order] });
    const res = await request(buildApp()).get('/api/orders').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data[0]).toHaveProperty('priority');
  });

  it('assigns priority=HIGH for orders 5+ days old with non-terminal status', async () => {
    const order = { id: 'o2', status: 'DANG_SUA_CHUA', created_at: new Date(Date.now() - 86400000 * 6).toISOString() };
    mockQuery.mockResolvedValueOnce({ rows: [order] });
    const res = await request(buildApp()).get('/api/orders').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].priority).toBe('HIGH');
  });

  it('assigns priority=MEDIUM for orders 3–4 days old with non-terminal status', async () => {
    const order = { id: 'o3', status: 'TIEP_NHAN', created_at: new Date(Date.now() - 86400000 * 4).toISOString() };
    mockQuery.mockResolvedValueOnce({ rows: [order] });
    const res = await request(buildApp()).get('/api/orders').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].priority).toBe('MEDIUM');
  });

  it('assigns priority=null for orders less than 3 days old', async () => {
    const order = { id: 'o4', status: 'TIEP_NHAN', created_at: new Date(Date.now() - 86400000 * 1).toISOString() };
    mockQuery.mockResolvedValueOnce({ rows: [order] });
    const res = await request(buildApp()).get('/api/orders').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].priority).toBeNull();
  });

  it('assigns priority=null for orders with terminal status regardless of age', async () => {
    const order = { id: 'o5', status: 'DA_GIAO', created_at: new Date(Date.now() - 86400000 * 10).toISOString() };
    mockQuery.mockResolvedValueOnce({ rows: [order] });
    const res = await request(buildApp()).get('/api/orders').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].priority).toBeNull();
  });

  it('search clause includes device_name match', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .get('/api/orders?search=Loa+JBL')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/o\.device_name ILIKE/);
  });

  it('exclude_status pushes a NOT IN clause with each status as a parameter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .get('/api/orders?exclude_status=DA_GIAO,HUY_TRA_MAY')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toMatch(/o\.status NOT IN \(\$\d+,\$\d+\)/);
    expect(params).toContain('DA_GIAO');
    expect(params).toContain('HUY_TRA_MAY');
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

  it('returns order_code in YYYYMMDD-NNNNN format (RH-67)', async () => {
    // Counter returns 0 → expect a 5-digit zero-padded suffix.
    const created = { id: 'oN', order_code: '20260101-00000', status: 'TIEP_NHAN' };
    mockQuery
      .mockResolvedValueOnce({ rows: [{ last_issued: 0 }] })
      .mockResolvedValueOnce({ rows: [created] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customer_id: 'c1', branch_id: 'b1', product_type: 'SPEAKER',
        device_name: 'X', fault_description: 'y',
      });
    expect(res.status).toBe(201);
    // Counter SQL should have been called with the current UTC+7 year.
    const counterSql = mockQuery.mock.calls[0][0] as string;
    expect(counterSql).toMatch(/order_code_counters/);
    expect(counterSql).toMatch(/ON CONFLICT \(year\) DO UPDATE/);
  });

  it('creates order and returns 201', async () => {
    const created = { id: 'o1', order_code: '20260425-00000', status: 'TIEP_NHAN' };
    mockQuery
      .mockResolvedValueOnce({ rows: [{ last_issued: 0 }] }) // counter reservation (RH-67)
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
    expect(res.body.data.order_code).toMatch(/^\d{8}-\d{5}$/);
  });

  it('creates order with default warranty_period_months when not provided', async () => {
    const created = { id: 'o2', order_code: '20260425-00001', status: 'TIEP_NHAN' };
    mockQuery
      .mockResolvedValueOnce({ rows: [{ last_issued: 1 }] }) // counter reservation
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
    const order1 = { id: 'o1', order_code: '20260425-00000', status: 'TIEP_NHAN' };
    const order2 = { id: 'o2', order_code: '20260425-00001', status: 'TIEP_NHAN' };
    // Counter reservation happens on the pool (not the tx client) — one per product.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ last_issued: 0 }] })
      .mockResolvedValueOnce({ rows: [{ last_issued: 1 }] });
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
    expect(res.body.data[0].order_code).toMatch(/^\d{8}-\d{5}$/);
    expect(res.body.data[1].order_code).toMatch(/^\d{8}-\d{5}$/);
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it('creates single order in bulk and returns 201', async () => {
    const order = { id: 'o1', order_code: '20260425-00000', status: 'TIEP_NHAN' };
    mockQuery.mockResolvedValueOnce({ rows: [{ last_issued: 0 }] });  // counter
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
    const order = { id: 'o1', order_code: 'ORD001', status: 'TIEP_NHAN' };
    mockQuery
      .mockResolvedValueOnce({ rows: [order] })
      .mockResolvedValueOnce({ rows: [] }) // history
      .mockResolvedValueOnce({ rows: [] }); // images
    const res = await request(buildApp()).get('/api/orders/o1').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.history).toEqual([]);
    expect(res.body.data.images).toEqual([]);
  });

  // RH-134: source_order_history tests
  it('returns source_order_history=null for non-BH orders', async () => {
    const order = { id: 'o1', order_code: 'ORD001', status: 'TIEP_NHAN' };
    mockQuery
      .mockResolvedValueOnce({ rows: [order] })
      .mockResolvedValueOnce({ rows: [] }) // history
      .mockResolvedValueOnce({ rows: [] }); // images
    const res = await request(buildApp()).get('/api/orders/o1').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.source_order_history).toBeNull();
  });

  it('returns source_order_history with rows for BH order when source order exists', async () => {
    const bhOrder = { id: 'bh1', order_code: 'ORD001-BH', status: 'DANG_BAO_HANH' };
    const sourceHistoryRow = {
      id: 'h1',
      changed_by: 'u1',
      old_status: 'TIEP_NHAN',
      new_status: 'DANG_SUA',
      notes: 'Bắt đầu sửa',
      changed_at: '2026-01-01T00:00:00Z',
      changed_by_name: 'Admin',
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [bhOrder] })                        // fetch BH order
      .mockResolvedValueOnce({ rows: [] })                               // BH order history
      .mockResolvedValueOnce({ rows: [] })                               // images
      .mockResolvedValueOnce({ rows: [{ id: 'src1' }] })                // source order lookup
      .mockResolvedValueOnce({ rows: [sourceHistoryRow] });              // source order history
    const res = await request(buildApp()).get('/api/orders/bh1').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.source_order_history).toHaveLength(1);
    expect(res.body.data.source_order_history[0].old_status).toBe('TIEP_NHAN');
    expect(res.body.data.source_order_history[0].new_status).toBe('DANG_SUA');
    // Verify source lookup used correct derived code (strip -BH)
    const sourceLookupCall = mockQuery.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('order_code = $1') && call[1]?.[0] === 'ORD001'
    );
    expect(sourceLookupCall).toBeDefined();
  });

  it('returns source_order_history=[] for BH order when source order is not found', async () => {
    const bhOrder = { id: 'bh2', order_code: 'MANUAL-BH', status: 'DANG_BAO_HANH' };
    mockQuery
      .mockResolvedValueOnce({ rows: [bhOrder] })   // fetch BH order
      .mockResolvedValueOnce({ rows: [] })           // BH order history
      .mockResolvedValueOnce({ rows: [] })           // images
      .mockResolvedValueOnce({ rows: [] });          // source order not found
    const res = await request(buildApp()).get('/api/orders/bh2').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.source_order_history).toEqual([]);
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

describe('PATCH /api/orders/:id', () => {
  it('returns 400 when no update fields are provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'o1', status: 'TIEP_NHAN', warranty_period_months: 3 }] });
    const res = await request(buildApp())
      .patch('/api/orders/o1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Không có dữ liệu/);
  });

  it('returns 404 when order not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .patch('/api/orders/o99')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ quotation: 500000 });
    expect(res.status).toBe(404);
  });

  it('updates quotation without inserting history row when no notes and no warranty change', async () => {
    const order = { id: 'o1', status: 'TIEP_NHAN', warranty_period_months: 3 };
    const updated = { id: 'o1', status: 'TIEP_NHAN', quotation: 500000, warranty_period_months: 3 };
    mockQuery
      .mockResolvedValueOnce({ rows: [order] })    // SELECT current order
      .mockResolvedValueOnce({ rows: [] })          // UPDATE orders
      .mockResolvedValueOnce({ rows: [updated] });  // SELECT updated order
    const res = await request(buildApp())
      .patch('/api/orders/o1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ quotation: 500000 });
    expect(res.status).toBe(200);
    expect(res.body.data.quotation).toBe(500000);
    // Only 3 queries: SELECT, UPDATE, SELECT — no history inserts
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('inserts notes-only history row when no scalar field changes (RH-63)', async () => {
    const order = { id: 'o1', status: 'TIEP_NHAN', warranty_period_months: 3 };
    const updated = { id: 'o1', status: 'TIEP_NHAN', warranty_period_months: 3 };
    mockQuery
      .mockResolvedValueOnce({ rows: [order] })    // SELECT current order
      .mockResolvedValueOnce({ rows: [] })          // INSERT history (notes)
      .mockResolvedValueOnce({ rows: [updated] });  // SELECT updated
    const res = await request(buildApp())
      .patch('/api/orders/o1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ notes: 'Khách đã xác nhận báo giá' });
    expect(res.status).toBe(200);
    const historyInsert = mockQuery.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO order_status_history')
    );
    expect(historyInsert).toBeDefined();
    expect(historyInsert![1]).toContain('Khách đã xác nhận báo giá');
  });

  // RH-133: warranty change history tests
  it('inserts a warranty-change history row when warranty_period_months changes', async () => {
    const order = { id: 'o1', status: 'TIEP_NHAN', warranty_period_months: 3 };
    const updated = { id: 'o1', status: 'TIEP_NHAN', warranty_period_months: 6 };
    mockQuery
      .mockResolvedValueOnce({ rows: [order] })    // SELECT current order
      .mockResolvedValueOnce({ rows: [] })          // UPDATE orders
      .mockResolvedValueOnce({ rows: [] })          // INSERT history (warranty)
      .mockResolvedValueOnce({ rows: [updated] });  // SELECT updated
    const res = await request(buildApp())
      .patch('/api/orders/o1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ warranty_period_months: 6 });
    expect(res.status).toBe(200);
    const historyCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO order_status_history')
    );
    expect(historyCalls).toHaveLength(1);
    expect(historyCalls[0][1]).toContain('Cập nhật bảo hành: 3 tháng → 6 tháng');
  });

  it('does NOT insert warranty-change history when warranty_period_months is unchanged', async () => {
    const order = { id: 'o1', status: 'TIEP_NHAN', warranty_period_months: 6 };
    const updated = { id: 'o1', status: 'TIEP_NHAN', warranty_period_months: 6 };
    mockQuery
      .mockResolvedValueOnce({ rows: [order] })    // SELECT current order
      .mockResolvedValueOnce({ rows: [] })          // UPDATE orders (quotation changes)
      .mockResolvedValueOnce({ rows: [updated] });  // SELECT updated
    const res = await request(buildApp())
      .patch('/api/orders/o1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ warranty_period_months: 6, quotation: 200000 });
    expect(res.status).toBe(200);
    const historyCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO order_status_history')
    );
    expect(historyCalls).toHaveLength(0);
  });

  it('inserts two separate history rows when both warranty changes AND notes are submitted', async () => {
    const order = { id: 'o1', status: 'TIEP_NHAN', warranty_period_months: 3 };
    const updated = { id: 'o1', status: 'TIEP_NHAN', warranty_period_months: 12 };
    mockQuery
      .mockResolvedValueOnce({ rows: [order] })    // SELECT current order
      .mockResolvedValueOnce({ rows: [] })          // UPDATE orders
      .mockResolvedValueOnce({ rows: [] })          // INSERT history (warranty)
      .mockResolvedValueOnce({ rows: [] })          // INSERT history (notes)
      .mockResolvedValueOnce({ rows: [updated] });  // SELECT updated
    const res = await request(buildApp())
      .patch('/api/orders/o1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ warranty_period_months: 12, notes: 'Khách yêu cầu bảo hành dài hơn' });
    expect(res.status).toBe(200);
    const historyCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO order_status_history')
    );
    expect(historyCalls).toHaveLength(2);
    const warrantyNote = historyCalls[0][1] as unknown[];
    const textNote = historyCalls[1][1] as unknown[];
    expect(warrantyNote).toContain('Cập nhật bảo hành: 3 tháng → 12 tháng');
    expect(textNote).toContain('Khách yêu cầu bảo hành dài hơn');
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

  it('technician can upload to any order (RH-76: ownership check removed)', async () => {
    const techToken = jwt.sign({ id: 'u-tech', username: 'tech', role: 'TECHNICIAN', branch_id: 'b1' }, SECRET, { expiresIn: '1h' });
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: 'u-other' }] }); // order owned by someone else
    const res = await request(buildApp())
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${techToken}`);
    // Passes the auth check — multer mock provides no files → 400 (not 403)
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ảnh/);
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
