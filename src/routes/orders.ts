import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { pool } from '../config/database';
import { authenticate } from '../middleware/auth';
import { logActivity } from '../utils/activityLog';

const router = Router();
router.use(authenticate);

const uploadDir = process.env.UPLOAD_DIR || 'uploads';
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

const STATUS_FLOW = [
  'TIEP_NHAN', 'DANG_KIEM_TRA', 'BAO_GIA', 'CHO_LINH_KIEN',
  'DANG_SUA_CHUA', 'KIEM_TRA_LAI', 'SUA_XONG', 'DA_GIAO', 'HUY_TRA_MAY',
];
const TERMINAL_STATUSES = ['DA_GIAO', 'HUY_TRA_MAY'];

function generateOrderCode(): string {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const seq = String(Math.floor(Math.random() * 99999) + 1).padStart(5, '0');
  return `ORD-${date}-${seq}`;
}

router.get('/', async (req: Request, res: Response) => {
  const { status, branch_id, search, sort = 'desc', limit = '20', offset = '0' } = req.query;
  const params: unknown[] = [];
  let where = 'WHERE 1=1';

  if (status) { params.push(status); where += ` AND o.status = $${params.length}`; }
  if (branch_id) { params.push(branch_id); where += ` AND o.branch_id = $${params.length}`; }
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (c.phone ILIKE $${params.length} OR o.serial_imei ILIKE $${params.length} OR o.order_code ILIKE $${params.length} OR c.name ILIKE $${params.length})`;
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

  const config = await pool.query("SELECT value FROM system_config WHERE key IN ('priority_low_days','priority_medium_days')");
  const cfg: Record<string, number> = {};
  for (const r of config.rows) cfg[r.key] = Number(r.value);
  const lowDays = cfg['priority_low_days'] ?? 3;
  const medDays = cfg['priority_medium_days'] ?? 7;

  const rows = result.rows.map((order) => {
    let priority: 'LOW' | 'MEDIUM' | 'HIGH' | null = null;
    if (!TERMINAL_STATUSES.includes(order.status)) {
      const ageDays = (Date.now() - new Date(order.created_at).getTime()) / 86400000;
      priority = ageDays < lowDays ? 'LOW' : ageDays < medDays ? 'MEDIUM' : 'HIGH';
    }
    return { ...order, priority };
  });

  res.json({ success: true, data: rows, error: null });
});

router.get('/status-counts', async (req: Request, res: Response) => {
  const result = await pool.query('SELECT status, COUNT(*) AS count FROM orders GROUP BY status');
  const counts: Record<string, number> = {};
  for (const r of result.rows) counts[r.status] = Number(r.count);
  res.json({ success: true, data: counts, error: null });
});

router.post('/', async (req: Request, res: Response) => {
  const {
    customer_id, branch_id, product_type, device_name, serial_imei,
    accessories, fault_description, quotation,
  } = req.body as {
    customer_id: string; branch_id: string; product_type: string;
    device_name: string; serial_imei?: string; accessories?: string;
    fault_description: string; quotation: number;
  };

  if (!customer_id || !branch_id || !product_type || !device_name || !fault_description) {
    res.status(400).json({ success: false, data: null, error: 'Thiếu thông tin bắt buộc' });
    return;
  }

  const orderCode = generateOrderCode();
  const result = await pool.query(
    `INSERT INTO orders
       (order_code, customer_id, branch_id, created_by, product_type, device_name,
        serial_imei, accessories, fault_description, quotation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [orderCode, customer_id, branch_id, req.user!.id, product_type,
     device_name, serial_imei || null, accessories || null, fault_description, quotation || 0]
  );

  await pool.query(
    `INSERT INTO order_status_history (order_id, changed_by, new_status) VALUES ($1,$2,$3)`,
    [result.rows[0].id, req.user!.id, 'TIEP_NHAN']
  );
  await logActivity(req.user!.id, 'CREATE_ORDER', 'order', result.rows[0].id);
  res.status(201).json({ success: true, data: result.rows[0], error: null });
});

router.get('/:id', async (req: Request, res: Response) => {
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

  res.json({ success: true, data: { ...result.rows[0], history: history.rows, images: images.rows }, error: null });
});

router.put('/:id/status', async (req: Request, res: Response) => {
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

  let warrantyUpdate = '';
  const updateParams: unknown[] = [status, req.params.id];
  if (status === 'DA_GIAO') {
    warrantyUpdate = ', warranty_end_date = CURRENT_DATE + INTERVAL \'12 months\'';
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
});

router.post('/:id/images', upload.array('images', 10), async (req: Request, res: Response) => {
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    res.status(400).json({ success: false, data: null, error: 'Không có ảnh nào được tải lên' });
    return;
  }

  const imageType = (req.body.image_type as string) || 'INTAKE';
  const inserted = [];
  for (const file of files) {
    const r = await pool.query(
      `INSERT INTO order_images (order_id, image_path, image_type, uploaded_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, file.filename, imageType, req.user!.id]
    );
    inserted.push(r.rows[0]);
  }

  await logActivity(req.user!.id, 'UPLOAD_IMAGES', 'order', req.params.id, { count: files.length });
  res.status(201).json({ success: true, data: inserted, error: null });
});

export default router;
