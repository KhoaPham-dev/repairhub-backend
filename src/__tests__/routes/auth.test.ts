jest.mock('../../config/database', () => ({
  pool: { query: jest.fn() },
}));
jest.mock('../../utils/activityLog', () => ({
  logActivity: jest.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import express from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../../config/database';
import authRouter from '../../routes/auth';
import { errorHandler } from '../../middleware/errorHandler';
import { logActivity } from '../../utils/activityLog';

const mockQuery = pool.query as jest.Mock;
const mockLogActivity = logActivity as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  mockLogActivity.mockResolvedValue(undefined);
});

afterEach(() => jest.resetAllMocks());

describe('POST /api/auth/login', () => {
  it('returns 400 when username or password is missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/auth/login').send({ username: 'admin' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 when user does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const app = buildApp();
    const res = await request(app).post('/api/auth/login').send({ username: 'nouser', password: 'pw' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 when user is inactive', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1', username: 'admin', password_hash: 'x', is_active: false }] });
    const app = buildApp();
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'pw' });
    expect(res.status).toBe(401);
  });

  it('returns 401 when password is wrong', async () => {
    const hash = await bcrypt.hash('correct', 10);
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'u1', username: 'admin', password_hash: hash, is_active: true, role: 'ADMIN', branch_id: null, full_name: 'Admin' }],
    });
    const app = buildApp();
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('returns 200 with token on successful login', async () => {
    const hash = await bcrypt.hash('secret', 10);
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'u1', username: 'admin', password_hash: hash, is_active: true, role: 'ADMIN', branch_id: null, full_name: 'Admin' }],
    });
    const app = buildApp();
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'secret' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.user.username).toBe('admin');
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 without auth token', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns user data with valid token', async () => {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ id: 'u1', username: 'admin', role: 'ADMIN', branch_id: null }, 'change-me', { expiresIn: '1h' });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1', username: 'admin', full_name: 'Admin', role: 'ADMIN', branch_id: null }] });
    const app = buildApp();
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe('admin');
  });
});

describe('POST /api/auth/logout', () => {
  it('returns 401 without token', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(401);
  });

  it('returns 200 with valid token', async () => {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ id: 'u1', username: 'admin', role: 'ADMIN', branch_id: null }, 'change-me', { expiresIn: '1h' });
    const app = buildApp();
    const res = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
