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
import branchesRouter from '../../routes/branches';
import { errorHandler } from '../../middleware/errorHandler';
import { logActivity } from '../../utils/activityLog';

const mockQuery = pool.query as jest.Mock;
const mockLogActivity = logActivity as jest.Mock;
const SECRET = process.env.JWT_SECRET!;
const adminToken = jwt.sign({ id: 'u1', username: 'admin', role: 'ADMIN', branch_id: null }, SECRET, { expiresIn: '1h' });
const techToken = jwt.sign({ id: 'u2', username: 'tech', role: 'TECHNICIAN', branch_id: 'b1' }, SECRET, { expiresIn: '1h' });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/branches', branchesRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  mockLogActivity.mockResolvedValue(undefined);
});

afterEach(() => jest.resetAllMocks());

describe('GET /api/branches', () => {
  it('returns 401 without token', async () => {
    const res = await request(buildApp()).get('/api/branches');
    expect(res.status).toBe(401);
  });

  it('returns branches list', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'b1', name: 'HCM', is_active: true }] });
    const res = await request(buildApp()).get('/api/branches').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].name).toBe('HCM');
  });
});

describe('POST /api/branches', () => {
  it('returns 403 for non-admin users', async () => {
    const res = await request(buildApp())
      .post('/api/branches')
      .set('Authorization', `Bearer ${techToken}`)
      .send({ name: 'New Branch' });
    expect(res.status).toBe(403);
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(buildApp())
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('creates branch and returns 201', async () => {
    const created = { id: 'b2', name: 'Hanoi', is_active: true };
    mockQuery.mockResolvedValueOnce({ rows: [created] });
    const res = await request(buildApp())
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Hanoi' });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Hanoi');
  });
});

describe('GET /api/branches/:id', () => {
  it('returns 404 when branch not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp()).get('/api/branches/b99').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('returns branch data', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'b1', name: 'HCM' }] });
    const res = await request(buildApp()).get('/api/branches/b1').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('HCM');
  });
});

describe('PUT /api/branches/:id', () => {
  it('returns 403 for non-admin', async () => {
    const res = await request(buildApp())
      .put('/api/branches/b1')
      .set('Authorization', `Bearer ${techToken}`)
      .send({ name: 'Updated' });
    expect(res.status).toBe(403);
  });

  it('returns 404 when branch not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .put('/api/branches/b99')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Updated' });
    expect(res.status).toBe(404);
  });

  it('updates and returns branch', async () => {
    const updated = { id: 'b1', name: 'Updated HCM' };
    mockQuery.mockResolvedValueOnce({ rows: [updated] });
    const res = await request(buildApp())
      .put('/api/branches/b1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Updated HCM' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Updated HCM');
  });
});

describe('DELETE /api/branches/:id', () => {
  it('returns 403 for non-admin', async () => {
    const res = await request(buildApp())
      .delete('/api/branches/b1')
      .set('Authorization', `Bearer ${techToken}`);
    expect(res.status).toBe(403);
  });

  it('returns 400 when branch has active orders', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'o1' }] }); // active orders
    const res = await request(buildApp())
      .delete('/api/branches/b1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('soft-deletes branch when no active orders', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no active orders
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE
    const res = await request(buildApp())
      .delete('/api/branches/b1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /api/branches/:id/enable', () => {
  it('returns 403 for non-admin', async () => {
    const res = await request(buildApp())
      .post('/api/branches/b1/enable')
      .set('Authorization', `Bearer ${techToken}`);
    expect(res.status).toBe(403);
  });

  it('enables branch and returns success', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE
    const res = await request(buildApp())
      .post('/api/branches/b1/enable')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
