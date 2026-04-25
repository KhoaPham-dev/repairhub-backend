import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
  console.log('Running migrations...');
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/001_initial_schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('✓ Schema ready');

  // Default branch
  const branch = await pool.query(`
    INSERT INTO branches (name, address, phone, manager_name)
    VALUES ('Chi nhánh chính', '123 Đường Nguyễn Huệ, TP.HCM', '0901234567', 'Nguyễn Văn A')
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id, name
  `);
  console.log(`✓ Branch: ${branch.rows[0].name} (${branch.rows[0].id})`);

  // Admin user
  const hash = await bcrypt.hash('admin123', 10);
  const admin = await pool.query(`
    INSERT INTO users (username, password_hash, full_name, role, branch_id)
    VALUES ('admin', $1, 'Quản trị viên', 'ADMIN', $2)
    ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash
    RETURNING id, username, role
  `, [hash, branch.rows[0].id]);
  console.log(`✓ Admin: ${admin.rows[0].username} / admin123 (${admin.rows[0].id})`);

  // Demo technician
  const techHash = await bcrypt.hash('tech123', 10);
  const tech = await pool.query(`
    INSERT INTO users (username, password_hash, full_name, role, branch_id)
    VALUES ('technician', $1, 'Kỹ thuật viên Demo', 'TECHNICIAN', $2)
    ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash
    RETURNING id, username, role
  `, [techHash, branch.rows[0].id]);
  console.log(`✓ Technician: ${tech.rows[0].username} / tech123 (${tech.rows[0].id})`);

  await pool.end();
  console.log('\n✅ Seed complete. Ready to start the server.');
  console.log('   Admin login:      admin / admin123');
  console.log('   Technician login: technician / tech123');
}

seed().catch((err) => { console.error('Seed failed:', err.message); process.exit(1); });
