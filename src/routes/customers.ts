import { Router, Request, Response } from 'express';
import { pool } from '../config/database';
import { authenticate } from '../middleware/auth';
import { logActivity } from '../utils/activityLog';

const router = Router();
router.use(authenticate);

router.get('/', async (req: Request, res: Response) => {
  const { search, type, limit = '50', offset = '0' } = req.query;
  let query = 'SELECT * FROM customers WHERE 1=1';
  const params: unknown[] = [];

  if (search) {
    params.push(`%${search}%`);
    query += ` AND (phone ILIKE $${params.length} OR name ILIKE $${params.length})`;
  }
  if (type) { params.push(type); query += ` AND type = $${params.length}`; }

  query += ' ORDER BY created_at DESC';
  params.push(Math.min(Number(limit), 200));
  query += ` LIMIT $${params.length}`;
  params.push(Number(offset));
  query += ` OFFSET $${params.length}`;

  const result = await pool.query(query, params);
  res.json({ success: true, data: result.rows, error: null });
});

router.get('/search', async (req: Request, res: Response) => {
  const { q } = req.query;
  if (!q) { res.json({ success: true, data: [], error: null }); return; }

  const result = await pool.query(
    'SELECT * FROM customers WHERE phone ILIKE $1 OR name ILIKE $1 LIMIT 10',
    [`%${q}%`]
  );
  res.json({ success: true, data: result.rows, error: null });
});

router.post('/', async (req: Request, res: Response) => {
  const { phone, name, address, type, notes } = req.body as {
    phone: string; name: string; address?: string;
    type?: 'RETAIL' | 'PARTNER'; notes?: string;
  };
  if (!phone || !name) {
    res.status(400).json({ success: false, data: null, error: 'Số điện thoại và tên là bắt buộc' });
    return;
  }

  const result = await pool.query(
    `INSERT INTO customers (phone, name, address, type, notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [phone.trim(), name.trim(), address || null, type || 'RETAIL', notes || null]
  );
  await logActivity(req.user!.id, 'CREATE_CUSTOMER', 'customer', result.rows[0].id);
  res.status(201).json({ success: true, data: result.rows[0], error: null });
});

router.get('/:id', async (req: Request, res: Response) => {
  const customer = await pool.query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
  if (!customer.rows[0]) { res.status(404).json({ success: false, data: null, error: 'Không tìm thấy khách hàng' }); return; }

  const orders = await pool.query(
    'SELECT id, order_code, status, device_name, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC',
    [req.params.id]
  );
  res.json({ success: true, data: { ...customer.rows[0], orders: orders.rows }, error: null });
});

router.put('/:id', async (req: Request, res: Response) => {
  const { name, address, type, notes } = req.body as {
    name?: string; address?: string; type?: string; notes?: string;
  };
  const result = await pool.query(
    `UPDATE customers SET
       name = COALESCE($1, name),
       address = COALESCE($2, address),
       type = COALESCE($3, type),
       notes = COALESCE($4, notes),
       updated_at = NOW()
     WHERE id = $5 RETURNING *`,
    [name, address, type, notes, req.params.id]
  );
  if (!result.rows[0]) { res.status(404).json({ success: false, data: null, error: 'Không tìm thấy khách hàng' }); return; }
  await logActivity(req.user!.id, 'UPDATE_CUSTOMER', 'customer', req.params.id);
  res.json({ success: true, data: result.rows[0], error: null });
});

router.delete('/:id', async (req: Request, res: Response) => {
  await pool.query('DELETE FROM customers WHERE id = $1', [req.params.id]);
  await logActivity(req.user!.id, 'DELETE_CUSTOMER', 'customer', req.params.id);
  res.json({ success: true, data: null, error: null });
});

export default router;
