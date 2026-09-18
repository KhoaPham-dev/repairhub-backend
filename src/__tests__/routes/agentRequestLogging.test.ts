/**
 * Tests for agentRequestLogger (NFR-08.5): one structured log line per
 * /api/agent/* request, written when the response finishes, covering both
 * successful and rejected (unauthorized/disabled/bad_request) outcomes —
 * and never containing the X-Agent-Key value or any query-string value.
 */

jest.mock('../../config/database', () => ({
  pool: { query: jest.fn() },
}));

import request from 'supertest';
import express from 'express';
import agentRouter from '../../routes/agent';
import { errorHandler } from '../../middleware/errorHandler';
import { pool } from '../../config/database';

const mockQuery = pool.query as jest.Mock;
const AGENT_KEY = 'super-secret-agent-key-do-not-log-9f8e7d';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRouter);
  app.use(errorHandler);
  return app;
}

let consoleLogSpy: jest.SpyInstance;

beforeEach(() => {
  process.env.AGENT_API_KEY = AGENT_KEY;
  process.env.PUBLIC_MEDIA_BASE_URL = 'https://media.example.com';
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  jest.resetAllMocks();
  delete process.env.AGENT_API_KEY;
  delete process.env.PUBLIC_MEDIA_BASE_URL;
});

/** Every console.log call made as a single-argument string. */
function loggedLines(): string[] {
  return consoleLogSpy.mock.calls.map((call) => call[0] as string);
}

/** Parses the one (and only) [agent-api] log line's JSON payload. */
function parseSingleAgentLogEntry(): Record<string, unknown> {
  const lines = loggedLines().filter((l) => l.startsWith('[agent-api] '));
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0].slice('[agent-api] '.length));
}

describe('agentRequestLogger — one structured line per request', () => {
  it('logs a 200 request with all required fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }).mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp()).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(200);

    const entry = parseSingleAgentLogEntry();
    expect(typeof entry.ts).toBe('string');
    expect(new Date(entry.ts as string).toString()).not.toBe('Invalid Date');
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/api/agent/orders');
    expect(entry.status).toBe(200);
    expect(typeof entry.duration_ms).toBe('number');
    expect(entry.duration_ms as number).toBeGreaterThanOrEqual(0);
    expect(typeof entry.ip).toBe('string');
    expect(entry.outcome).toBe('ok');
  });

  it('logs a 401 (missing key) request with outcome "unauthorized"', async () => {
    const res = await request(buildApp()).get('/api/agent/orders');
    expect(res.status).toBe(401);

    const entry = parseSingleAgentLogEntry();
    expect(entry.status).toBe(401);
    expect(entry.outcome).toBe('unauthorized');
  });

  it('logs a 401 (wrong key) request — auth failures are logged too, before auth runs', async () => {
    const res = await request(buildApp()).get('/api/agent/orders').set('X-Agent-Key', 'totally-wrong-key');
    expect(res.status).toBe(401);

    const entry = parseSingleAgentLogEntry();
    expect(entry.outcome).toBe('unauthorized');
  });

  it('logs a 404 (AGENT_API_KEY unset) request with outcome "disabled"', async () => {
    delete process.env.AGENT_API_KEY;
    const res = await request(buildApp()).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(404);

    const entry = parseSingleAgentLogEntry();
    expect(entry.status).toBe(404);
    expect(entry.outcome).toBe('disabled');
  });

  it('never logs the X-Agent-Key value, on success or failure', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }).mockResolvedValueOnce({ rows: [] });
    await request(buildApp()).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
    await request(buildApp()).get('/api/agent/orders').set('X-Agent-Key', 'wrong-but-still-a-key-shaped-value');

    for (const line of loggedLines()) {
      expect(line).not.toContain(AGENT_KEY);
      expect(line).not.toContain('wrong-but-still-a-key-shaped-value');
    }
  });

  it('never logs query-string values (e.g. a date_from or status filter)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }).mockResolvedValueOnce({ rows: [] });
    await request(buildApp())
      .get('/api/agent/orders?date_from=2020-01-01&status=SUA_XONG&product_type=SPEAKER')
      .set('X-Agent-Key', AGENT_KEY);

    const entry = parseSingleAgentLogEntry();
    expect(entry.path).toBe('/api/agent/orders'); // query string stripped entirely
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('2020-01-01');
    expect(serialized).not.toContain('SUA_XONG');
    expect(serialized).not.toContain('SPEAKER');
  });

  it('logs the parameterised route path (not the literal id/code) for a matched detail route', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // order not found
    await request(buildApp()).get('/api/agent/orders/20260918-00007').set('X-Agent-Key', AGENT_KEY);

    const entry = parseSingleAgentLogEntry();
    expect(entry.path).toBe('/api/agent/orders/:idOrCode');
    expect(JSON.stringify(entry)).not.toContain('20260918-00007');
  });

  it('logs a validation (400) request with outcome "bad_request"', async () => {
    const res = await request(buildApp())
      .get('/api/agent/orders?limit=0')
      .set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(400);

    const entry = parseSingleAgentLogEntry();
    expect(entry.outcome).toBe('bad_request');
  });

  it('logs a server error (500) request with outcome "error"', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {}); // silence errorHandler's own log
    mockQuery.mockRejectedValueOnce(new Error('db unreachable'));
    const res = await request(buildApp()).get('/api/agent/orders').set('X-Agent-Key', AGENT_KEY);
    expect(res.status).toBe(500);

    const entry = parseSingleAgentLogEntry();
    expect(entry.status).toBe(500);
    expect(entry.outcome).toBe('error');
  });
});
