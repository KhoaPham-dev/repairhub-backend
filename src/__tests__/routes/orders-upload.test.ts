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
    png: jest.fn().mockReturnThis(),
    webp: jest.fn().mockReturnThis(),
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
// Not a valid app role (only ADMIN/TECHNICIAN exist) — used only to exercise
// the route's own role check, since JWT payloads aren't schema-validated.
const viewerToken = jwt.sign(
  { id: 'u3', username: 'viewer', role: 'VIEWER', branch_id: null },
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
// The sharp mock instance used by the isolated copy of orders.ts (captured
// from the SAME isolated registry so it is the exact singleton orders.ts
// calls into — a top-level `import sharp` would resolve to a different
// module instance since it lives outside jest.isolateModules).
let sharpMock: jest.Mock;
// Captured from the same isolated registry so it's the exact function
// orders.ts uses internally (a plain top-level import would trigger a
// second, un-isolated load of orders.ts using the default UPLOAD_DIR).
let sanitizeOriginalFilename: (name: string) => string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh139-test-'));
  process.env.UPLOAD_DIR = tmpDir;

  // Build the app once with a fresh (isolated) copy of orders.ts AND
  // errorHandler.ts that sees the UPLOAD_DIR we just set. Both modules are
  // loaded from the same isolated registry so they share the same multer
  // instance — critical for `err instanceof multer.MulterError` to work.
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ordersModule = require('../../routes/orders');
    const ordersRouter = ordersModule.default;
    sanitizeOriginalFilename = ordersModule.sanitizeOriginalFilename;
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

/**
 * Build a buffer of at least `bytes` length that still starts with a valid
 * JPEG signature (FF D8 FF), so content-detection succeeds and the request
 * is rejected by the size rule rather than the content-mismatch check.
 */
function oversizeBuffer(bytes: number): Buffer {
  const buf = Buffer.alloc(bytes + 1, 0);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  return buf;
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

/** Minimal buffer with a valid PNG signature. */
function fakePngBuffer(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
  ]);
}

/** Minimal buffer with a valid WebP (RIFF....WEBP) signature. */
function fakeWebpBuffer(): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
  ]);
}

/** Minimal buffer with a valid WebM (EBML) signature. */
function fakeWebmBuffer(): Buffer {
  return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
}

/** Builds a single QuickTime/ISO-BMFF top-level atom: size(4) + type(4) + body. */
function makeAtom(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type.padEnd(4, ' '), 4, 4, 'ascii');
  return Buffer.concat([header, body]);
}

/**
 * A legacy QuickTime .mov with no leading ftyp box: a top-level atom of the
 * given type, followed by a real `mdat` atom — structurally valid, so the
 * on-disk atom walk finds the mdat and accepts it as quicktime.
 */
function fakeQuickTimeLegacyBuffer(atomType: string): Buffer {
  const leadingAtom = makeAtom(atomType);
  const mdatAtom = makeAtom('mdat', Buffer.from('fake mdat payload', 'ascii'));
  return Buffer.concat([leadingAtom, mdatAtom]);
}

/**
 * A bare `wide` atom (size 8, no body) immediately followed by arbitrary
 * HTML bytes with no valid atom structure — must be rejected: a recognized
 * atom NAME at offset 4 alone is not enough without a structurally valid
 * moov/mdat atom actually present.
 */
function fakeWideAtomFollowedByHtmlBuffer(): Buffer {
  return Buffer.concat([
    makeAtom('wide'),
    Buffer.from('<html><body>not a real atom</body></html>', 'utf8'),
  ]);
}

/** A `free` atom whose declared size is larger than the buffer actually is. */
function fakeOversizedFreeAtomBuffer(): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(10_000_000, 0); // declared size — far larger than this buffer
  header.write('free', 4, 4, 'ascii');
  return header; // only 8 bytes actually present
}

/**
 * Mimics a real legacy QuickTime .mov layout: a `wide` placeholder atom
 * (used by QuickTime for later in-place mdat expansion) followed by the
 * real ftyp/moov/mdat atoms. No binary .mov fixture is checked into the
 * repo, so this synthetic-but-structurally-realistic layout stands in for
 * "a wide box prepended to a real mov".
 */
function fakeLegacyQuickTimeMovieBuffer(): Buffer {
  const wideAtom = makeAtom('wide');
  const ftypAtom = makeAtom('ftyp', Buffer.concat([
    Buffer.from('qt  ', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('qt  ', 'ascii'),
  ]));
  const moovAtom = makeAtom('moov', Buffer.from('fake moov payload', 'ascii'));
  const mdatAtom = makeAtom('mdat', Buffer.from('fake mdat payload', 'ascii'));
  return Buffer.concat([wideAtom, ftypAtom, moovAtom, mdatAtom]);
}

/** An ISO-BMFF ftyp box whose major brand is 'qt  ' (QuickTime). */
function fakeQtBrandBuffer(): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x14]),
    Buffer.from('ftyp', 'ascii'),
    Buffer.from('qt  ', 'ascii'), // major brand
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // minor version
    Buffer.from('qt  ', 'ascii'), // compatible brand
  ]);
}

/**
 * An ISO-BMFF ftyp box whose major brand is 'avif', with 'mif1' as a
 * compatible brand — mif1/msf1 alone would look like HEIC, but the major
 * brand must take priority and exclude it as AVIF (not an allowed type).
 */
function fakeAvifBuffer(): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftyp', 'ascii'),
    Buffer.from('avif', 'ascii'), // major brand
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // minor version
    Buffer.from('mif1', 'ascii'), // compatible brand
  ]);
}

/**
 * An ftyp box declaring size==1 (64-bit largesize follows the type), with
 * an AVIF major brand placed at the REAL offset (16, after the largesize
 * field) — if detection naively read offset 8-12 as the major brand (as if
 * size were a normal 32-bit value) it would read the largesize's own bytes
 * instead and miss the avif brand entirely, letting it fall through to the
 * generic "any other ftyp brand -> mp4" case.
 */
function fakeFtypLargesizeBuffer(): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0); // size == 1 -> 64-bit largesize follows
  header.write('ftyp', 4, 4, 'ascii');
  header.writeUInt32BE(0, 8); // largesize high 32 bits
  header.writeUInt32BE(32, 12); // largesize low 32 bits
  return Buffer.concat([header, Buffer.from('avif', 'ascii'), Buffer.from([0, 0, 0, 0])]);
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

// Like setupInsertImage, but echoes back the REAL image_path/image_type the
// route passed to the INSERT — needed whenever a test asserts on the actual
// stored filename/extension (setupInsertImage's path is a fixed stub).
function setupInsertImageEcho(n = 1) {
  for (let i = 0; i < n; i++) {
    mockQuery.mockImplementationOnce((_sql: string, params: unknown[]) => {
      return Promise.resolve({
        rows: [{ id: `img${i}`, image_path: params[1], image_type: params[2], uploaded_by: params[3] }],
      });
    });
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/orders/:id/images — upload behaviour (RH-139)', () => {

  // ── 1. No file-count cap ──────────────────────────────────────────────────
  it('accepts 12 valid JPEG files in one request (under the 20-file cap)', async () => {
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

  it('rejects 21 files in one request (over the 20-file cap) and cleans up siblings', async () => {
    // No setupOrderFound() — LIMIT_FILE_COUNT fires during multipart parsing,
    // before the route handler runs.
    const jpg = tinyJpegBuffer();
    let req = request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('image_type', 'INTAKE');

    for (let i = 0; i < 21; i++) {
      req = req.attach('images', jpg, { filename: `photo${i}.jpg`, contentType: 'image/jpeg' });
    }

    const res = await req;
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Quá nhiều tệp trong một lần tải lên');
    // Sibling files already written before the 21st file tripped the limit
    // must not leak on disk.
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
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
    // Already-written file must be cleaned up, not orphaned.
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('returns 404 for a non-existent order and cleans up the already-written file', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // order not found

    const jpg = tinyJpegBuffer();
    const res = await request(app)
      .post('/api/orders/o99/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', jpg, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(404);
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('returns 403 for a caller without upload permission and cleans up the already-written file', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ created_by: 'u1' }] }); // order exists

    const jpg = tinyJpegBuffer();
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${viewerToken}`)
      .attach('images', jpg, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(403);
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
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
    expect(res.body.error).toMatch(/Định dạng tệp không hợp lệ/);
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

  it('rejects an unsupported video mimetype (video/x-msvideo) with 4xx error', async () => {
    const avi = Buffer.alloc(100, 0x41);
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', avi, { filename: 'clip.avi', contentType: 'video/x-msvideo' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Định dạng tệp không hợp lệ/);
  });

  it('rejects an unsupported document mimetype (application/pdf) with 4xx error', async () => {
    const pdf = Buffer.from('%PDF-1.4', 'utf8');
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', pdf, { filename: 'doc.pdf', contentType: 'application/pdf' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Định dạng tệp không hợp lệ/);
  });

  // ── 4. Oversized IMAGE (>10MB) → 400, files cleaned up (video max is 100MB) ─
  it('returns 400 when an image exceeds 10MB, and cleans up the file', async () => {
    setupOrderFound();

    const bigBuffer = oversizeBuffer(12 * 1024 * 1024); // 12MB image
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', bigBuffer, { filename: 'huge.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Ảnh quá lớn (tối đa 10MB mỗi ảnh)');
    // multer wrote the file to tmpDir; the route must delete it before responding
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  // ── 4b. Video accepted (up to 100MB, images stay capped at 10MB) ─────────
  it('accepts an MP4 video, stores it with a .mp4 extension, and does not call sharp', async () => {
    setupOrderFound();
    mockQuery.mockImplementationOnce((_sql: string, params: unknown[]) => {
      return Promise.resolve({
        rows: [{ id: 'img1', image_path: params[1], image_type: 'INTAKE', uploaded_by: 'u1' }],
      });
    });

    const videoBuf = fakeMp4Buffer();
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('image_type', 'INTAKE')
      .attach('images', videoBuf, { filename: 'clip.mov.exe', contentType: 'video/mp4' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const storedPath: string = res.body.data[0].image_path;
    // Extension must come from the mimetype map, not from the (misleading) originalname
    expect(storedPath).toMatch(/\.mp4$/);
    expect(sharpMock).not.toHaveBeenCalled();
  });

  it('rejects a file whose content does not match its declared mimetype (video/mp4)', async () => {
    setupOrderFound();
    // Declares video/mp4 but the content is plain HTML — passes fileFilter
    // (mimetype is allowed) but must fail the magic-byte signature check.
    const htmlBuf = Buffer.from('<html><body>not a video</body></html>', 'utf8');
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', htmlBuf, { filename: 'fake.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Nội dung tệp không khớp định dạng: fake.mp4');
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('rejects a JPEG-declared file whose content does not match (magic-byte check)', async () => {
    setupOrderFound();
    const notAJpeg = Buffer.from('this is not actually a jpeg', 'utf8');
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', notAJpeg, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nội dung tệp không khớp định dạng: photo.jpg');
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  // ── 5. HEIC conversion (REAL decode) ──────────────────────────────────────
  //
  // sharp's prebuilt libvips ships without the HEVC decoder, so HEIC is decoded
  // with heic-convert (pure JS / libde265 wasm), which is NOT mocked here. We
  // upload a real, tiny HEIC fixture (generated via macOS `sips`) and assert it
  // is decoded and stored as a .jpg. heic-convert works cross-platform (incl. CI),
  // so this is a genuine end-to-end conversion test.
  it('decodes a real HEIC fixture and stores it as a .jpg', async () => {
    const fixturePath = path.join(__dirname, '../fixtures/tiny.heic');
    const heicBuf = fs.readFileSync(fixturePath);

    setupOrderFound();
    mockQuery.mockImplementationOnce((_sql: string, params: unknown[]) => {
      return Promise.resolve({
        rows: [{ id: 'img1', image_path: params[1], image_type: 'INTAKE', uploaded_by: 'u1' }],
      });
    });

    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('image_type', 'INTAKE')
      .attach('images', heicBuf, { filename: 'tiny.heic', contentType: 'image/heic' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const storedPath: string = res.body.data[0].image_path;
    expect(storedPath).toMatch(/\.jpg$/);
    expect(storedPath).not.toMatch(/\.heic$/);
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

// ── Magic-byte signature check (per mimetype) ────────────────────────────────
describe('POST /api/orders/:id/images — magic-byte signature check', () => {
  it('accepts a PNG whose content matches its declared mimetype', async () => {
    setupOrderFound();
    setupInsertImage(1);
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', fakePngBuffer(), { filename: 'photo.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
  });

  it('accepts a WebP whose content matches its declared mimetype', async () => {
    setupOrderFound();
    setupInsertImage(1);
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', fakeWebpBuffer(), { filename: 'photo.webp', contentType: 'image/webp' });
    expect(res.status).toBe(201);
  });

  it('accepts a WebM video whose content matches its declared mimetype', async () => {
    setupOrderFound();
    setupInsertImage(1);
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', fakeWebmBuffer(), { filename: 'clip.webm', contentType: 'video/webm' });
    expect(res.status).toBe(201);
  });

  it('rejects a PNG-declared file whose content does not match', async () => {
    setupOrderFound();
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', Buffer.from('not a png'), { filename: 'photo.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nội dung tệp không khớp định dạng: photo.png');
  });

  it('rejects a WebP-declared file whose content does not match', async () => {
    setupOrderFound();
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', Buffer.from('not a webp'), { filename: 'photo.webp', contentType: 'image/webp' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nội dung tệp không khớp định dạng: photo.webp');
  });

  it('rejects a WebM-declared file whose content does not match', async () => {
    setupOrderFound();
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', Buffer.from('not webm'), { filename: 'clip.webm', contentType: 'video/webm' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nội dung tệp không khớp định dạng: clip.webm');
  });

  it('rejects an HTML payload declared as video/mp4', async () => {
    setupOrderFound();
    const htmlBuf = Buffer.from('<html><body>gotcha</body></html>', 'utf8');
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', htmlBuf, { filename: 'video.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nội dung tệp không khớp định dạng: video.mp4');
  });
});

// ── Content detection (declared mimetype can lie — RH-video-fix) ────────────
// Browsers set Content-Type from the file EXTENSION, not the content, so
// real-world photos/videos routinely arrive with a "wrong" extension (a
// PNG/WebP/HEIC saved as .jpg by a messaging app, or a legacy QuickTime .mov
// with no leading ftyp box). The server must classify by CONTENT and store
// under the correct extension, not reject these as a content mismatch.
describe('POST /api/orders/:id/images — content detection overrides a misleading declared mimetype', () => {
  it('accepts a PNG saved with a .jpg extension (declared image/jpeg) and stores it as .png', async () => {
    setupOrderFound();
    setupInsertImageEcho(1);
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', fakePngBuffer(), { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    const storedPath: string = res.body.data[0].image_path;
    expect(storedPath).toMatch(/\.png$/);
  });

  it('compresses an oversized PNG (declared image/jpeg) with sharp .png(), keeping the .png extension', async () => {
    setupOrderFound();
    setupInsertImageEcho(1);
    // >2MB (triggers compression) but comfortably under the 10MB image cap.
    const bigPng = Buffer.concat([fakePngBuffer(), Buffer.alloc(3 * 1024 * 1024, 0)]);
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', bigPng, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    const storedPath: string = res.body.data[0].image_path;
    expect(storedPath).toMatch(/\.png$/);
    expect(sharpMock).toHaveBeenCalled();
    const sharpChain = sharpMock.mock.results[sharpMock.mock.results.length - 1].value;
    expect(sharpChain.png).toHaveBeenCalled();
    // quality alone does nothing for a non-palette PNG — compressionLevel
    // and adaptiveFiltering are what actually shrink it.
    expect(sharpChain.png).toHaveBeenCalledWith({ compressionLevel: 9, adaptiveFiltering: true });
    expect(sharpChain.jpeg).not.toHaveBeenCalled();
  });

  it('accepts a HEIC saved with a .jpg extension (declared image/jpeg) and converts it via heic-convert', async () => {
    const fixturePath = path.join(__dirname, '../fixtures/tiny.heic');
    const heicBuf = fs.readFileSync(fixturePath);

    setupOrderFound();
    mockQuery.mockImplementationOnce((_sql: string, params: unknown[]) => {
      return Promise.resolve({
        rows: [{ id: 'img1', image_path: params[1], image_type: 'INTAKE', uploaded_by: 'u1' }],
      });
    });

    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', heicBuf, { filename: 'tiny.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    const storedPath: string = res.body.data[0].image_path;
    expect(storedPath).toMatch(/\.jpg$/);
  });

  it('accepts a WebP saved with a .jpg extension (declared image/jpeg) and stores it as .webp', async () => {
    setupOrderFound();
    setupInsertImageEcho(1);
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', fakeWebpBuffer(), { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    const storedPath: string = res.body.data[0].image_path;
    expect(storedPath).toMatch(/\.webp$/);
  });

  it('accepts a legacy QuickTime .mov with a leading "wide" atom (no ftyp box)', async () => {
    setupOrderFound();
    setupInsertImageEcho(1);
    const movBuf = fakeQuickTimeLegacyBuffer('wide');
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', movBuf, { filename: 'clip.mov', contentType: 'video/quicktime' });

    expect(res.status).toBe(201);
    const storedPath: string = res.body.data[0].image_path;
    expect(storedPath).toMatch(/\.mov$/);
  });

  it.each(['mdat', 'moov', 'free'])('accepts a legacy QuickTime .mov with a leading "%s" atom', async (atom) => {
    setupOrderFound();
    setupInsertImageEcho(1);
    const movBuf = fakeQuickTimeLegacyBuffer(atom);
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', movBuf, { filename: 'clip.mov', contentType: 'video/quicktime' });

    expect(res.status).toBe(201);
    const storedPath: string = res.body.data[0].image_path;
    expect(storedPath).toMatch(/\.mov$/);
  });

  it('rejects a bare "wide" atom followed by HTML (no real moov/mdat atom present)', async () => {
    setupOrderFound();
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', fakeWideAtomFollowedByHtmlBuffer(), { filename: 'clip.mov', contentType: 'video/quicktime' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nội dung tệp không khớp định dạng: clip.mov');
  });

  it('rejects a "free" atom whose declared size is larger than the file', async () => {
    setupOrderFound();
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', fakeOversizedFreeAtomBuffer(), { filename: 'clip.mov', contentType: 'video/quicktime' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nội dung tệp không khớp định dạng: clip.mov');
  });

  it('rejects a file whose walked atoms never include a moov/mdat (exhausts the walk limit)', async () => {
    setupOrderFound();
    // Four valid-but-uninteresting atoms, no moov/mdat among them.
    const buf = Buffer.concat([
      makeAtom('free'), makeAtom('skip'), makeAtom('pnot'), makeAtom('junk'),
    ]);
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', buf, { filename: 'clip.mov', contentType: 'video/quicktime' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nội dung tệp không khớp định dạng: clip.mov');
  });

  it('accepts a legacy mov whose mdat is the 6th top-level atom (within the walk limit)', async () => {
    setupOrderFound();
    setupInsertImageEcho(1);
    const buf = Buffer.concat([
      makeAtom('wide'), makeAtom('free'), makeAtom('skip'), makeAtom('uuid'), makeAtom('junk'),
      makeAtom('mdat', Buffer.from('fake mdat payload', 'ascii')),
    ]);
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', buf, { filename: 'clip.mov', contentType: 'video/quicktime' });

    expect(res.status).toBe(201);
    expect(res.body.data[0].image_path).toMatch(/\.mov$/);
  });

  it('rejects a legacy mov whose first mdat/moov lies beyond the 8-atom walk limit', async () => {
    setupOrderFound();
    const leading = ['wide', 'free', 'skip', 'uuid', 'junk', 'free', 'skip', 'wide'].map((t) => makeAtom(t));
    const buf = Buffer.concat([...leading, makeAtom('mdat', Buffer.from('fake mdat payload', 'ascii'))]);
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', buf, { filename: 'clip.mov', contentType: 'video/quicktime' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nội dung tệp không khớp định dạng: clip.mov');
  });

  it('accepts a "wide" box prepended to a real mov-style layout (ftyp/moov/mdat)', async () => {
    setupOrderFound();
    setupInsertImageEcho(1);
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', fakeLegacyQuickTimeMovieBuffer(), { filename: 'clip.mov', contentType: 'video/quicktime' });

    expect(res.status).toBe(201);
    const storedPath: string = res.body.data[0].image_path;
    expect(storedPath).toMatch(/\.mov$/);
  });

  it('accepts an MP4 declared video/mp4 whose ftyp brand is "qt  " (classified as quicktime, stored as .mov)', async () => {
    setupOrderFound();
    setupInsertImageEcho(1);
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', fakeQtBrandBuffer(), { filename: 'clip.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(201);
    const storedPath: string = res.body.data[0].image_path;
    expect(storedPath).toMatch(/\.mov$/);
  });

  it('rejects an AVIF file (ftyp brand avif) even though mif1/msf1 overlap with HEIC', async () => {
    setupOrderFound();
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', fakeAvifBuffer(), { filename: 'photo.avif', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nội dung tệp không khớp định dạng: photo.avif');
  });

  it('rejects an ftyp box with a 64-bit largesize (size==1) outright, even when it would otherwise be AVIF', async () => {
    setupOrderFound();
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', fakeFtypLargesizeBuffer(), { filename: 'weird.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nội dung tệp không khớp định dạng: weird.mp4');
  });

  it('rejects a JPEG over 10MB declared as video/mp4 as an oversized image (detects by content first)', async () => {
    setupOrderFound();
    const bigJpeg = oversizeBuffer(10 * 1024 * 1024); // JPEG-signed, >10MB, well under the 100MB video cap
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', bigJpeg, { filename: 'huge.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Ảnh quá lớn (tối đa 10MB mỗi ảnh)');
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  // A raw control character embedded directly in a multipart filename=
  // parameter is invalid at the HTTP layer (busboy aborts the parse before
  // our route code ever runs) — so sanitizeOriginalFilename is exercised as
  // a direct unit test instead of round-tripping through a real upload.
  it('sanitizeOriginalFilename strips control characters', () => {
    expect(sanitizeOriginalFilename('evil\x00\x01\x1f.jpg\x7f')).toBe('evil.jpg');
  });

  it('caps a very long originalname at 100 characters in the error message', async () => {
    setupOrderFound();
    const notAJpeg = Buffer.from('not actually a jpeg', 'utf8');
    const longName = `${'a'.repeat(150)}.jpg`;
    const res = await request(app)
      .post('/api/orders/o1/images')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('images', notAJpeg, { filename: longName, contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    const prefix = 'Nội dung tệp không khớp định dạng: ';
    expect(res.body.error.startsWith(prefix)).toBe(true);
    expect(res.body.error.length - prefix.length).toBeLessThanOrEqual(100);
  });

  it('sanitizeOriginalFilename strips Unicode bidi/format characters (spoofing chars)', () => {
    // ZWSP, LRM/RLM, LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI, BOM
    const dirty =
      'evil​‌‍‎‏' +
      '‪‫‬‭‮' +
      '⁦⁧⁨⁩' +
      '﻿.jpg';
    expect(sanitizeOriginalFilename(dirty)).toBe('evil.jpg');
  });

  it('sanitizeOriginalFilename truncates without splitting a surrogate pair', () => {
    // 😀 (U+1F600) is a single code point encoded as a UTF-16 surrogate
    // pair. Place it exactly at the 100-code-point boundary so a naive
    // UTF-16-based slice(0, 100) would cut it in half and produce an
    // unpaired (invalid) surrogate.
    const name = `${'a'.repeat(99)}😀${'b'.repeat(20)}`;
    const result = sanitizeOriginalFilename(name);
    expect(Array.from(result)).toHaveLength(100);
    expect(result).toBe(`${'a'.repeat(99)}😀`);
    // No lone surrogate half left behind
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('returns an error (not a throw) and cleans up when renaming the detected file fails', async () => {
    setupOrderFound();
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('simulated rename failure');
    });
    try {
      // A PNG saved with a .jpg extension needs a rename to .png after detection.
      const res = await request(app)
        .post('/api/orders/o1/images')
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('images', fakePngBuffer(), { filename: 'photo.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Không thể xử lý tệp đã tải lên, vui lòng thử lại');
      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    } finally {
      renameSpy.mockRestore();
    }
  });
});
