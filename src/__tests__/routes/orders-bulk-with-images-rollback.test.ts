/**
 * Rollback tests for POST /api/orders/bulk-with-images (RH-142).
 *
 * Uses mocked multer (no real FS/HEIC) and mocked pool client to force failures
 * at different points in the transaction. Asserts:
 * - ROLLBACK is called, COMMIT is NOT called, client is always released
 * - Written files are cleaned up when a failure happens after some files were stored
 * - The response is an error status
 *
 * The multer mock's any() handler also injects req.body.payload so that the
 * endpoint can parse it (real multer would do this when parsing multipart form).
 */

const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();

// Controlled per-test injectable: files and payload for the multer any() mock
let injectedPayload = '';
let injectedFiles: Array<{ fieldname: string; filename: string; mimetype: string; size: number }> = [];

jest.mock('../../config/database', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));
jest.mock('../../utils/activityLog', () => ({
  logActivity: jest.fn().mockResolvedValue(undefined),
}));

// Multer mock: .array() = no files; .any() injects files + body.payload
// MulterError must be a real class for `err instanceof multer.MulterError` in errorHandler
jest.mock('multer', () => {
  class MulterError extends Error {
    code: string;
    constructor(code: string) { super(code); this.code = code; }
  }
  const multerFactory = () => ({
    array: () => (req: any, _res: any, next: any) => { req.files = []; next(); },
    any: () => (req: any, _res: any, next: any) => {
      req.files = injectedFiles;
      req.body = { payload: injectedPayload };
      next();
    },
  });
  multerFactory.diskStorage = () => ({});
  multerFactory.MulterError = MulterError;
  return multerFactory;
});

jest.mock('sharp', () => {
  const fn = jest.fn(() => ({
    resize: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toFile: jest.fn().mockResolvedValue(undefined),
  }));
  return fn;
});

// Mock fs.unlinkSync so cleanup assertions can be verified
jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  unlinkSync: jest.fn(),
}));

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import { pool } from '../../config/database';
import { logActivity } from '../../utils/activityLog';

const mockQuery = pool.query as jest.Mock;
const mockConnect = pool.connect as jest.Mock;
const mockLogActivity = logActivity as jest.Mock;
const mockUnlinkSync = fs.unlinkSync as jest.Mock;

const SECRET = process.env.JWT_SECRET!;
const adminToken = jwt.sign(
  { id: 'u1', username: 'admin', role: 'ADMIN', branch_id: null },
  SECRET,
  { expiresIn: '1h' }
);

import ordersRouter from '../../routes/orders';
import { errorHandler } from '../../middleware/errorHandler';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/orders', ordersRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  injectedFiles = [];
  injectedPayload = '';
  jest.clearAllMocks();
  mockLogActivity.mockResolvedValue(undefined);
  mockClientQuery.mockResolvedValue({ rows: [] });
  mockConnect.mockResolvedValue({
    query: mockClientQuery,
    release: mockClientRelease,
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function twoProductPayload(): string {
  return JSON.stringify({
    customer_id: 'c1',
    branch_id: 'b1',
    products: [
      { product_type: 'SPEAKER', device_name: 'JBL', fault_description: 'x' },
      { product_type: 'HEADPHONE', device_name: 'Sony', fault_description: 'y' },
    ],
  });
}

function oneProductPayload(): string {
  return JSON.stringify({
    customer_id: 'c1',
    branch_id: 'b1',
    products: [
      { product_type: 'SPEAKER', device_name: 'JBL', fault_description: 'x' },
    ],
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/orders/bulk-with-images — rollback on DB failure (RH-142)', () => {

  /**
   * Scenario: product A inserts fine, product B's order INSERT throws.
   * No files injected — storeUploadedImage is never called.
   * Assert: ROLLBACK called, COMMIT not called, client released.
   */
  it('rolls back transaction when DB INSERT throws on the second product', async () => {
    injectedPayload = twoProductPayload();
    injectedFiles = [];

    const orderA = { id: 'oA', order_code: '20260618-00000', status: 'TIEP_NHAN' };

    // generateOrderCode (pool.query) called once per product successfully inserted so far
    mockQuery
      .mockResolvedValueOnce({ rows: [{ last_issued: 0 }] }) // counter A
      .mockResolvedValueOnce({ rows: [{ last_issued: 1 }] }); // counter B

    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })          // BEGIN
      .mockResolvedValueOnce({ rows: [orderA] })    // INSERT order A
      .mockResolvedValueOnce({ rows: [] })           // INSERT history A
      .mockRejectedValueOnce(new Error('DB error on product B')); // INSERT order B throws
    // ROLLBACK falls back to default mockResolvedValue({ rows: [] })

    const res = await request(buildApp())
      .post('/api/orders/bulk-with-images')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(); // body is injected by multer mock

    expect(res.body.success).toBe(false);

    const queryTexts = mockClientQuery.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(queryTexts).toContain('ROLLBACK');
    expect(queryTexts).not.toContain('COMMIT');
    expect(mockClientRelease).toHaveBeenCalled();
  });

  /**
   * Scenario: product A has one file (images_0). storeUploadedImage is called and
   * the file is a small JPEG (no conversion → returns filename unchanged). Then
   * the DB INSERT INTO order_images throws. writtenFiles contains the file path, so
   * cleanup calls unlinkSync with it.
   */
  it('cleans up written files and rolls back when image INSERT fails', async () => {
    injectedPayload = oneProductPayload();
    injectedFiles = [
      { fieldname: 'images_0', filename: 'img_a.jpg', mimetype: 'image/jpeg', size: 500 },
    ];

    const orderA = { id: 'oA', order_code: '20260618-00000', status: 'TIEP_NHAN' };

    mockQuery.mockResolvedValueOnce({ rows: [{ last_issued: 0 }] }); // counter A

    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })          // BEGIN
      .mockResolvedValueOnce({ rows: [orderA] })    // INSERT order A
      .mockResolvedValueOnce({ rows: [] })           // INSERT history A
      .mockRejectedValueOnce(new Error('DB error on image INSERT')); // INSERT order_image throws
    // ROLLBACK falls back to default mockResolvedValue

    const res = await request(buildApp())
      .post('/api/orders/bulk-with-images')
      .set('Authorization', `Bearer ${adminToken}`)
      .send();

    expect(res.body.success).toBe(false);

    const queryTexts = mockClientQuery.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(queryTexts).toContain('ROLLBACK');
    expect(queryTexts).not.toContain('COMMIT');
    expect(mockClientRelease).toHaveBeenCalled();

    // The file written for product A should be cleaned up
    const deletedPaths = mockUnlinkSync.mock.calls.map((c) => String(c[0]));
    expect(deletedPaths.some((p) => p.includes('img_a.jpg'))).toBe(true);
  });

  /**
   * Scenario: COMMIT itself throws (extreme edge case).
   * The finally block must still release the client.
   */
  it('releases the client even when COMMIT throws', async () => {
    injectedPayload = oneProductPayload();
    injectedFiles = [];

    const order = { id: 'o1', order_code: '20260618-00000', status: 'TIEP_NHAN' };

    mockQuery.mockResolvedValueOnce({ rows: [{ last_issued: 0 }] });

    // All client queries succeed until COMMIT throws
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })       // BEGIN
      .mockResolvedValueOnce({ rows: [order] })  // INSERT order
      .mockResolvedValueOnce({ rows: [] })        // INSERT history
      .mockRejectedValueOnce(new Error('COMMIT failure')); // COMMIT throws

    const res = await request(buildApp())
      .post('/api/orders/bulk-with-images')
      .set('Authorization', `Bearer ${adminToken}`)
      .send();

    expect(res.body.success).toBe(false);
    // The finally block runs regardless, releasing the client
    expect(mockClientRelease).toHaveBeenCalled();
  });
});
