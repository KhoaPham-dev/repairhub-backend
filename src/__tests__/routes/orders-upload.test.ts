/**
 * Upload-specific tests for POST /api/orders/:id/images (RH-139).
 *
 * These tests use REAL multer (no mock) so that fileFilter, MulterError,
 * and file-count behaviour can be validated end-to-end through the Express
 * error-handler. sharp IS mocked to avoid needing real image decoders.
 *
 * The existing orders.test.ts mocks multer/sharp at module level; to keep
 * that file untouched, all upload-specific assertions live here instead.
 *
 * IMPORTANT: orders.ts reads process.env.UPLOAD_DIR at module-evaluation time
 * (to configure multer diskStorage). Jest may cache the module from a previous
 * test file — so we use jest.isolateModules() inside buildApp() to guarantee
 * a fresh require with our UPLOAD_DIR already set.
 */

// ── Database & activity mocks (required — no real DB in tests) ───────────────
jest.mock('../../config/database', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));
jest.mock('../../utils/activityLog', () => ({
  logActivity: jest.fn().mockResolvedValue(undefined),
}));

// ── sharp mock: simulates successful HEIC → JPEG conversion ─────────────────
// We use jest.mock here so it's hoisted above imports; the factory always
// returns a fluent mock chain. jest.clearAllMocks() in beforeEach does NOT
// remove this factory — it only clears call counts.
jest.mock('sharp', () => {
  const fn = jest.fn(() => ({
    resize: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toFile: jest.fn().mockResolvedValue(undefined),
  }));
  return fn;
});

// NOTE: multer is NOT mocked here — that is intentional.
// We need real multer so fileFilter and LIMIT_FILE_SIZE work.

import fs from 'fs';
import path from 'path';
import os from 'os';
import request from 'supertest';
import express, { Express } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../../config/database';
import { errorHandler } from '../../middleware/errorHandler';
import { logActivity } from '../../utils/activityLog';

const mockQuery = pool.query as jest.Mock;
const mockLogActivity = logActivity as jest.Mock;
const SECRET = process.env.JWT_SECRET!;
const adminToken = jwt.sign(
  { id: 'u1', username: 'admin', role: 'ADMIN', branch_id: null },
  SECRET,
  { expiresIn: '1h' }
);

// Use a temp directory as the uploads dir so tests are fully isolated.
let tmpDir: string;

// Build the app once per suite (after UPLOAD_DIR is set), re-using a single
// fresh require of orders.ts via jest.isolateModules. All tests share the
// same app instance — that is fine because multer config is stateless beyond
// the upload dir, which doesn't change during the suite.
let app: Express;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh139-test-'));
  process.env.UPLOAD_DIR = tmpDir;

  // Build the app once with a fresh (isolated) copy of orders.ts AND
  // errorHandler.ts that sees the UPLOAD_DIR we just set. Both modules are
  // loaded from the same isolated registry so they share the same multer
  // instance — critical for `err instanceof multer.MulterError` to work.
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
  jest.clearAllMocks();
  mockLogActivity.mockResolvedValue(undefined);
});

afterEach(() => {
  // Clean up any files left by uploads between tests
  if (tmpDir && fs.existsSync(tmpDir)) {
    for (const f of fs.readdirSync(tmpDir)) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* ignore */ }
    }
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/** Build a buffer of at least `bytes` length filled with zeros (for size-limit tests). */
function oversizeBuffer(bytes: number): Buffer {
  return Buffer.alloc(bytes + 1, 0);
}

// Setup order-found mock so auth and order lookup succeed for all upload tests
function setupOrderFound() {
  mockQuery.mockResolvedValueOnce({ rows: [{ created_by: 'u1' }] }); // order exists
}

function setupInsertImage(n = 1) {
  for (let i = 0; i < n; i++) {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: `img${i}`, image_path: `f${i}.jpg`, image_type: 'INTAKE', uploaded_by: 'u1' }],
    });
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/orders/:id/images — upload behaviour (RH-139)', () => {

  // ── 1. No file-count cap ──────────────────────────────────────────────────
  it('accepts 12 valid JPEG files in one request (no count cap)', async () => {
    setupOrderFound();
    setupInsertImage(12);

    const jpg = tinyJpegBuffer();
    let req = request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('image_type', 'INTAKE');

    for (let i = 0; i < 12; i++) {
      req = req.attach('images', jpg, { filename: `photo${i}.jpg`, contentType: 'image/jpeg' });
    }

    const res = await req;
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(12);
  });

  // ── 2. Invalid image_type → 400 ──────────────────────────────────────────
  it('returns 400 for invalid image_type (REPAIR)', async () => {
    setupOrderFound();
    // No image insert mock needed — should reject before DB

    const jpg = tinyJpegBuffer();
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('image_type', 'REPAIR')
      .attach('images', jpg, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Loại ảnh không hợp lệ/);
  });

  it('returns 400 for unsupported image_type value (OTHER)', async () => {
    setupOrderFound();

    const jpg = tinyJpegBuffer();
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('image_type', 'OTHER')
      .attach('images', jpg, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Loại ảnh không hợp lệ/);
  });

  // ── 3. Unsupported mimetype → rejected (not silently dropped) ─────────────
  it('rejects image/gif with a 4xx error (not silently dropped)', async () => {
    // multer fileFilter fires DURING multipart parsing, before the route
    // handler body runs. The order DB lookup is NOT called in this case.
    // Do NOT call setupOrderFound() here — the mock queue must stay clean.

    const gif = Buffer.from(
      '47494638396101000100000000000021f90400000000002c00000000010001000002024401003b',
      'hex'
    );
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', gif, { filename: 'anim.gif', contentType: 'image/gif' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Định dạng ảnh không hợp lệ/);
  });

  it('rejects image/bmp mimetype with 4xx error', async () => {
    const bmp = Buffer.alloc(100, 0x42); // fake BMP bytes
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', bmp, { filename: 'test.bmp', contentType: 'image/bmp' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.success).toBe(false);
  });

  // ── 4. File exceeding 10MB → 413 ─────────────────────────────────────────
  it('returns 413 when an image exceeds 10MB', async () => {
    // LIMIT_FILE_SIZE fires during multipart parsing — no order lookup mock needed.

    const bigBuffer = oversizeBuffer(10 * 1024 * 1024); // just over 10MB
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', bigBuffer, { filename: 'huge.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(413);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Ảnh quá lớn/);
  });

  // ── 5. HEIC conversion ────────────────────────────────────────────────────
  //
  // sharp in this environment has libheif 1.20.2 but the format registry only
  // lists .avif as a known file suffix (not .heic). When multer writes a HEIC
  // file to disk and sharp tries to read it, it MAY fail if the HEIC decoder
  // is not available via file-path detection.
  //
  // We test the conversion CODE PATH by:
  //   a) faking a HEIC mimetype with a minimal buffer (our mock sharp always
  //      succeeds, so the code path is exercised even if the bytes are not
  //      valid HEIC).
  //   b) Asserting the stored image_path ends in .jpg.
  //
  // If a real HEIC fixture and real sharp HEIC decode are needed,
  // add a separate it.skip (see below).

  it('stores HEIC upload with a .jpg path (sharp mock confirms HEIC conversion path)', async () => {
    setupOrderFound();
    // DB insert mock: capture params[1] as image_path so we can verify it ends in .jpg
    mockQuery.mockImplementationOnce((_sql: string, params: unknown[]) => {
      return Promise.resolve({
        rows: [{ id: 'img1', image_path: params[1], image_type: 'INTAKE', uploaded_by: 'u1' }],
      });
    });

    // A small buffer that multer will accept (mimetype declared as image/heic)
    const fakeHeicBuf = Buffer.from('heic-fake', 'utf8');
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('image_type', 'INTAKE')
      .attach('images', fakeHeicBuf, { filename: 'photo.heic', contentType: 'image/heic' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    // The stored filename must end in .jpg (HEIC was converted)
    const storedPath: string = res.body.data[0].image_path;
    expect(storedPath).toMatch(/\.jpg$/);
    expect(storedPath).not.toMatch(/\.heic$/);
  });

  // Skip: real HEIC decode with an actual HEIC fixture byte stream.
  // libheif is present (1.20.2) but sharp's file-suffix registry only lists .avif;
  // actual HEIC decode via file path may not work unless vips was built with
  // HEIC file-format detection. Enable once a .heic fixture is available and
  // confirmed to decode in this environment.
  it.skip('decodes a real HEIC fixture and stores as .jpg (requires libvips HEIC support)', async () => {
    // To enable: place a tiny real HEIC file at src/__tests__/fixtures/tiny.heic
    // then remove the skip.
    const fixturePath = path.join(__dirname, '../fixtures/tiny.heic');
    if (!fs.existsSync(fixturePath)) return;

    setupOrderFound();
    mockQuery.mockImplementationOnce((_sql: string, params: unknown[]) => {
      return Promise.resolve({
        rows: [{ id: 'img1', image_path: params[1], image_type: 'INTAKE', uploaded_by: 'u1' }],
      });
    });

    const heicBuf = fs.readFileSync(fixturePath);
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('image_type', 'INTAKE')
      .attach('images', heicBuf, { filename: 'tiny.heic', contentType: 'image/heic' });

    expect(res.status).toBe(201);
    expect(res.body.data[0].image_path).toMatch(/\.jpg$/);
  });

  // ── 6. Valid COMPLETION image_type ────────────────────────────────────────
  it('accepts COMPLETION as a valid image_type', async () => {
    setupOrderFound();
    setupInsertImage(1);

    const jpg = tinyJpegBuffer();
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('image_type', 'COMPLETION')
      .attach('images', jpg, { filename: 'after.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  // ── 7. Default image_type = INTAKE when omitted ───────────────────────────
  it('defaults image_type to INTAKE when not provided', async () => {
    setupOrderFound();
    setupInsertImage(1);

    const jpg = tinyJpegBuffer();
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', jpg, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    // Verify the INSERT was called with 'INTAKE'
    const insertCall = mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO order_images')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toContain('INTAKE');
  });
});
