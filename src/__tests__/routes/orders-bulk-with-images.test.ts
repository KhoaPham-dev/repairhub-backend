/**
 * Tests for POST /api/orders/bulk-with-images (RH-142).
 *
 * Strategy: two test files that complement each other.
 *
 * FILE A (this file — real multer):
 *   Uses real multer (.any()) so fileFilter, HEIC conversion, and LIMIT_FILE_SIZE
 *   work end-to-end. Tests: success path (2 products × images), HEIC conversion,
 *   bad MIME type, missing payload fields.
 *
 * FILE B (orders-bulk-with-images-rollback.test.ts — mocked multer):
 *   Mocks multer and storeUploadedImage to exercise the rollback/cleanup path
 *   without touching the FS or needing real images.
 *
 * IMPORTANT: orders.ts reads process.env.UPLOAD_DIR at module-evaluation time.
 * We use jest.isolateModules() in beforeAll() to guarantee a fresh require with
 * our UPLOAD_DIR already set, and load errorHandler from the same registry so
 * err instanceof multer.MulterError works.
 */

// ── Database & activity mocks ─────────────────────────────────────────────────
jest.mock('../../config/database', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));
jest.mock('../../utils/activityLog', () => ({
  logActivity: jest.fn().mockResolvedValue(undefined),
}));

// sharp mock — simulates successful compression without real libvips
jest.mock('sharp', () => {
  const fn = jest.fn(() => ({
    resize: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toFile: jest.fn().mockResolvedValue(undefined),
  }));
  return fn;
});

// NOTE: multer is NOT mocked here — real multer so fileFilter/limits fire.

import fs from 'fs';
import path from 'path';
import os from 'os';
import request from 'supertest';
import express, { Express } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../../config/database';
import { logActivity } from '../../utils/activityLog';

const mockQuery = pool.query as jest.Mock;
const mockConnect = pool.connect as jest.Mock;
const mockLogActivity = logActivity as jest.Mock;

const SECRET = process.env.JWT_SECRET!;
const adminToken = jwt.sign(
  { id: 'u1', username: 'admin', role: 'ADMIN', branch_id: null },
  SECRET,
  { expiresIn: '1h' }
);

let tmpDir: string;
let app: Express;

// Mock client used inside transactions
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh142-real-'));
  process.env.UPLOAD_DIR = tmpDir;

  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ordersRouter = require('../../routes/orders').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { errorHandler: isolatedErrHandler } = require('../../middleware/errorHandler');
    app = express();
    app.use(express.json());
    app.use('/api/orders', ordersRouter);
    app.use(isolatedErrHandler);
  });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.UPLOAD_DIR;
});

beforeEach(() => {
  mockLogActivity.mockResolvedValue(undefined);
  mockClientQuery.mockResolvedValue({ rows: [] });
  mockClientRelease.mockReset();
  mockConnect.mockResolvedValue({
    query: mockClientQuery,
    release: mockClientRelease,
  });
  jest.clearAllMocks();
  mockLogActivity.mockResolvedValue(undefined);
  mockClientQuery.mockResolvedValue({ rows: [] });
  mockConnect.mockResolvedValue({
    query: mockClientQuery,
    release: mockClientRelease,
  });
});

afterEach(() => {
  // Clean up any files left by uploads between tests
  if (tmpDir && fs.existsSync(tmpDir)) {
    for (const f of fs.readdirSync(tmpDir)) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* ignore */ }
    }
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal 1×1 white JPEG as a Buffer (real JFIF header). */
function tinyJpegBuffer(): Buffer {
  return Buffer.from(
    'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909' +
    '0806090d0e0b0c0d0c0b0e121013141312131618161414161b1a1b18191a191a1a1c1e1c1a' +
    '1c1b2020201d2024272723221e262623262524ffc0000b08000100010101110003ffc40014' +
    '00010000000000000000000000000000000affc40014100100000000000000000000000000' +
    '000000ffda0003010003003f0000ffd9',
    'hex'
  );
}

/** Build a valid multipart payload JSON string. */
function makePayload(overrides: object = {}): string {
  return JSON.stringify({
    customer_id: 'c1',
    branch_id: 'b1',
    products: [
      { product_type: 'SPEAKER', device_name: 'JBL Flip 6', fault_description: 'no sound' },
    ],
    ...overrides,
  });
}

/**
 * Setup mock sequence for a successful bulk-with-images transaction.
 * Per product: BEGIN, generateOrderCode (pool.query), INSERT order (client),
 * INSERT history (client), INSERT order_image × n (client), COMMIT.
 */
function setupSuccessfulTransaction(
  orders: Array<{ id: string; order_code: string }>,
  imagesPerProduct: number[]
) {
  // generateOrderCode calls pool.query (not client.query) — one per product
  for (const order of orders) {
    mockQuery.mockResolvedValueOnce({ rows: [{ last_issued: 0 }] }); // counter
  }

  // client.query sequence: BEGIN, then per product: INSERT order, INSERT history,
  // INSERT order_image × n, then COMMIT
  mockClientQuery.mockResolvedValueOnce({ rows: [] }); // BEGIN
  for (let i = 0; i < orders.length; i++) {
    mockClientQuery.mockResolvedValueOnce({ rows: [orders[i]] }); // INSERT order
    mockClientQuery.mockResolvedValueOnce({ rows: [] });            // INSERT history
    for (let j = 0; j < imagesPerProduct[i]; j++) {
      mockClientQuery.mockResolvedValueOnce({ rows: [] }); // INSERT order_image
    }
  }
  mockClientQuery.mockResolvedValueOnce({ rows: [] }); // COMMIT
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/orders/bulk-with-images — success path (RH-142)', () => {

  // ── 1. Two products, A gets 2 images via images_0, B gets 1 via images_1 ───
  it('creates 2 products with their images and returns 201 (A: 2 imgs, B: 1 img)', async () => {
    const orderA = { id: 'oA', order_code: '20260618-00000', status: 'TIEP_NHAN' };
    const orderB = { id: 'oB', order_code: '20260618-00001', status: 'TIEP_NHAN' };
    setupSuccessfulTransaction([orderA, orderB], [2, 1]);

    const payload = JSON.stringify({
      customer_id: 'c1',
      branch_id: 'b1',
      products: [
        { product_type: 'SPEAKER', device_name: 'JBL Flip 6', fault_description: 'no sound' },
        { product_type: 'HEADPHONE', device_name: 'Sony WH-1000XM5', fault_description: 'battery' },
      ],
    });

    const jpg = tinyJpegBuffer();
    const res = await request(app)
      .post('/api/orders/bulk-with-images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('payload', payload)
      .attach('images_0', jpg, { filename: 'a1.jpg', contentType: 'image/jpeg' })
      .attach('images_0', jpg, { filename: 'a2.jpg', contentType: 'image/jpeg' })
      .attach('images_1', jpg, { filename: 'b1.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);

    // Verify COMMIT was called (and not ROLLBACK)
    const queryTexts = mockClientQuery.mock.calls.map((c: unknown[]) => c[0]);
    expect(queryTexts).toContain('COMMIT');
    expect(queryTexts).not.toContain('ROLLBACK');

    // Verify each product's images were INSERTed with the correct order_id
    const imageInserts = mockClientQuery.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO order_images')
    );
    expect(imageInserts).toHaveLength(3); // 2 for product A + 1 for product B

    // Product A images must reference orderA.id
    const aInserts = imageInserts.filter((c: unknown[]) => (c[1] as unknown[])[0] === 'oA');
    expect(aInserts).toHaveLength(2);

    // Product B image must reference orderB.id
    const bInserts = imageInserts.filter((c: unknown[]) => (c[1] as unknown[])[0] === 'oB');
    expect(bInserts).toHaveLength(1);
  });

  // ── 2. Single product with no images ────────────────────────────────────
  it('creates a single product with no images and returns 201', async () => {
    const order = { id: 'o1', order_code: '20260618-00000', status: 'TIEP_NHAN' };
    setupSuccessfulTransaction([order], [0]);

    const res = await request(app)
      .post('/api/orders/bulk-with-images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('payload', makePayload());

    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(1);
  });

  // ── 3. logActivity called once per order ─────────────────────────────────
  it('calls logActivity once per order', async () => {
    const orderA = { id: 'oA', order_code: '20260618-00000', status: 'TIEP_NHAN' };
    const orderB = { id: 'oB', order_code: '20260618-00001', status: 'TIEP_NHAN' };
    setupSuccessfulTransaction([orderA, orderB], [0, 0]);

    const payload = JSON.stringify({
      customer_id: 'c1',
      branch_id: 'b1',
      products: [
        { product_type: 'SPEAKER', device_name: 'JBL', fault_description: 'x' },
        { product_type: 'OTHER', device_name: 'Generic', fault_description: 'y' },
      ],
    });

    const res = await request(app)
      .post('/api/orders/bulk-with-images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('payload', payload);

    expect(res.status).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
    expect(mockLogActivity).toHaveBeenCalledWith('u1', 'CREATE_ORDER', 'order', 'oA');
    expect(mockLogActivity).toHaveBeenCalledWith('u1', 'CREATE_ORDER', 'order', 'oB');
  });
});

describe('POST /api/orders/bulk-with-images — HEIC conversion (RH-142)', () => {

  it('converts a real HEIC fixture to .jpg and stores it', async () => {
    const fixturePath = path.join(__dirname, '../fixtures/tiny.heic');
    const heicBuf = fs.readFileSync(fixturePath);

    const order = { id: 'oH', order_code: '20260618-00000', status: 'TIEP_NHAN' };
    setupSuccessfulTransaction([order], [1]);

    const payload = JSON.stringify({
      customer_id: 'c1',
      branch_id: 'b1',
      products: [
        { product_type: 'SPEAKER', device_name: 'JBL', fault_description: 'x' },
      ],
    });

    const res = await request(app)
      .post('/api/orders/bulk-with-images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('payload', payload)
      .attach('images_0', heicBuf, { filename: 'tiny.heic', contentType: 'image/heic' });

    expect(res.status).toBe(201);

    // The image INSERT should have stored a .jpg path (not .heic)
    const imageInsert = mockClientQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO order_images')
    );
    expect(imageInsert).toBeDefined();
    const storedPath = (imageInsert![1] as unknown[])[1] as string;
    expect(storedPath).toMatch(/\.jpg$/);
    expect(storedPath).not.toMatch(/\.heic$/);
  });
});

describe('POST /api/orders/bulk-with-images — validation (RH-142)', () => {

  it('returns 400 for invalid JSON payload', async () => {
    const res = await request(app)
      .post('/api/orders/bulk-with-images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('payload', '{not valid json}');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/JSON/);
  });

  it('returns 400 when customer_id is missing', async () => {
    const payload = JSON.stringify({
      branch_id: 'b1',
      products: [{ product_type: 'SPEAKER', device_name: 'JBL', fault_description: 'x' }],
    });
    const res = await request(app)
      .post('/api/orders/bulk-with-images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('payload', payload);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customer_id/);
  });

  it('returns 400 when branch_id is missing', async () => {
    const payload = JSON.stringify({
      customer_id: 'c1',
      products: [{ product_type: 'SPEAKER', device_name: 'JBL', fault_description: 'x' }],
    });
    const res = await request(app)
      .post('/api/orders/bulk-with-images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('payload', payload);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/branch_id/);
  });

  it('returns 400 when products array is empty', async () => {
    const payload = JSON.stringify({ customer_id: 'c1', branch_id: 'b1', products: [] });
    const res = await request(app)
      .post('/api/orders/bulk-with-images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('payload', payload);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/products/);
  });

  it('returns 400 when more than 20 products are submitted', async () => {
    const products = Array.from({ length: 21 }, (_, i) => ({
      product_type: 'SPEAKER', device_name: `dev${i}`, fault_description: 'loi',
    }));
    const payload = JSON.stringify({ customer_id: 'c1', branch_id: 'b1', products });
    const res = await request(app)
      .post('/api/orders/bulk-with-images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('payload', payload);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/20/);
  });

  it('returns 400 when a product has an invalid product_type', async () => {
    const payload = JSON.stringify({
      customer_id: 'c1',
      branch_id: 'b1',
      products: [{ product_type: 'INVALID_TYPE', device_name: 'JBL', fault_description: 'x' }],
    });
    const res = await request(app)
      .post('/api/orders/bulk-with-images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('payload', payload);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/product_type/);
  });

  it('returns 400 when a product is missing device_name', async () => {
    const payload = JSON.stringify({
      customer_id: 'c1',
      branch_id: 'b1',
      products: [{ product_type: 'SPEAKER', fault_description: 'x' }],
    });
    const res = await request(app)
      .post('/api/orders/bulk-with-images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('payload', payload);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/device_name/);
  });

  it('returns 400 when a product is missing fault_description', async () => {
    const payload = JSON.stringify({
      customer_id: 'c1',
      branch_id: 'b1',
      products: [{ product_type: 'SPEAKER', device_name: 'JBL' }],
    });
    const res = await request(app)
      .post('/api/orders/bulk-with-images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('payload', payload);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fault_description/);
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app)
      .post('/api/orders/bulk-with-images')
      .field('payload', makePayload());

    expect(res.status).toBe(401);
  });

  it('rejects unsupported MIME type with 4xx (fileFilter)', async () => {
    const gifBuf = Buffer.from(
      '47494638396101000100000000000021f90400000000002c00000000010001000002024401003b',
      'hex'
    );
    const res = await request(app)
      .post('/api/orders/bulk-with-images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('payload', makePayload())
      .attach('images_0', gifBuf, { filename: 'test.gif', contentType: 'image/gif' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.error).toMatch(/Định dạng ảnh không hợp lệ/);
  });

  it('returns 413 when an image exceeds 10MB', async () => {
    const bigBuf = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
    const res = await request(app)
      .post('/api/orders/bulk-with-images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('payload', makePayload())
      .attach('images_0', bigBuf, { filename: 'huge.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(413);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Ảnh quá lớn/);
  });
});
