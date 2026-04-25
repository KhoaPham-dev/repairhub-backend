import { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';

describe('asyncHandler', () => {
  const req = {} as Request;
  const res = {} as Response;

  it('calls the wrapped async function with req, res, next', async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    const handler = asyncHandler(fn);
    const next = jest.fn();
    handler(req, res, next);
    await Promise.resolve(); // flush microtask
    expect(fn).toHaveBeenCalledWith(req, res, next);
  });

  it('passes errors to next() when the async function rejects', async () => {
    const error = new Error('async error');
    const fn = jest.fn().mockRejectedValue(error);
    const next = jest.fn();
    handler: {
      const handler = asyncHandler(fn);
      handler(req, res, next);
      await new Promise((r) => setTimeout(r, 0)); // flush microtasks
      expect(next).toHaveBeenCalledWith(error);
    }
  });

  it('does not call next() when the async function resolves successfully', async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    const next = jest.fn();
    const handler = asyncHandler(fn);
    handler(req, res, next);
    await new Promise((r) => setTimeout(r, 0));
    expect(next).not.toHaveBeenCalled();
  });
});
