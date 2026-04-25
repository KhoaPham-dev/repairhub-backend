jest.mock('../../config/database', () => ({
  pool: { query: jest.fn() },
}));
jest.mock('../../utils/activityLog', () => ({
  logActivity: jest.fn().mockResolvedValue(undefined),
}));
// Mock archiver and fs operations to avoid file system side effects
jest.mock('archiver', () => {
  const EventEmitter = require('events');
  return () => {
    const a = new EventEmitter();
    a.pipe = jest.fn().mockReturnThis();
    a.append = jest.fn().mockReturnThis();
    a.directory = jest.fn().mockReturnThis();
    a.finalize = jest.fn();
    return a;
  };
});

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../../config/database';
import backupRouter from '../../routes/backup';
import { errorHandler } from '../../middleware/errorHandler';
import { logActivity } from '../../utils/activityLog';

const mockQuery = pool.query as jest.Mock;
const mockLogActivity = logActivity as jest.Mock;
const SECRET = 'change-me';
const adminToken = jwt.sign({ id: 'u1', username: 'admin', role: 'ADMIN', branch_id: null }, SECRET, { expiresIn: '1h' });
const techToken = jwt.sign({ id: 'u2', username: 'tech', role: 'TECHNICIAN', branch_id: null }, SECRET, { expiresIn: '1h' });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/backup', backupRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  mockLogActivity.mockResolvedValue(undefined);
});

afterEach(() => jest.resetAllMocks());

describe('GET /api/backup', () => {
  it('returns 401 without token', async () => {
    const res = await request(buildApp()).get('/api/backup');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin', async () => {
    const res = await request(buildApp()).get('/api/backup').set('Authorization', `Bearer ${techToken}`);
    expect(res.status).toBe(403);
  });

  it('returns backup logs and schedule for admin', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, filename: 'backup_2026-04-25.zip', size_bytes: 1024 }] })
      .mockResolvedValueOnce({ rows: [{ value: '2' }] });
    const res = await request(buildApp()).get('/api/backup').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.logs).toHaveLength(1);
    expect(res.body.data.schedule_hour).toBe('2');
  });
});

describe('GET /api/backup/download/:filename', () => {
  it('returns 404 when file does not exist', async () => {
    const res = await request(buildApp())
      .get('/api/backup/download/nonexistent.zip')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/backup/restore', () => {
  it('returns 404 when backup file does not exist', async () => {
    const res = await request(buildApp())
      .post('/api/backup/restore')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ filename: 'nonexistent.zip' });
    expect(res.status).toBe(404);
  });
});
