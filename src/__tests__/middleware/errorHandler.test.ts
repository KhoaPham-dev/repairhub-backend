import { Request, Response, NextFunction } from 'express';
import { errorHandler } from '../../middleware/errorHandler';

function makeRes(): { status: jest.Mock; json: jest.Mock; res: Partial<Response> } {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res: Partial<Response> = { status, json } as unknown as Partial<Response>;
  return { status, json, res };
}

describe('errorHandler middleware', () => {
  const req = {} as Request;
  const next = jest.fn() as NextFunction;

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('always responds with status 500', () => {
    const { res, status } = makeRes();
    const err = new Error('something went wrong');
    errorHandler(err, req, res as Response, next);
    expect(status).toHaveBeenCalledWith(500);
  });

  it('returns success: false with error message in non-production', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const { res, json } = makeRes();
    const err = new Error('db connection failed');
    errorHandler(err, req, res as Response, next);
    const body = json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.data).toBeNull();
    expect(body.error).toBe('db connection failed');
    process.env.NODE_ENV = originalEnv;
  });

  it('returns generic message in production', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const { res, json } = makeRes();
    const err = new Error('secret detail');
    errorHandler(err, req, res as Response, next);
    const body = json.mock.calls[0][0];
    expect(body.error).toBe('Internal server error');
    process.env.NODE_ENV = originalEnv;
  });
});
