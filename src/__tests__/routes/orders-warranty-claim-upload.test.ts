/**
 * Upload-specific tests for POST /api/orders/warranty-claim (video uploads).
 *
 * These tests use REAL multer (no mock) so that fileFilter and video/image
 * handling can be validated end-to-end through the Express error-handler.
 * sharp IS mocked to avoid needing real image decoders.
 *
 * The existing orders.test.ts mocks multer/sharp at module level; to keep
 * that file untouched, all upload-specific assertions for this route live
 * here instead — mirroring orders-upload.test.ts and
 * orders-bulk-with-images.test.ts.
 *
 * IMPORTANT: orders.ts reads process.env.UPLOAD_DIR at module-evaluation time
 * (to configure multer diskStorage). Jest may cache the module from a previous
 * test file — so we use jest.isolateModules() to guarantee a fresh require
 * with our UPLOAD_DIR already set.
 */

jest.mock('../../config/database', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));
jest.mock('../../utils/activityLog', () => ({
  logActivity: jest.fn().mockResolvedValue(undefined),
}));

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
const mockLogActivity = logActivity as jest.Mock;
const SECRET = process.env.JWT_SECRET!;
const adminToken = jwt.sign(
  { id: 'u1', username: 'admin', role: 'ADMIN', branch_id: null },
  SECRET,
  { expiresIn: '1h' }
);

let tmpDir: string;
let app: Express;
let sharpMock: jest.Mock;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-warranty-video-'));
  process.env.UPLOAD_DIR = tmpDir;

  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ordersRouter = require('../../routes/orders').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { errorHandler: isolatedErrHandler } = require('../../middleware/errorHandler');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sharpMock = require('sharp');
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
  jest.clearAllMocks();
  mockLogActivity.mockResolvedValue(undefined);
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    for (const f of fs.readdirSync(tmpDir)) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* ignore */ }
    }
  }
});

/** Mock a successful path up to (and including) the new BH order's INSERTs. */
function setupOrderCreated() {
  const sourceOrder = {
    id: 'o1', order_code: 'ORD-20260425-00001', product_type: 'SPEAKER',
    customer_id: 'c1', device_name: 'JBL Flip 6',
    serial_imei: 'SN123', warranty_period_months: 12,
  };
  const newBhOrder = {
    id: 'bh1', order_code: 'ORD-20260425-00001-BH',
    status: 'DANG_BAO_HANH', product_type: 'BAO_HANH',
  };
  mockQuery
    .mockResolvedValueOnce({ rows: [sourceOrder] }) // source order lookup
    .mockResolvedValueOnce({ rows: [] })            // existing -BH* codes — none
    .mockResolvedValueOnce({ rows: [newBhOrder] })  // INSERT BH order
    .mockResolvedValueOnce({ rows: [] });           // INSERT status history
}

describe('POST /api/orders/warranty-claim — media uploads', () => {
  it('accepts an MP4 video, stores it with a .mp4 extension, and does not call sharp', async () => {
    setupOrderCreated();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'img1' }] }); // INSERT order_image

    const videoBuf = Buffer.from('fake mp4 bytes');
    const res = await request(app)
      .post('/api/orders/warranty-claim')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('source_order_id', 'o1')
      .field('branch_id', 'b1')
      .attach('images', videoBuf, { filename: 'clip.mov.exe', contentType: 'video/mp4' });

    expect(res.status).toBe(201);
    const insertCall = mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO order_images')
    );
    expect(insertCall).toBeDefined();
    const storedPath = insertCall![1][1] as string;
    // Extension must come from the mimetype map, not from the (misleading) originalname
    expect(storedPath).toMatch(/\.mp4$/);
    expect(sharpMock).not.toHaveBeenCalled();
  });

  it('rejects an unsupported mimetype (video/x-msvideo) with 4xx (fileFilter)', async () => {
    const aviBuf = Buffer.alloc(100, 0x41);
    const res = await request(app)
      .post('/api/orders/warranty-claim')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('source_order_id', 'o1')
      .field('branch_id', 'b1')
      .attach('images', aviBuf, { filename: 'clip.avi', contentType: 'video/x-msvideo' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Định dạng tệp không hợp lệ/);
  });

  it('returns 400 when an image exceeds 10MB, and cleans up the file', async () => {
    setupOrderCreated();

    const bigBuf = Buffer.alloc(12 * 1024 * 1024, 0); // 12MB image
    const res = await request(app)
      .post('/api/orders/warranty-claim')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('source_order_id', 'o1')
      .field('branch_id', 'b1')
      .attach('images', bigBuf, { filename: 'huge.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Ảnh quá lớn (tối đa 10MB mỗi ảnh)');
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });
});
