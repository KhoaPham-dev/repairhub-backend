jest.mock('../../config/database', () => ({
  pool: {
    query: jest.fn(),
  },
}));

import { pool } from '../../config/database';
import { logActivity } from '../../utils/activityLog';

const mockQuery = pool.query as jest.Mock;

describe('logActivity', () => {
  beforeEach(() => {
    mockQuery.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('calls pool.query with correct SQL and params for minimal args', async () => {
    await logActivity('user-1', 'LOGIN');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO activity_log');
    expect(params[0]).toBe('user-1');
    expect(params[1]).toBe('LOGIN');
    expect(params[2]).toBeNull();
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
  });

  it('calls pool.query with resourceType and resourceId', async () => {
    await logActivity('user-2', 'CREATE_ORDER', 'order', 'order-99');
    const [, params] = mockQuery.mock.calls[0];
    expect(params[2]).toBe('order');
    expect(params[3]).toBe('order-99');
    expect(params[4]).toBeNull();
  });

  it('JSON-stringifies the details object', async () => {
    const details = { from: 'TIEP_NHAN', to: 'DANG_SUA_CHUA' };
    await logActivity('user-3', 'UPDATE_STATUS', 'order', 'o-1', details);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[4]).toBe(JSON.stringify(details));
  });
});
