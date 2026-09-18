/**
 * Upload-specific tests for POST /api/orders/warranty-claim (video uploads,
 * and the transactional order/history/image INSERTs).
 *
 * These tests use REAL multer (no mock) so that fileFilter, the magic-byte
 * signature check, and video/image handling can be validated end-to-end
 * through the Express error-handler. sharp IS mocked to avoid needing real
 * image decoders.
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
let sharpMock: jest.Mock;

// Fresh transaction-client mock per test (see beforeEach).
let mockClientQuery: jest.Mock;
let mockClientRelease: jest.Mock;

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
  mockClientQuery = jest.fn().mockResolvedValue({ rows: [] });
  mockClientRelease = jest.fn();
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    for (const f of fs.readdirSync(tmpDir)) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* ignore */ }
    }
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal 1×1 white JPEG as a Buffer (real JFIF header — passes the magic-byte check). */
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

/** Minimal buffer with a valid MP4/MOV ftyp box signature (bytes 4-7 = 'ftyp'). */
function fakeMp4Buffer(): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypmp42', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('mp42isom', 'ascii'),
  ]);
}

const sourceOrder = {
  id: 'o1', order_code: 'ORD-20260425-00001', product_type: 'SPEAKER',
  customer_id: 'c1', device_name: 'JBL Flip 6',
  serial_imei: 'SN123', warranty_period_months: 12,
};
const newBhOrder = {
  id: 'bh1', order_code: 'ORD-20260425-00001-BH',
  status: 'DANG_BAO_HANH', product_type: 'BAO_HANH',
};

/** Mock a successful source-order lookup + code lookup (pool.query, pre-transaction). */
function setupSourceOrderFound() {
  mockQuery
    .mockResolvedValueOnce({ rows: [sourceOrder] }) // source order lookup
    .mockResolvedValueOnce({ rows: [] });           // existing -BH* codes — none
}

/** Mock a successful transaction: BEGIN, SAVEPOINT, INSERT order, INSERT history, COMMIT. */
function setupSuccessfulTransaction() {
  mockClientQuery
    .mockResolvedValueOnce({ rows: [] })           // BEGIN
    .mockResolvedValueOnce({ rows: [] })           // SAVEPOINT
    .mockResolvedValueOnce({ rows: [newBhOrder] }) // INSERT BH order
    .mockResolvedValueOnce({ rows: [] });          // INSERT status history
  // Any further client.query calls (INSERT order_images, COMMIT) fall back to
  // the default { rows: [] } set in beforeEach.
}

describe('POST /api/orders/warranty-claim — media uploads', () => {
  it('accepts an MP4 video, stores it with a .mp4 extension, and does not call sharp', async () => {
    setupSourceOrderFound();
    setupSuccessfulTransaction();

    const videoBuf = fakeMp4Buffer();
    const res = await request(app)
      .post('/api/orders/warranty-claim')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('source_order_id', 'o1')
      .field('branch_id', 'b1')
      .attach('images', videoBuf, { filename: 'clip.mov.exe', contentType: 'video/mp4' });

    expect(res.status).toBe(201);
    const insertCall = mockClientQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO order_images')
    );
    expect(insertCall).toBeDefined();
    const storedPath = insertCall![1][1] as string;
    // Extension must come from the mimetype map, not from the (misleading) originalname
    expect(storedPath).toMatch(/\.mp4$/);
    expect(sharpMock).not.toHaveBeenCalled();
    expect(mockClientRelease).toHaveBeenCalled();
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

  it('rejects a file whose content does not match its declared mimetype (video/mp4)', async () => {
    // Declares video/mp4 but the content is plain HTML — passes fileFilter
    // (mimetype is allowed) but must fail the magic-byte signature check.
    const htmlBuf = Buffer.from('<html><body>not a video</body></html>', 'utf8');
    const res = await request(app)
      .post('/api/orders/warranty-claim')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('source_order_id', 'o1')
      .field('branch_id', 'b1')
      .attach('images', htmlBuf, { filename: 'fake.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Nội dung tệp không khớp định dạng');
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('returns 400 when an image exceeds 10MB, and cleans up the file', async () => {
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

describe('POST /api/orders/warranty-claim — transaction (no orphan order on failure)', () => {
  it('rejects an oversized image before touching the DB at all', async () => {
    const bigBuf = Buffer.alloc(12 * 1024 * 1024, 0); // 12MB image

    const res = await request(app)
      .post('/api/orders/warranty-claim')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('source_order_id', 'o1')
      .field('branch_id', 'b1')
      .attach('images', bigBuf, { filename: 'huge.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    // File validation runs before the source-order lookup and before any
    // connection is taken from the pool — no INSERT, no orphan order.
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('rejects a bad-signature file before touching the DB at all', async () => {
    const htmlBuf = Buffer.from('<html></html>', 'utf8');

    const res = await request(app)
      .post('/api/orders/warranty-claim')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('source_order_id', 'o1')
      .field('branch_id', 'b1')
      .attach('images', htmlBuf, { filename: 'fake.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('rolls back the transaction and deletes the written file when the image INSERT fails', async () => {
    setupSourceOrderFound();
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })                                  // BEGIN
      .mockResolvedValueOnce({ rows: [] })                                  // SAVEPOINT
      .mockResolvedValueOnce({ rows: [newBhOrder] })                        // INSERT BH order
      .mockResolvedValueOnce({ rows: [] })                                  // INSERT status history
      .mockRejectedValueOnce(new Error('DB error on order_images INSERT')); // INSERT order_images — fails
    // ROLLBACK (outer catch) falls back to the default { rows: [] }.

    const jpg = tinyJpegBuffer();
    const res = await request(app)
      .post('/api/orders/warranty-claim')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('source_order_id', 'o1')
      .field('branch_id', 'b1')
      .attach('images', jpg, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);

    const queryTexts = mockClientQuery.mock.calls.map((c: unknown[]) => c[0]);
    expect(queryTexts).toContain('ROLLBACK');
    expect(queryTexts).not.toContain('COMMIT');
    expect(mockClientRelease).toHaveBeenCalled();

    // The file written for the image must be cleaned up — no orphan on disk.
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('cleans up the attached file when branch_id is missing (400 before any DB call)', async () => {
    const jpg = tinyJpegBuffer();
    const res = await request(app)
      .post('/api/orders/warranty-claim')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('source_order_id', 'o1')
      // branch_id omitted
      .attach('images', jpg, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Thiếu thông tin bắt buộc');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('cleans up the attached file when the source order is not found (404)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // source order not found

    const jpg = tinyJpegBuffer();
    const res = await request(app)
      .post('/api/orders/warranty-claim')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('source_order_id', 'o-nonexistent')
      .field('branch_id', 'b1')
      .attach('images', jpg, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(404);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('cleans up the attached file when the source order is itself a warranty order (400)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...sourceOrder, id: 'bh1', order_code: 'ORD-20260425-00001-BH', product_type: 'BAO_HANH' }],
    });

    const jpg = tinyJpegBuffer();
    const res = await request(app)
      .post('/api/orders/warranty-claim')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('source_order_id', 'bh1')
      .field('branch_id', 'b1')
      .attach('images', jpg, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/đơn bảo hành/);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });
});
