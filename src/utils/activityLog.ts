import { pool } from '../config/database';

export async function logActivity(
  userId: string,
  action: string,
  resourceType?: string,
  resourceId?: string,
  details?: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `INSERT INTO activity_log (user_id, action, resource_type, resource_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, action, resourceType || null, resourceId || null, details ? JSON.stringify(details) : null]
  );
}
