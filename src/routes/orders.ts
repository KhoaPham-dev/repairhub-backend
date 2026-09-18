import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { QueryResult } from 'pg';
import { pool } from '../config/database';
import { authenticate } from '../middleware/auth';
import { logActivity } from '../utils/activityLog';
import { asyncHandler } from '../utils/asyncHandler';
import { deleteUploadedFiles, discardUploadedFiles } from '../utils/uploadCleanup';

const router = Router();
router.use(authenticate);

const uploadDir = process.env.UPLOAD_DIR || 'uploads';
fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const ALLOWED_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const ALLOWED_MIME_TYPES = new Set<string>([...ALLOWED_IMAGE_MIME_TYPES, ...ALLOWED_VIDEO_MIME_TYPES]);
const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif']);
const VALID_IMAGE_TYPES = new Set(['INTAKE', 'COMPLETION']);

// Stored filename extension is derived from the verified mimetype (never from
// the client-supplied originalname, which is untrusted and can be spoofed).
const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heic',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB — enforced per-file, after multer, image-only
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100MB — multer's single request-wide fileSize cap
const OVERSIZED_IMAGE_MESSAGE = 'Ảnh quá lớn (tối đa 10MB mỗi ảnh)';
const INVALID_FILE_CONTENT_MESSAGE = 'Nội dung tệp không khớp định dạng';
const FILE_PROCESSING_ERROR_MESSAGE = 'Không thể xử lý tệp đã tải lên, vui lòng thử lại';

// Per-route file-count caps (multer `limits.files`). Named so the intent is
// clear at each createMediaUpload() call site; LIMIT_FILE_COUNT is mapped to
// a friendly message in errorHandler.ts.
const IMAGES_MAX_FILES = 20; // POST /:id/images
const BULK_IMAGES_MAX_FILES = 50; // POST /bulk-with-images (N products × images each)
const WARRANTY_MAX_FILES = 10; // POST /warranty-claim

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = MIME_EXTENSIONS[file.mimetype] || '';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

// Shared multer config factory for all order media uploads (images + video).
// multer only supports one request-wide fileSize limit, so it is set to the
// video max (MAX_VIDEO_SIZE); images are individually re-checked against
// MAX_IMAGE_SIZE after multer has parsed the request (see validateUploadedFiles).
// `files` is the one real per-route difference — each route passes its own cap.
function createMediaUpload(options: { files: number }) {
  return multer({
    storage,
    limits: {
      fileSize: MAX_VIDEO_SIZE,
      files: options.files,
    },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
        cb(null, true);
      } else {
        const e = new Error('Định dạng tệp không hợp lệ') as Error & { status?: number };
        e.status = 400;
        cb(e);
      }
    },
  });
}

const upload = createMediaUpload({ files: IMAGES_MAX_FILES });
const warrantyUpload = createMediaUpload({ files: WARRANTY_MAX_FILES });

// Reads up to the first 64 bytes of a file already written to disk by
// multer — enough for a JPEG/PNG/WebP/WebM signature, or an ISO-BMFF ftyp
// box's major brand plus several compatible brands (each brand is 4 bytes,
// starting at offset 16).
const HEADER_READ_BYTES = 64;
function readFileHeader(filePath: string): Buffer {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(HEADER_READ_BYTES);
      const bytesRead = fs.readSync(fd, header, 0, HEADER_READ_BYTES, 0);
      return header.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return Buffer.alloc(0);
  }
}

const HEIC_ISOBMFF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
const QUICKTIME_LEGACY_ATOMS = new Set(['wide', 'mdat', 'moov', 'free', 'skip', 'pnot']);
// Recognized top-level QuickTime/ISO-BMFF atom types for the legacy-.mov
// file-structure walk (isLegacyQuickTimeFile). 'uuid' and 'junk' are
// included alongside the standard set since some encoders emit them as
// filler/extension atoms before the real moov/mdat payload.
const QUICKTIME_ATOM_TYPES = new Set([
  'ftyp', 'wide', 'free', 'skip', 'mdat', 'moov', 'pnot', 'uuid', 'junk',
]);
// Real QuickTime files put mdat/moov within the first 2-3 top-level atoms;
// 8 leaves headroom for a few leading wide/free/skip/uuid boxes while still
// bounding the work done per upload.
const MAX_QUICKTIME_ATOMS_TO_WALK = 8;

// Reads the ISO-BMFF ftyp box's major brand plus its compatible brands
// (4 bytes each, from offset 16 up to the box's own declared size or the
// end of the header we have on hand — whichever is smaller).
function readIsoBmffBrands(header: Buffer): string[] {
  const majorBrand = header.length >= 12 ? header.toString('ascii', 8, 12) : '';
  const brands = [majorBrand];
  const boxSize = header.length >= 4 ? header.readUInt32BE(0) : 0;
  const end = Math.min(header.length, boxSize > 0 ? boxSize : header.length);
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    brands.push(header.toString('ascii', offset, offset + 4));
  }
  return brands.map((b) => b.toLowerCase());
}

// Walks up to MAX_QUICKTIME_ATOMS_TO_WALK top-level QuickTime/ISO-BMFF atoms
// directly from the file on disk (not limited to the small in-memory
// header), to distinguish a genuine legacy QuickTime .mov (no leading ftyp
// box) from an arbitrary file that merely happens to have a recognized atom
// NAME at offset 4 with garbage after it — e.g. `00000008 'wide' <HTML>`
// must NOT be accepted just because byte 4-8 spells "wide".
//
// Each atom's declared size is validated (>=8, size==1 uses the 64-bit
// largesize that follows the type, size==0 means "extends to end of file"
// — which is only meaningful for the atom actually at EOF, and the offset
// arithmetic here naturally treats it as such) and its type must be a
// known QuickTime/ISO atom. The walk only succeeds — i.e. the file is
// accepted as video/quicktime — once a structurally valid `moov` or `mdat`
// atom is found among the walked atoms.
function isLegacyQuickTimeFile(filePath: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return false;
  }

  try {
    const fileSize = fs.fstatSync(fd).size;
    let offset = 0;
    const atomHeader = Buffer.alloc(16); // size(4) + type(4) + largesize(8, if size==1)

    for (let i = 0; i < MAX_QUICKTIME_ATOMS_TO_WALK && offset < fileSize; i++) {
      if (offset + 8 > fileSize) return false; // not enough room left for a basic atom header
      const bytesRead = fs.readSync(fd, atomHeader, 0, 16, offset);
      if (bytesRead < 8) return false;

      const declaredSize = atomHeader.readUInt32BE(0);
      const type = atomHeader.toString('ascii', 4, 8);
      let size: number;

      if (declaredSize === 1) {
        if (bytesRead < 16) return false;
        const largesizeHigh = atomHeader.readUInt32BE(8);
        const largesizeLow = atomHeader.readUInt32BE(12);
        // A largesize this big can't be a real atom in a file we can even
        // stat the size of — treat as structurally invalid.
        if (largesizeHigh !== 0 || largesizeLow > fileSize) return false;
        size = largesizeLow;
      } else if (declaredSize === 0) {
        // "Extends to end of file" — by construction this makes the atom
        // the last one walked, since offset + size will equal fileSize.
        size = fileSize - offset;
      } else {
        size = declaredSize;
      }

      if (size < 8 || offset + size > fileSize) return false;
      if (!QUICKTIME_ATOM_TYPES.has(type)) return false;
      if (type === 'moov' || type === 'mdat') return true;

      offset += size;
    }

    return false;
  } catch {
    return false;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

// Detects the real media type from magic bytes / ISO-BMFF box structure,
// independent of the declared mimetype. Browsers set Content-Type from the
// file EXTENSION, not the content — real-world photos/videos routinely have
// the "wrong" extension (a PNG/WebP/HEIC saved as .jpg by a messaging app,
// or a legacy QuickTime .mov with no leading ftyp box). Returns one of the
// allowed mimetypes, or null if the content doesn't match any of them.
function detectMediaType(header: Buffer, filePath: string): string | null {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg';
  }
  if (header.length >= 8 &&
      header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47 &&
      header[4] === 0x0d && header[5] === 0x0a && header[6] === 0x1a && header[7] === 0x0a) {
    return 'image/png';
  }
  if (header.length >= 12 &&
      header.toString('ascii', 0, 4) === 'RIFF' &&
      header.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (header.length >= 4 &&
      header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) {
    return 'video/webm';
  }

  if (header.length >= 8) {
    const atomType = header.toString('ascii', 4, 8);
    if (atomType === 'ftyp') {
      const boxSize = header.length >= 4 ? header.readUInt32BE(0) : 0;
      // size==1 means the real box size is a 64-bit "largesize" that
      // follows the type, which shifts the major-brand field further into
      // the box — reading offset 8-12 as-is in that case would read the
      // largesize's own bytes, not the brand, and could let a disallowed
      // brand (e.g. AVIF) slip through as an unrecognized-but-accepted mp4.
      // No real encoder emits a 64-bit ftyp box; reject outright.
      if (boxSize === 1) return null;
      const majorBrand = header.length >= 12 ? header.toString('ascii', 8, 12).toLowerCase() : '';
      // mif1/msf1 are shared with AVIF, which isn't an allowed type — the
      // major brand (not a compatible brand) is what actually identifies a
      // file as AVIF, so exclude on that alone.
      if (majorBrand === 'avif' || majorBrand === 'avis') return null;
      const brands = readIsoBmffBrands(header);
      if (brands.some((b) => HEIC_ISOBMFF_BRANDS.has(b))) return 'image/heic';
      if (majorBrand === 'qt  ') return 'video/quicktime';
      // Any other ftyp brand (isom, mp41, mp42, avc1, M4V , 3gp*, dash, ...)
      return 'video/mp4';
    }
    // Legacy QuickTime .mov files can lead with a non-ftyp top-level atom.
    // A bare 4-byte type match at this offset is not enough on its own
    // (e.g. `00000008 'wide' <HTML>` must not pass) — walk the actual atom
    // structure on disk to confirm it's really a QuickTime file.
    if (QUICKTIME_LEGACY_ATOMS.has(atomType) && isLegacyQuickTimeFile(filePath)) {
      return 'video/quicktime';
    }
  }

  return null;
}

// Strips control characters and Unicode bidi/format characters (which can
// be used to visually spoof a filename — e.g. right-to-left overrides) and
// caps the length before an attacker-controlled originalname is echoed back
// to the client. Truncates by Unicode code point (via Array.from) rather
// than by UTF-16 code unit, so a surrogate pair is never split in half.
// Built via `new RegExp` from explicit \u escapes (rather than a /.../ regex
// literal) so the source file never contains the actual invisible/bidi
// characters themselves — only their escaped, reviewable code points.
const FILENAME_STRIP_PATTERN = new RegExp(
  '[\\x00-\\x1f\\x7f' + // ASCII control characters
  '\\u200B-\\u200F' + // zero-width space/joiners, LRM/RLM
  '\\u202A-\\u202E' + // LRE/RLE/PDF/LRO/RLO (bidi embedding/override)
  '\\u2066-\\u2069' + // LRI/RLI/FSI/PDI (bidi isolates)
  '\\uFEFF' + // BOM / zero-width no-break space
  ']',
  'g'
);
const FILENAME_MAX_CODEPOINTS = 100;

export function sanitizeOriginalFilename(name: string): string {
  const stripped = (name || '').replace(FILENAME_STRIP_PATTERN, '');
  const codePoints = Array.from(stripped);
  return codePoints.length > FILENAME_MAX_CODEPOINTS
    ? codePoints.slice(0, FILENAME_MAX_CODEPOINTS).join('')
    : stripped;
}

// Runs ALL post-multer file validation before any DB write: detects the
// real media type of each file from its content (see detectMediaType), then
// applies the size rule using the DETECTED kind (not the declared
// mimetype) — order matters, e.g. a large file declared video/mp4 whose
// content is actually a JPEG must be rejected as an oversized image, not
// waved through as an (unlimited-size) video. When the detected type's
// extension differs from what multer wrote initially (because the
// declared mimetype was wrong), the file is renamed on disk and
// file.filename/file.mimetype are updated in place so every downstream
// consumer (storeUploadedMedia, the DB insert) uses the verified type.
// On the first failure, deletes every file already written for this
// request and returns the error message to send; returns null when every
// file passes. Videos are already bounded by multer's fileSize limit
// (MAX_VIDEO_SIZE) and are not size-checked here.
function validateUploadedFiles(files: Express.Multer.File[]): string | null {
  for (const f of files) {
    const filePath = path.join(uploadDir, f.filename);
    const header = readFileHeader(filePath);
    const detectedType = detectMediaType(header, filePath);
    if (!detectedType) {
      deleteUploadedFiles(files);
      return `${INVALID_FILE_CONTENT_MESSAGE}: ${sanitizeOriginalFilename(f.originalname)}`;
    }

    if (ALLOWED_IMAGE_MIME_TYPES.has(detectedType) && f.size > MAX_IMAGE_SIZE) {
      deleteUploadedFiles(files);
      return OVERSIZED_IMAGE_MESSAGE;
    }

    const detectedExt = MIME_EXTENSIONS[detectedType];
    const currentExt = path.extname(f.filename);
    if (detectedExt && detectedExt !== currentExt) {
      const newFilename = `${path.basename(f.filename, currentExt)}${detectedExt}`;
      const newPath = path.join(uploadDir, newFilename);
      try {
        fs.renameSync(filePath, newPath);
      } catch {
        // Delete every file from the request — files array entries already
        // processed in this loop have their .filename mutated to the NEW
        // name, so deleteUploadedFiles naturally targets the right path
        // for those; this (failed) file and any not-yet-processed ones are
        // still under their original names.
        deleteUploadedFiles(files);
        return FILE_PROCESSING_ERROR_MESSAGE;
      }
      f.filename = newFilename;
      f.path = newPath;
    }
    f.mimetype = detectedType;
  }
  return null;
}

const STATUS_FLOW = [
  'TIEP_NHAN', 'DANG_KIEM_TRA', 'BAO_GIA',
  'DANG_SUA_CHUA', 'SUA_XONG', 'DA_GIAO',
  'TRA_HANG', 'HUY_TRA_MAY',
];
const TERMINAL_STATUSES = ['DA_GIAO', 'HUY_TRA_MAY'];
// Statuses that require both non-empty notes and a fresh COMPLETION photo
// (taken after the order's most recent real status transition) as evidence
// before the transition is allowed.
const EVIDENCE_REQUIRED_STATUSES = ['DA_GIAO', 'HUY_TRA_MAY'];

// A source order may have multiple warranty orders: <src>-BH, <src>-BH2,
// <src>-BH3, ... A warranty order's code always ends with this suffix, and a
// warranty order cannot itself be the source of another warranty claim.
const WARRANTY_CODE_SUFFIX_RE = /-BH\d*$/;

// Compute year + YYYYMMDD in Asia/Ho_Chi_Minh (UTC+7) so the annual reset
// and the date prefix match the operator's calendar, not the server clock.
// 'sv-SE' locale yields ISO-like output ("2026-05-05 14:30:00") which is easy
// to slice without locale surprises.
export function vnDateParts(d: Date = new Date()): { year: number; ymd: string } {
  const iso = d.toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
  const [year, month, day] = iso.split(' ')[0].split('-');
  return { year: Number(year), ymd: `${year}${month}${day}` };
}

// Reserve the next sequence value atomically. The INSERT ... ON CONFLICT
// DO UPDATE RETURNING pattern serializes concurrent writers via row-level
// locking on the matching counter row. See ADR-0004.
export async function generateOrderCode(now: Date = new Date()): Promise<string> {
  const { year, ymd } = vnDateParts(now);
  const result = await pool.query<{ last_issued: number }>(
    `INSERT INTO order_code_counters (year, last_issued)
     VALUES ($1, 0)
     ON CONFLICT (year) DO UPDATE
     SET last_issued = order_code_counters.last_issued + 1,
         updated_at = NOW()
     RETURNING last_issued`,
    [year]
  );
  const seq = String(result.rows[0].last_issued).padStart(5, '0');
  return `${ymd}-${seq}`;
}

// Escape SQL LIKE wildcards (%, _) so a literal order code can be embedded
// in a LIKE pattern without being interpreted as a wildcard.
function escapeLikeWildcards(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

// Escape regex metacharacters so a literal order code can be embedded in a
// RegExp pattern safely.
function escapeRegExpChars(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Compute the next warranty code for a given source order code. A source may
// have multiple warranty orders: <src>-BH (first), <src>-BH2, <src>-BH3, ...
// The LIKE query narrows candidates (best-effort, wildcards escaped); the
// exact regex is the authority that decides which rows actually match, so a
// coincidentally similar order code (e.g. a different source with a shared
// prefix) can never inflate the count.
async function nextWarrantyCode(sourceCode: string): Promise<string> {
  const likePattern = `${escapeLikeWildcards(sourceCode)}-BH%`;
  const existing = await pool.query<{ order_code: string }>(
    'SELECT order_code FROM orders WHERE order_code LIKE $1',
    [likePattern]
  );
  const exactRe = new RegExp(`^${escapeRegExpChars(sourceCode)}-BH(\\d*)$`);
  let maxN = 0;
  for (const row of existing.rows) {
    const match = exactRe.exec(row.order_code);
    if (!match) continue;
    let n: number;
    if (match[1] === '') {
      n = 1;
    } else {
      const parsed = Number(match[1]);
      // A malformed/out-of-range explicit suffix (not a safe integer, or an
      // explicit number below 2 — the bare "-BH" is always the implicit 1)
      // is treated as a non-match rather than coerced, so it can never
      // silently poison the numbering.
      if (!Number.isSafeInteger(parsed) || parsed < 2) continue;
      n = parsed;
    }
    if (n > maxN) maxN = n;
  }
  return maxN === 0 ? `${sourceCode}-BH` : `${sourceCode}-BH${maxN + 1}`;
}

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const { status, exclude_status, branch_id, search, sort = 'desc', limit = '20', offset = '0' } = req.query;
  const params: unknown[] = [];
  let where = 'WHERE 1=1';

  if (status) { params.push(status); where += ` AND o.status = $${params.length}`; }
  // exclude_status: comma-separated list of statuses to exclude.
  // FE uses this on the "Tất cả" tab to hide terminal orders (DA_GIAO, HUY_TRA_MAY).
  if (exclude_status) {
    const excludeList = String(exclude_status).split(',').map((s) => s.trim()).filter(Boolean);
    if (excludeList.length > 0) {
      const placeholders = excludeList.map((s) => { params.push(s); return `$${params.length}`; }).join(',');
      where += ` AND o.status NOT IN (${placeholders})`;
    }
  }
  if (branch_id) { params.push(branch_id); where += ` AND o.branch_id = $${params.length}`; }
  if (search) {
    params.push(`%${search}%`);
    // Searches: customer phone/name, serial/IMEI, order code, AND device name.
    where += ` AND (c.phone ILIKE $${params.length} OR o.serial_imei ILIKE $${params.length} OR o.order_code ILIKE $${params.length} OR c.name ILIKE $${params.length} OR o.device_name ILIKE $${params.length})`;
  }

  const orderDir = sort === 'asc' ? 'ASC' : 'DESC';
  params.push(Math.min(Number(limit), 100));
  params.push(Number(offset));

  const result = await pool.query(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone,
            b.name AS branch_name,
            u.full_name AS created_by_name,
            (SELECT json_agg(json_build_object('id', oi.id, 'image_path', oi.image_path, 'image_type', oi.image_type))
             FROM order_images oi WHERE oi.order_id = o.id) AS images
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN branches b ON b.id = o.branch_id
     JOIN users u ON u.id = o.created_by
     ${where}
     ORDER BY o.created_at ${orderDir}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const rows = result.rows.map((order) => {
    let priority: 'MEDIUM' | 'HIGH' | null = null;
    if (!TERMINAL_STATUSES.includes(order.status)) {
      const ageDays = (Date.now() - new Date(order.created_at).getTime()) / 86400000;
      if (ageDays >= 5) priority = 'HIGH';
      else if (ageDays >= 3) priority = 'MEDIUM';
    }
    return { ...order, priority };
  });

  res.json({ success: true, data: rows, error: null });
}));

router.get('/status-counts', asyncHandler(async (req: Request, res: Response) => {
  const { period } = req.query as { period?: string };

  let whereClause = '';
  if (period === 'today') {
    whereClause = `WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'`;
  } else if (period === 'week') {
    whereClause = `WHERE created_at >= date_trunc('week', CURRENT_DATE) AND created_at < date_trunc('week', CURRENT_DATE) + INTERVAL '7 days'`;
  } else if (period === 'month') {
    whereClause = `WHERE created_at >= date_trunc('month', CURRENT_DATE) AND created_at < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'`;
  }

  const result = await pool.query(
    `SELECT status, COUNT(*) AS count FROM orders ${whereClause} GROUP BY status`
  );
  const counts: Record<string, number> = {};
  for (const r of result.rows) counts[r.status] = Number(r.count);
  res.json({ success: true, data: counts, error: null });
}));

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const {
    customer_id, branch_id, product_type, device_name, serial_imei,
    accessories, fault_description, quotation, warranty_period_months,
  } = req.body as {
    customer_id: string; branch_id: string; product_type: string;
    device_name: string; serial_imei?: string; accessories?: string;
    fault_description: string; quotation: number; warranty_period_months?: number;
  };

  if (!customer_id || !branch_id || !product_type || !device_name || !fault_description) {
    res.status(400).json({ success: false, data: null, error: 'Thiếu thông tin bắt buộc' });
    return;
  }

  const orderCode = await generateOrderCode();
  const result = await pool.query(
    `INSERT INTO orders
       (order_code, customer_id, branch_id, created_by, product_type, device_name,
        serial_imei, accessories, fault_description, quotation, warranty_period_months)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [orderCode, customer_id, branch_id, req.user!.id, product_type,
     device_name, serial_imei || null, accessories || null, fault_description, quotation || 0,
     warranty_period_months || 3]
  );

  await pool.query(
    `INSERT INTO order_status_history (order_id, changed_by, new_status) VALUES ($1,$2,$3)`,
    [result.rows[0].id, req.user!.id, 'TIEP_NHAN']
  );
  await logActivity(req.user!.id, 'CREATE_ORDER', 'order', result.rows[0].id);
  res.status(201).json({ success: true, data: result.rows[0], error: null });
}));

router.post('/warranty-claim', warrantyUpload.any(), asyncHandler(async (req: Request, res: Response) => {
  const { source_order_id, branch_id, fault_description } = req.body as {
    source_order_id: string; branch_id: string; fault_description?: string;
  };

  if (!source_order_id || !branch_id) {
    discardUploadedFiles(req);
    res.status(400).json({ success: false, data: null, error: 'Thiếu thông tin bắt buộc' });
    return;
  }

  // Validate every attached file (size + signature) before touching the DB
  // at all, so a rejected upload never leaves an orphan warranty order.
  const files = (req.files as Express.Multer.File[]) || [];
  const validationError = validateUploadedFiles(files);
  if (validationError) {
    res.status(400).json({ success: false, data: null, error: validationError });
    return;
  }

  // Load source order
  const src = await pool.query('SELECT * FROM orders WHERE id = $1', [source_order_id]);
  if (!src.rows[0]) {
    discardUploadedFiles(req);
    res.status(404).json({ success: false, data: null, error: 'Không tìm thấy đơn gốc' });
    return;
  }

  const sourceOrder = src.rows[0];

  // A warranty order cannot itself be the source of another warranty claim.
  if (sourceOrder.product_type === 'BAO_HANH' || WARRANTY_CODE_SUFFIX_RE.test(sourceOrder.order_code)) {
    discardUploadedFiles(req);
    res.status(400).json({ success: false, data: null, error: 'Không thể tạo bảo hành cho đơn bảo hành' });
    return;
  }

  // Create the BH order, its history row, and any attached images/videos in
  // a single transaction (mirrors /bulk-with-images) so a mid-way DB failure
  // never leaves an orphan warranty order without its evidence, and every
  // written file is removed on rollback. A source order may already have
  // prior warranty orders (-BH, -BH2, ...); compute the next code, retrying
  // via SAVEPOINT (a failed statement aborts the rest of an open Postgres
  // transaction, so a plain retry within the same transaction would not
  // work) on a unique-constraint race with a concurrent claim for the same
  // source.
  const MAX_CODE_ATTEMPTS = 3;
  let bhCode = await nextWarrantyCode(sourceOrder.order_code);
  const client = await pool.connect();
  const writtenFiles: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let newOrder: any;

  try {
    await client.query('BEGIN');

    let result: QueryResult | undefined;
    for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
      await client.query('SAVEPOINT warranty_code_attempt');
      try {
        result = await client.query(
          `INSERT INTO orders
             (order_code, customer_id, branch_id, created_by, product_type, device_name,
              serial_imei, fault_description, quotation, warranty_period_months, status)
           VALUES ($1,$2,$3,$4,'BAO_HANH',$5,$6,$7,0,$8,'DANG_BAO_HANH')
           RETURNING *`,
          [bhCode, sourceOrder.customer_id, branch_id, req.user!.id,
           sourceOrder.device_name, sourceOrder.serial_imei,
           fault_description || 'Bảo hành thiết bị', sourceOrder.warranty_period_months || 12]
        );
        break;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT warranty_code_attempt');
        if ((err as { code?: string }).code === '23505' && attempt < MAX_CODE_ATTEMPTS) {
          bhCode = await nextWarrantyCode(sourceOrder.order_code);
          continue;
        }
        throw err;
      }
    }
    newOrder = result!.rows[0];

    await client.query(
      `INSERT INTO order_status_history (order_id, changed_by, new_status, notes)
       VALUES ($1,$2,'DANG_BAO_HANH',$3)`,
      [newOrder.id, req.user!.id, fault_description || null]
    );

    // Process and insert images/videos for this warranty order
    for (const file of files) {
      const finalFilename = await storeUploadedMedia(file);
      writtenFiles.push(path.join(uploadDir, finalFilename));
      await client.query(
        `INSERT INTO order_images (order_id, image_path, image_type, uploaded_by)
         VALUES ($1,$2,'INTAKE',$3)`,
        [newOrder.id, finalFilename, req.user!.id]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // Best-effort cleanup of any files written before the failure
    for (const filePath of writtenFiles) {
      try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    }
    throw err;
  } finally {
    client.release();
  }

  await logActivity(req.user!.id, 'CREATE_WARRANTY_ORDER', 'order', newOrder.id, { source: source_order_id });
  res.status(201).json({ success: true, data: newOrder, error: null });
}));

router.post('/bulk', asyncHandler(async (req: Request, res: Response) => {
  const { customer_id, branch_id, products } = req.body as {
    customer_id: string;
    branch_id: string;
    products: Array<{
      product_type: string; device_name: string; serial_imei?: string;
      accessories?: string; fault_description: string; quotation: number;
      warranty_period_months?: number;
    }>;
  };

  if (!customer_id || !branch_id || !Array.isArray(products) || products.length === 0) {
    res.status(400).json({ success: false, data: null, error: 'Thiếu thông tin bắt buộc' });
    return;
  }
  if (products.length > 20) {
    res.status(400).json({ success: false, data: null, error: 'Tối đa 20 sản phẩm mỗi lần tạo' });
    return;
  }

  const client = await pool.connect();
  const created = [];
  try {
    await client.query('BEGIN');
  for (const p of products) {
    if (!p.product_type || !p.device_name || !p.fault_description) {
      await client.query('ROLLBACK');
      client.release();
      res.status(400).json({ success: false, data: null, error: 'Thiếu thông tin sản phẩm' });
      return;
    }
    const orderCode = await generateOrderCode();
    const result = await client.query(
      `INSERT INTO orders
         (order_code, customer_id, branch_id, created_by, product_type, device_name,
          serial_imei, accessories, fault_description, quotation, warranty_period_months)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [orderCode, customer_id, branch_id, req.user!.id, p.product_type,
       p.device_name, p.serial_imei || null, p.accessories || null,
       p.fault_description, p.quotation || 0, p.warranty_period_months || 3]
    );
    await client.query(
      `INSERT INTO order_status_history (order_id, changed_by, new_status) VALUES ($1,$2,'TIEP_NHAN')`,
      [result.rows[0].id, req.user!.id]
    );
    await logActivity(req.user!.id, 'CREATE_ORDER', 'order', result.rows[0].id);
    created.push(result.rows[0]);
  }
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  res.status(201).json({ success: true, data: created, error: null });
}));

router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address,
            c.type AS customer_type, b.name AS branch_name, u.full_name AS created_by_name
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN branches b ON b.id = o.branch_id
     JOIN users u ON u.id = o.created_by
     WHERE o.id = $1`,
    [req.params.id]
  );
  if (!result.rows[0]) { res.status(404).json({ success: false, data: null, error: 'Không tìm thấy đơn hàng' }); return; }

  const [history, images] = await Promise.all([
    pool.query(
      `SELECT osh.*, u.full_name AS changed_by_name
       FROM order_status_history osh JOIN users u ON u.id = osh.changed_by
       WHERE osh.order_id = $1 ORDER BY osh.changed_at ASC`,
      [req.params.id]
    ),
    pool.query('SELECT * FROM order_images WHERE order_id = $1 ORDER BY uploaded_at', [req.params.id]),
  ]);

  // RH-134: for warranty orders (order_code ends with -BH, -BH2, -BH3, ...),
  // fetch source order history.
  const orderCode: string = result.rows[0].order_code ?? '';
  let source_order_history: Record<string, unknown>[] | null = null;
  let source_order_id: string | null = null;
  if (WARRANTY_CODE_SUFFIX_RE.test(orderCode)) {
    const sourceCode = orderCode.replace(WARRANTY_CODE_SUFFIX_RE, '');
    const sourceOrder = await pool.query(
      'SELECT id FROM orders WHERE order_code = $1',
      [sourceCode]
    );
    if (sourceOrder.rows[0]) {
      source_order_id = sourceOrder.rows[0].id;
      const sourceHistory = await pool.query(
        `SELECT osh.*, u.full_name AS changed_by_name
         FROM order_status_history osh JOIN users u ON u.id = osh.changed_by
         WHERE osh.order_id = $1 ORDER BY osh.changed_at ASC`,
        [source_order_id]
      );
      source_order_history = sourceHistory.rows;
    } else {
      source_order_history = [];
    }
  }

  res.json({ success: true, data: { ...result.rows[0], history: history.rows, images: images.rows, source_order_history, source_order_id }, error: null });
}));

router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
  const { quotation, warranty_period_months, notes } = req.body as {
    quotation?: number; warranty_period_months?: number; notes?: string;
  };
  const order = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!order.rows[0]) { res.status(404).json({ success: false, data: null, error: 'Không tìm thấy đơn hàng' }); return; }

  const sets: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [];
  let idx = 1;

  if (quotation !== undefined && quotation !== null) {
    sets.push(`quotation = $${idx}`); params.push(quotation); idx++;
  }
  if (warranty_period_months !== undefined && warranty_period_months !== null) {
    sets.push(`warranty_period_months = $${idx}`); params.push(warranty_period_months); idx++;
  }

  // RH-63: notes-only updates are valid — they record a history row even
  // when no scalar order field changed. Reject only when neither scalar
  // field nor notes were provided.
  const hasFieldUpdate = params.length > 0;
  const hasNotes = !!(notes && notes.trim());
  if (!hasFieldUpdate && !hasNotes) {
    res.status(400).json({ success: false, data: null, error: 'Không có dữ liệu cập nhật' }); return;
  }

  if (hasFieldUpdate) {
    params.push(req.params.id);
    await pool.query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $${idx}`, params);
  }

  // RH-133: record warranty duration changes in order status history
  const oldWarranty = order.rows[0].warranty_period_months;
  const warrantyChanged =
    warranty_period_months !== undefined &&
    warranty_period_months !== null &&
    warranty_period_months !== oldWarranty;

  if (warrantyChanged) {
    await pool.query(
      `INSERT INTO order_status_history (order_id, changed_by, old_status, new_status, notes)
       VALUES ($1,$2,$3,$3,$4)`,
      [
        req.params.id,
        req.user!.id,
        order.rows[0].status,
        `Cập nhật bảo hành: ${oldWarranty} tháng → ${warranty_period_months} tháng`,
      ]
    );
  }

  if (hasNotes) {
    await pool.query(
      `INSERT INTO order_status_history (order_id, changed_by, old_status, new_status, notes)
       VALUES ($1,$2,$3,$3,$4)`,
      [req.params.id, req.user!.id, order.rows[0].status, notes]
    );
  }

  await logActivity(req.user!.id, 'UPDATE_ORDER', 'order', req.params.id, { quotation, warranty_period_months });
  const updated = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  res.json({ success: true, data: updated.rows[0], error: null });
}));

router.put('/:id/status', asyncHandler(async (req: Request, res: Response) => {
  const { status, notes } = req.body as { status: string; notes?: string };
  const order = await pool.query('SELECT status FROM orders WHERE id = $1', [req.params.id]);
  if (!order.rows[0]) { res.status(404).json({ success: false, data: null, error: 'Không tìm thấy đơn hàng' }); return; }

  const current = order.rows[0].status;
  if (TERMINAL_STATUSES.includes(current)) {
    res.status(400).json({ success: false, data: null, error: 'Đơn hàng đã hoàn thành, không thể thay đổi trạng thái' });
    return;
  }
  if (!STATUS_FLOW.includes(status)) {
    res.status(400).json({ success: false, data: null, error: 'Trạng thái không hợp lệ' });
    return;
  }

  if (EVIDENCE_REQUIRED_STATUSES.includes(status)) {
    const trimmedNotes = typeof notes === 'string' ? notes.trim() : '';
    if (!trimmedNotes) {
      res.status(400).json({ success: false, data: null, error: 'Vui lòng nhập ghi chú khi chuyển sang trạng thái Đã giao / Huỷ trả máy' });
      return;
    }

    // Compare against real status transitions only. PATCH /:id inserts
    // administrative order_status_history rows (old_status = new_status) for
    // warranty-duration edits (RH-133) and notes-only updates; those must not
    // bump the "latest change" timestamp, or a COMPLETION photo/video uploaded
    // before such an edit would wrongly stop counting as fresh. Creation
    // rows (old_status IS NULL) still count via IS DISTINCT FROM. Videos are
    // COMPLETION rows too, so this query is unchanged by video support.
    const completionImage = await pool.query(
      `SELECT 1 FROM order_images oi WHERE oi.order_id = $1 AND oi.image_type = 'COMPLETION'
       AND oi.uploaded_at > (SELECT MAX(changed_at) FROM order_status_history WHERE order_id = $1 AND old_status IS DISTINCT FROM new_status) LIMIT 1`,
      [req.params.id]
    );
    if (!completionImage.rows[0]) {
      res.status(400).json({ success: false, data: null, error: 'Vui lòng tải ảnh hoặc video khi chuyển sang trạng thái Đã giao / Huỷ trả máy' });
      return;
    }
  }

  let warrantyUpdate = '';
  const updateParams: unknown[] = [status, req.params.id];
  if (status === 'DA_GIAO') {
    const orderRow = await pool.query('SELECT warranty_period_months FROM orders WHERE id = $1', [req.params.id]);
    const months = Number(orderRow.rows[0]?.warranty_period_months) || 12;
    updateParams.push(months);
    warrantyUpdate = `, warranty_end_date = CURRENT_DATE + ($${updateParams.length} * INTERVAL '1 month')`;
  }

  await pool.query(
    `UPDATE orders SET status = $1, updated_at = NOW()${warrantyUpdate} WHERE id = $2`,
    updateParams
  );
  await pool.query(
    `INSERT INTO order_status_history (order_id, changed_by, old_status, new_status, notes)
     VALUES ($1,$2,$3,$4,$5)`,
    [req.params.id, req.user!.id, current, status, notes || null]
  );
  await logActivity(req.user!.id, 'UPDATE_ORDER_STATUS', 'order', req.params.id, { from: current, to: status });

  const updated = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  res.json({ success: true, data: updated.rows[0], error: null });
}));

// ── Shared media-processing helper ───────────────────────────────────────────
// Converts HEIC → JPEG (via heic-convert) and compresses >2MB images (via
// sharp, preserving the image's own format — PNG stays PNG, WebP stays
// WebP).  Videos pass through unchanged — no sharp or heic-convert.  Returns
// the final stored filename.  On failure the original file is removed before
// rethrowing so no orphaned file is left on disk.
//
// Callers must pass a `file` whose mimetype/filename reflect the CONTENT-
// DETECTED type (see validateUploadedFiles), not necessarily the client's
// declared mimetype — a mismatched extension here would compress the wrong
// format or misclassify a video as an image.
const TWO_MB = 2 * 1024 * 1024;

export async function storeUploadedMedia(file: Express.Multer.File): Promise<string> {
  if (ALLOWED_VIDEO_MIME_TYPES.has(file.mimetype)) {
    return file.filename;
  }

  const originalPath = path.join(uploadDir, file.filename);
  const isHeic = HEIC_MIME_TYPES.has(file.mimetype);
  let outputPath: string | undefined; // a converted/compressed file we may have started writing

  try {
    if (isHeic) {
      // sharp's prebuilt libvips ships without the HEVC decoder, so it cannot
      // decode iPhone HEIC. Decode with heic-convert (pure JS / libde265 wasm),
      // then resize via sharp if the resulting JPEG is large.
      const baseName = path.basename(file.filename, path.extname(file.filename));
      const jpegName = `${baseName}.jpg`;
      outputPath = path.join(uploadDir, jpegName);
      const inputBuffer = await fs.promises.readFile(originalPath);
      const jpegBuffer = Buffer.from(
        await heicConvert({ buffer: inputBuffer, format: 'JPEG', quality: 0.8 })
      );
      if (jpegBuffer.length > TWO_MB) {
        await sharp(jpegBuffer)
          .resize({ width: 1920, withoutEnlargement: true })
          .jpeg({ quality: 75 })
          .toFile(outputPath);
      } else {
        await fs.promises.writeFile(outputPath, jpegBuffer);
      }
      fs.unlinkSync(originalPath); // remove original HEIC
      return jpegName;
    } else if (file.size > TWO_MB) {
      // Resize and compress large images, preserving their own format so a
      // PNG/WebP doesn't silently turn into a (lossy) JPEG.
      const ext = MIME_EXTENSIONS[file.mimetype] || '.jpg';
      const baseName = path.basename(file.filename, path.extname(file.filename));
      const compressedName = `c-${baseName}${ext}`;
      outputPath = path.join(uploadDir, compressedName);
      let pipeline = sharp(originalPath).resize({ width: 1920, withoutEnlargement: true });
      if (file.mimetype === 'image/png') {
        // sharp's png() `quality` option only has an effect in palette
        // (indexed-color) mode — for a normal full-color PNG it's silently
        // ignored and the file is re-encoded losslessly at whatever the
        // default compression level is. Shrink it losslessly instead via
        // the zlib compression level and adaptive filtering; this won't
        // reduce file size anywhere near as much as JPEG's lossy quality
        // knob, but it does actually do something (unlike bare quality).
        pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
      } else if (file.mimetype === 'image/webp') {
        pipeline = pipeline.webp({ quality: 75 });
      } else {
        pipeline = pipeline.jpeg({ quality: 75 });
      }
      await pipeline.toFile(outputPath);
      fs.unlinkSync(originalPath); // remove original
      return compressedName;
    }
    return file.filename;
  } catch (err) {
    // On failure, remove the original AND any partially-written output so no
    // orphaned file is left on disk (e.g. if toFile/writeFile threw mid-write).
    try { fs.unlinkSync(originalPath); } catch { /* already gone */ }
    if (outputPath) { try { fs.unlinkSync(outputPath); } catch { /* never written / already gone */ } }
    throw err;
  }
}

// ── POST /:id/images ──────────────────────────────────────────────────────────

router.post('/:id/images', upload.array('images'), asyncHandler(async (req: Request, res: Response) => {
  const orderCheck = await pool.query('SELECT created_by FROM orders WHERE id = $1', [req.params.id]);
  if (!orderCheck.rows[0]) {
    discardUploadedFiles(req);
    res.status(404).json({ success: false, data: null, error: 'Không tìm thấy đơn hàng' });
    return;
  }
  const isTechnician = req.user!.role === 'TECHNICIAN';
  const isAdmin = req.user!.role === 'ADMIN';
  if (!isAdmin && !isTechnician) {
    discardUploadedFiles(req);
    res.status(403).json({ success: false, data: null, error: 'Không có quyền tải ảnh cho đơn này' });
    return;
  }

  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    res.status(400).json({ success: false, data: null, error: 'Không có ảnh nào được tải lên' });
    return;
  }

  const validationError = validateUploadedFiles(files);
  if (validationError) {
    res.status(400).json({ success: false, data: null, error: validationError });
    return;
  }

  const imageType = (req.body.image_type as string) || 'INTAKE';
  if (!VALID_IMAGE_TYPES.has(imageType)) {
    // multer already wrote the files to disk; remove them so a bad request doesn't orphan files.
    discardUploadedFiles(req);
    res.status(400).json({ success: false, data: null, error: 'Loại ảnh không hợp lệ' });
    return;
  }

  const inserted = [];

  for (const file of files) {
    const finalFilename = await storeUploadedMedia(file);
    const r = await pool.query(
      `INSERT INTO order_images (order_id, image_path, image_type, uploaded_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, finalFilename, imageType, req.user!.id]
    );
    inserted.push(r.rows[0]);
  }

  await logActivity(req.user!.id, 'UPLOAD_IMAGES', 'order', req.params.id, { count: files.length });
  res.status(201).json({ success: true, data: inserted, error: null });
}));

// ── POST /bulk-with-images ────────────────────────────────────────────────────
// Atomically creates 1..N orders together with their images in a single DB
// transaction.  On ANY failure the transaction is rolled back and every file
// written to disk is removed so the caller can safely retry without producing
// duplicate orders.

const VALID_PRODUCT_TYPES = new Set(['SPEAKER', 'HEADPHONE', 'OTHER', 'BAO_HANH']);

const uploadAny = createMediaUpload({ files: BULK_IMAGES_MAX_FILES });

router.post('/bulk-with-images', uploadAny.any(), asyncHandler(async (req: Request, res: Response) => {
  // ── 1. Parse and validate payload ────────────────────────────────────────
  let payload: {
    customer_id: string;
    branch_id: string;
    products: Array<{
      product_type: string;
      device_name: string;
      serial_imei?: string;
      accessories?: string;
      fault_description: string;
    }>;
  };

  try {
    payload = JSON.parse(req.body.payload as string);
  } catch {
    discardUploadedFiles(req);
    res.status(400).json({ success: false, data: null, error: 'payload phải là JSON hợp lệ' });
    return;
  }

  const { customer_id, branch_id, products } = payload;
  if (!customer_id || !branch_id) {
    discardUploadedFiles(req);
    res.status(400).json({ success: false, data: null, error: 'Thiếu customer_id hoặc branch_id' });
    return;
  }
  if (!Array.isArray(products) || products.length === 0) {
    discardUploadedFiles(req);
    res.status(400).json({ success: false, data: null, error: 'products phải là mảng không rỗng' });
    return;
  }
  if (products.length > 20) {
    discardUploadedFiles(req);
    res.status(400).json({ success: false, data: null, error: 'Tối đa 20 sản phẩm mỗi lần tạo' });
    return;
  }
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    if (!VALID_PRODUCT_TYPES.has(p.product_type)) {
      discardUploadedFiles(req);
      res.status(400).json({ success: false, data: null, error: `Sản phẩm ${i}: product_type không hợp lệ (${p.product_type})` });
      return;
    }
    if (!p.device_name || !p.fault_description) {
      discardUploadedFiles(req);
      res.status(400).json({ success: false, data: null, error: `Sản phẩm ${i}: thiếu device_name hoặc fault_description` });
      return;
    }
  }

  // ── 2. Group uploaded files by product index ──────────────────────────────
  // multer .any() puts all files in req.files as Express.Multer.File[] with
  // a .fieldname property. Fields named images_<i> map to product index i.
  const allFiles = (req.files as Express.Multer.File[]) || [];
  const validationError = validateUploadedFiles(allFiles);
  if (validationError) {
    res.status(400).json({ success: false, data: null, error: validationError });
    return;
  }
  const filesByProduct = new Map<number, Express.Multer.File[]>();
  for (const file of allFiles) {
    const match = file.fieldname.match(/^images_(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (!filesByProduct.has(idx)) filesByProduct.set(idx, []);
      filesByProduct.get(idx)!.push(file);
    }
  }

  // ── 3. Transaction ────────────────────────────────────────────────────────
  const client = await pool.connect();
  const writtenFiles: string[] = [];
  const created = [];

  try {
    await client.query('BEGIN');

    for (let i = 0; i < products.length; i++) {
      const p = products[i];

      // Insert order (mirrors POST /bulk)
      const orderCode = await generateOrderCode();
      const orderResult = await client.query(
        `INSERT INTO orders
           (order_code, customer_id, branch_id, created_by, product_type, device_name,
            serial_imei, accessories, fault_description, quotation, warranty_period_months)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [orderCode, customer_id, branch_id, req.user!.id, p.product_type,
         p.device_name, p.serial_imei || null, p.accessories || null,
         p.fault_description, 0, 3]
      );
      const newOrder = orderResult.rows[0];

      await client.query(
        `INSERT INTO order_status_history (order_id, changed_by, new_status) VALUES ($1,$2,'TIEP_NHAN')`,
        [newOrder.id, req.user!.id]
      );

      // Process and insert images/videos for this product
      const productFiles = filesByProduct.get(i) || [];
      for (const file of productFiles) {
        const finalFilename = await storeUploadedMedia(file);
        writtenFiles.push(path.join(uploadDir, finalFilename));
        await client.query(
          `INSERT INTO order_images (order_id, image_path, image_type, uploaded_by)
           VALUES ($1,$2,'INTAKE',$3)`,
          [newOrder.id, finalFilename, req.user!.id]
        );
      }

      await logActivity(req.user!.id, 'CREATE_ORDER', 'order', newOrder.id);
      created.push(newOrder);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // Best-effort cleanup of any files written before the failure
    for (const filePath of writtenFiles) {
      try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    }
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json({ success: true, data: created, error: null });
}));

export default router;
