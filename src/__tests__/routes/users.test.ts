jest.mock('../../config/database', () => ({
  pool: { query: jest.fn() },
}));
jest.mock('../../utils/activityLog', () => ({
  logActivity: jest.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../../config/database';
import usersRouter from '../../routes/users';
import { errorHandler } from '../../middleware/errorHandler';
import { logActivity } from '../../utils/activityLog';

const mockQuery = pool.query as jest.Mock;
const mockLogActivity = logActivity as jest.Mock;
const SECRET = 'change-me';
const adminId = '11111111-1111-1111-1111-111111111111';
const adminToken = jwt.sign({ id: adminId, username: 'admin', role: 'ADMIN', branch_id: null }, SECRET, { expiresIn: '1h' });
const techToken = jwt.sign({ id: 'u2', username: 'tech', role: 'TECHNICIAN', branch_id: 'b1' }, SECRET, { expiresIn: '1h' });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  mockLogActivity.mockResolvedValue(undefined);
});

afterEach(() => jest.resetAllMocks());

describe('GET /api/users', () => {
  it('returns 401 without token', async () => {
    const res = await request(buildApp()).get('/api/users');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin', async () => {
    const res = await request(buildApp()).get('/api/users').set('Authorization', `Bearer ${techToken}`);
    expect(res.status).toBe(403);
  });

  it('returns users list for admin', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: adminId, username: 'admin', role: 'ADMIN' }] });
    const res = await request(buildApp()).get('/api/users').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].username).toBe('admin');
  });
});

describe('POST /api/users', () => {
  it('returns 400 when required fields are missing', async () => {
    const res = await request(buildApp())
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'newuser' });
    expect(res.status).toBe(400);
  });

  it('creates user and returns 201', async () => {
    const created = { id: 'u3', username: 'newuser', full_name: 'New User', role: 'TECHNICIAN', branch_id: null, is_active: true };
    mockQuery.mockResolvedValueOnce({ rows: [created] }); // INSERT
    const res = await request(buildApp())
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'newuser', password: 'pass123', full_name: 'New User', role: 'TECHNICIAN' });
    expect(res.status).toBe(201);
    expect(res.body.data.username).toBe('newuser');
  });
});

describe('PUT /api/users/:id', () => {
  const validId = '22222222-2222-2222-2222-222222222222';

  it('returns 404 for invalid UUID format', async () => {
    const res = await request(buildApp())
      .put('/api/users/not-a-uuid')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ full_name: 'Updated' });
    expect(res.status).toBe(404);
  });

  it('returns 404 when user not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .put(`/api/users/${validId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ full_name: 'Updated' });
    expect(res.status).toBe(404);
  });

  it('updates user and returns updated data', async () => {
    const updated = { id: validId, username: 'tech', full_name: 'Updated Tech', role: 'TECHNICIAN', branch_id: null, is_active: true };
    mockQuery.mockResolvedValueOnce({ rows: [updated] });
    const res = await request(buildApp())
      .put(`/api/users/${validId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ full_name: 'Updated Tech' });
    expect(res.status).toBe(200);
    expect(res.body.data.full_name).toBe('Updated Tech');
  });
});

describe('POST /api/users/:id/reset-password', () => {
  const validId = '33333333-3333-3333-3333-333333333333';

  it('returns 400 when password is empty', async () => {
    const res = await request(buildApp())
      .post(`/api/users/${validId}/reset-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('resets password and returns success', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE
    const res = await request(buildApp())
      .post(`/api/users/${validId}/reset-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: 'newpassword' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /api/users/activity-log', () => {
  it('returns activity log', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'al1', action: 'LOGIN', username: 'admin', full_name: 'Admin' }] });
    const res = await request(buildApp())
      .get('/api/users/activity-log')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].action).toBe('LOGIN');
  });
});

describe('DELETE /api/users/:id', () => {
  const otherId = '44444444-4444-4444-4444-444444444444';

  it('returns 404 for invalid UUID', async () => {
    const res = await request(buildApp())
      .delete('/api/users/invalid-uuid')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('returns 400 when trying to delete own account', async () => {
    const res = await request(buildApp())
      .delete(`/api/users/${adminId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('soft-deletes user and returns success', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE
    const res = await request(buildApp())
      .delete(`/api/users/${otherId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
