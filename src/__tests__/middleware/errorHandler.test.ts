import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
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

  // ── Existing generic 500 behaviour ────────────────────────────────────────
  it('responds with status 500 for a plain Error', () => {
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

  // ── RH-139: MulterError branches ─────────────────────────────────────────
  it('returns 413 for MulterError LIMIT_FILE_SIZE', () => {
    const { res, status, json } = makeRes();
    const err = new multer.MulterError('LIMIT_FILE_SIZE');
    errorHandler(err as unknown as Error, req, res as Response, next);
    expect(status).toHaveBeenCalledWith(413);
    const body = json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.data).toBeNull();
    expect(body.error).toMatch(/Ảnh quá lớn/);
  });

  it('returns 400 for any other MulterError code', () => {
    const { res, status, json } = makeRes();
    const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE');
    errorHandler(err as unknown as Error, req, res as Response, next);
    expect(status).toHaveBeenCalledWith(400);
    const body = json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Tải ảnh không hợp lệ/);
  });

  it('returns 400 for a MulterError LIMIT_PART_COUNT', () => {
    const { res, status } = makeRes();
    const err = new multer.MulterError('LIMIT_PART_COUNT');
    errorHandler(err as unknown as Error, req, res as Response, next);
    expect(status).toHaveBeenCalledWith(400);
  });

  // ── RH-139: Status-carrying error (fileFilter error) ─────────────────────
  it('returns the error\'s status code for a 4xx status-carrying Error', () => {
    const { res, status, json } = makeRes();
    const err = new Error('Định dạng ảnh không hợp lệ') as Error & { status?: number };
    err.status = 400;
    errorHandler(err, req, res as Response, next);
    expect(status).toHaveBeenCalledWith(400);
    const body = json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.data).toBeNull();
    expect(body.error).toBe('Định dạng ảnh không hợp lệ');
  });

  it('returns 422 for a status-carrying Error with status=422', () => {
    const { res, status } = makeRes();
    const err = new Error('Unprocessable') as Error & { status?: number };
    err.status = 422;
    errorHandler(err, req, res as Response, next);
    expect(status).toHaveBeenCalledWith(422);
  });

  it('falls through to 500 for a status-carrying Error with status=500', () => {
    const { res, status } = makeRes();
    const err = new Error('Server side') as Error & { status?: number };
    err.status = 500;
    errorHandler(err, req, res as Response, next);
    expect(status).toHaveBeenCalledWith(500);
  });

  it('falls through to 500 when err.status is not in 4xx range (e.g. undefined)', () => {
    const { res, status } = makeRes();
    const err = new Error('unknown') as Error & { status?: number };
    // no .status set
    errorHandler(err, req, res as Response, next);
    expect(status).toHaveBeenCalledWith(500);
  });

  // ── Envelope shape ────────────────────────────────────────────────────────
  it('always uses { success, data, error } envelope', () => {
    const { res, json } = makeRes();
    const err = new multer.MulterError('LIMIT_FILE_SIZE');
    errorHandler(err as unknown as Error, req, res as Response, next);
    const body = json.mock.calls[0][0];
    expect(body).toHaveProperty('success', false);
    expect(body).toHaveProperty('data', null);
    expect(body).toHaveProperty('error');
  });
});
