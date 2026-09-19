/**
 * Tests for the two Agent API rate limiters (NFR-08.4): a global per-IP
 * bound on all /api/agent/* traffic, and a stricter per-IP bound counting
 * only failed-auth (401) responses. Each test loads a FRESH copy of
 * src/routes/agent.ts via jest.isolateModules() with small env-configured
 * limits set beforehand, so the module-scoped rate-limiter instances (and
 * their internal request counters) start clean and the tests run in
 * milliseconds instead of waiting on the real 1-minute/15-minute windows.
 */

jest.mock('../../config/database', () => ({
  pool: { query: jest.fn() },
}));

import request from 'supertest';
import express, { Express } from 'express';
import { pool } from '../../config/database';
import { errorHandler } from '../../middleware/errorHandler';

const mockQuery = pool.query as jest.Mock;
const AGENT_KEY = 'test-agent-key-rate-limit';

function loadFreshAgentApp(): Express {
  let app: Express;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const agentRouter = require('../../routes/agent').default;
    app = express();
    app.use(express.json());
    app.use('/api/agent', agentRouter);
    app.use(errorHandler);
  });
  return app!;
}

function mockSuccessfulOrdersListQuery(): void {
  mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }).mockResolvedValueOnce({ rows: [] });
}

beforeEach(() => {
  process.env.AGENT_API_KEY = AGENT_KEY;
  process.env.PUBLIC_MEDIA_BASE_URL = 'https://media.example.com';
  jest.spyOn(console, 'log').mockImplementation(() => {}); // quiet the request logger
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.AGENT_API_KEY;
  delete process.env.PUBLIC_MEDIA_BASE_URL;
  delete process.env.TRUST_CLOUDFLARE_IP;
  delete process.env.AGENT_API_RATE_LIMIT_WINDOW_MS;
  delete process.env.AGENT_API_RATE_LIMIT_MAX;
  delete process.env.AGENT_API_AUTH_FAIL_WINDOW_MS;
  delete process.env.AGENT_API_AUTH_FAIL_LIMIT_MAX;
});

describe('Agent API — global rate limit', () => {
  it('returns 429 in the standard envelope once the configured global limit is exceeded', async () => {
    process.env.AGENT_API_RATE_LIMIT_MAX = '3';
    const app = loadFreshAgentApp();

    for (let i = 0; i < 3; i++) {
      mockSuccessfulOrdersListQuery();
      const res = await request(app).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
      expect(res.status).toBe(200);
    }

    const res = await request(app).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ success: false, data: null, error: 'Too Many Requests' });
  });

  it('bounds unauthenticated (401) traffic too, not just successful requests', async () => {
    process.env.AGENT_API_RATE_LIMIT_MAX = '2';
    // Give the auth-failure limiter a lot of headroom so the GLOBAL limit is
    // what actually trips first in this test.
    process.env.AGENT_API_AUTH_FAIL_LIMIT_MAX = '1000';
    const app = loadFreshAgentApp();

    for (let i = 0; i < 2; i++) {
      const res = await request(app).get('/api/agent/orders'); // no key -> 401
      expect(res.status).toBe(401);
    }
    const res = await request(app).get('/api/agent/orders');
    expect(res.status).toBe(429);
  });
});

describe('Agent API — failed-auth (401) rate limit', () => {
  it('returns 429 once the configured failed-auth limit is exceeded, independent of the global limit', async () => {
    process.env.AGENT_API_RATE_LIMIT_MAX = '1000'; // well above what this test sends
    process.env.AGENT_API_AUTH_FAIL_LIMIT_MAX = '3';
    const app = loadFreshAgentApp();

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/api/agent/orders').set('X-Agent-Key', 'wrong-key');
      expect(res.status).toBe(401);
    }
    const res = await request(app).get('/api/agent/orders').set('X-Agent-Key', 'wrong-key');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ success: false, data: null, error: 'Too Many Requests' });
  });

  it('keeps serving a valid key from the same IP after that IP has tripped the failed-auth limit', async () => {
    process.env.AGENT_API_RATE_LIMIT_MAX = '1000';
    process.env.AGENT_API_AUTH_FAIL_LIMIT_MAX = '3';
    const app = loadFreshAgentApp();

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/api/agent/orders').set('X-Agent-Key', 'wrong-key');
      expect(res.status).toBe(401);
    }
    const blocked = await request(app).get('/api/agent/orders').set('X-Agent-Key', 'wrong-key');
    expect(blocked.status).toBe(429);

    // Same IP, correct key: must not be locked out (e.g. after a mismatched
    // key rotation between backend and mcp is corrected).
    mockSuccessfulOrdersListQuery();
    const valid = await request(app).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
    expect(valid.status).toBe(200);

    // Wrong keys stay blocked for the rest of the window.
    const stillBlocked = await request(app).get('/api/agent/orders').set('X-Agent-Key', 'another-guess');
    expect(stillBlocked.status).toBe(429);
  });

  it('does not count successful (200) requests toward the failed-auth limit', async () => {
    process.env.AGENT_API_RATE_LIMIT_MAX = '1000';
    process.env.AGENT_API_AUTH_FAIL_LIMIT_MAX = '2';
    const app = loadFreshAgentApp();

    // 5 successful requests must never trip a limit meant for only 2 failures.
    for (let i = 0; i < 5; i++) {
      mockSuccessfulOrdersListQuery();
      const res = await request(app).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
      expect(res.status).toBe(200);
    }
  });

  it('does not count a 404 (order-not-found, i.e. non-auth) response toward the failed-auth limit', async () => {
    process.env.AGENT_API_RATE_LIMIT_MAX = '1000';
    process.env.AGENT_API_AUTH_FAIL_LIMIT_MAX = '2';
    const app = loadFreshAgentApp();

    for (let i = 0; i < 5; i++) {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // order not found
      const res = await request(app)
        .get(`/api/agent/orders/2026091${i}-00007`)
        .set('X-Agent-Key', AGENT_KEY);
      expect(res.status).toBe(404);
    }
  });

  it('does not count a 400 (validation) response toward the failed-auth limit', async () => {
    process.env.AGENT_API_RATE_LIMIT_MAX = '1000';
    process.env.AGENT_API_AUTH_FAIL_LIMIT_MAX = '2';
    const app = loadFreshAgentApp();

    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/api/agent/orders?limit=0').set('X-Agent-Key', AGENT_KEY);
      expect(res.status).toBe(400);
    }
  });
});

describe('Agent API rate limiting — client IP resolution', () => {
  it('rate-limits by CF-Connecting-IP when TRUST_CLOUDFLARE_IP=true, so different client IPs get independent quotas', async () => {
    process.env.TRUST_CLOUDFLARE_IP = 'true';
    process.env.AGENT_API_RATE_LIMIT_MAX = '1';
    const app = loadFreshAgentApp();

    mockSuccessfulOrdersListQuery();
    const res1 = await request(app)
      .get('/api/agent/orders')
      .set('X-Agent-Key', AGENT_KEY)
      .set('CF-Connecting-IP', '203.0.113.5');
    expect(res1.status).toBe(200);

    // Same max (1 request/window) but a DIFFERENT CF-Connecting-IP — must
    // not be blocked by the first client's quota.
    mockSuccessfulOrdersListQuery();
    const res2 = await request(app)
      .get('/api/agent/orders')
      .set('X-Agent-Key', AGENT_KEY)
      .set('CF-Connecting-IP', '203.0.113.99');
    expect(res2.status).toBe(200);

    // The FIRST client IP is now over quota (1 already used).
    const res3 = await request(app)
      .get('/api/agent/orders')
      .set('X-Agent-Key', AGENT_KEY)
      .set('CF-Connecting-IP', '203.0.113.5');
    expect(res3.status).toBe(429);
  });

  it('ignores CF-Connecting-IP when TRUST_CLOUDFLARE_IP is unset — different header values share the same (socket) quota', async () => {
    process.env.AGENT_API_RATE_LIMIT_MAX = '1';
    const app = loadFreshAgentApp();

    mockSuccessfulOrdersListQuery();
    const res1 = await request(app)
      .get('/api/agent/orders')
      .set('X-Agent-Key', AGENT_KEY)
      .set('CF-Connecting-IP', '203.0.113.5');
    expect(res1.status).toBe(200);

    // Different CF-Connecting-IP, but TRUST_CLOUDFLARE_IP is not set, so
    // both requests are keyed by the same real socket IP (127.0.0.1 in
    // tests) and the second one is rejected.
    const res2 = await request(app)
      .get('/api/agent/orders')
      .set('X-Agent-Key', AGENT_KEY)
      .set('CF-Connecting-IP', '203.0.113.99');
    expect(res2.status).toBe(429);
  });
});
