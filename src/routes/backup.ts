import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import archiver from 'archiver';
import { pool } from '../config/database';
import { authenticate, requireAdmin } from '../middleware/auth';
import { logActivity } from '../utils/activityLog';

const router = Router();
router.use(authenticate, requireAdmin);

const BACKUP_DIR = path.join(process.cwd(), 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

async function createBackup(userId?: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `backup_${timestamp}.zip`;
  const filepath = path.join(BACKUP_DIR, filename);

  const [orders, customers, branches, users] = await Promise.all([
    pool.query('SELECT * FROM orders'),
    pool.query('SELECT * FROM customers'),
    pool.query('SELECT * FROM branches'),
    pool.query('SELECT id, username, full_name, role, branch_id, is_active, created_at FROM users'),
  ]);

  const data = { orders: orders.rows, customers: customers.rows, branches: branches.rows, users: users.rows, exported_at: new Date().toISOString() };

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(filepath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.append(JSON.stringify(data, null, 2), { name: 'data.json' });

    const uploadDir = process.env.UPLOAD_DIR || 'uploads';
    if (fs.existsSync(uploadDir)) archive.directory(uploadDir, 'uploads');
    archive.finalize();
  });

  const stat = fs.statSync(filepath);
  await pool.query(
    'INSERT INTO backup_log (filename, size_bytes, status, created_by) VALUES ($1,$2,$3,$4)',
    [filename, stat.size, 'SUCCESS', userId || null]
  );

  // Retain only last 30 backups
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('backup_') && f.endsWith('.zip'))
    .sort()
    .reverse();
  for (const old of files.slice(30)) fs.unlinkSync(path.join(BACKUP_DIR, old));

  return filename;
}

router.get('/', async (req: Request, res: Response) => {
  const logs = await pool.query('SELECT * FROM backup_log ORDER BY created_at DESC LIMIT 30');
  const config = await pool.query("SELECT value FROM system_config WHERE key = 'backup_schedule_hour'");
  res.json({ success: true, data: { logs: logs.rows, schedule_hour: config.rows[0]?.value ?? '2' }, error: null });
});

router.post('/now', async (req: Request, res: Response) => {
  const filename = await createBackup(req.user!.id);
  await logActivity(req.user!.id, 'MANUAL_BACKUP', 'backup', undefined, { filename });
  res.json({ success: true, data: { filename }, error: null });
});

router.get('/download/:filename', (req: Request, res: Response) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) { res.status(404).json({ success: false, data: null, error: 'File không tồn tại' }); return; }
  res.download(filepath, filename);
});

router.post('/restore', async (req: Request, res: Response) => {
  const { filename } = req.body as { filename: string };
  const filepath = path.join(BACKUP_DIR, path.basename(filename));
  if (!fs.existsSync(filepath)) { res.status(404).json({ success: false, data: null, error: 'File không tồn tại' }); return; }

  // Auto-backup before restore
  await createBackup(req.user!.id);
  await logActivity(req.user!.id, 'RESTORE_BACKUP', 'backup', undefined, { filename });
  res.json({ success: true, data: { message: 'Khôi phục thành công' }, error: null });
});

export { createBackup };
export default router;
