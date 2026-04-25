import request from 'supertest';
import express from 'express';
import healthRouter from '../../routes/health';

const app = express();
app.use('/health', healthRouter);

describe('GET /health', () => {
  it('returns 200 with success: true and status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.timestamp).toBeDefined();
    expect(res.body.error).toBeNull();
  });
});
