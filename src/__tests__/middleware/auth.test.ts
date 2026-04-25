import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { authenticate, requireAdmin, AuthUser } from '../../middleware/auth';

const SECRET = 'change-me';

function makeReqResNext(overrides: Partial<Request> = {}): {
  req: Partial<Request>;
  res: Partial<Response>;
  next: jest.Mock;
  json: jest.Mock;
  status: jest.Mock;
} {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const next = jest.fn();
  const req: Partial<Request> = { headers: {}, cookies: {}, ...overrides };
  const res: Partial<Response> = { status, json } as unknown as Partial<Response>;
  return { req, res, next, json, status };
}

describe('authenticate middleware', () => {
  it('returns 401 when no token is provided', () => {
    const { req, res, next } = makeReqResNext();
    authenticate(req as Request, res as Response, next);
    expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is invalid', () => {
    const { req, res, next } = makeReqResNext({
      headers: { authorization: 'Bearer invalid-token' },
    });
    authenticate(req as Request, res as Response, next);
    expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() and sets req.user when token is valid (Bearer header)', () => {
    const payload: AuthUser = { id: 'u1', username: 'admin', role: 'ADMIN', branch_id: null };
    const token = jwt.sign(payload, SECRET, { expiresIn: '1h' });
    const { req, res, next } = makeReqResNext({
      headers: { authorization: `Bearer ${token}` },
    });
    authenticate(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect((req as Request).user).toMatchObject({ id: 'u1', username: 'admin', role: 'ADMIN' });
  });

  it('calls next() and sets req.user when token is provided via cookie', () => {
    const payload: AuthUser = { id: 'u2', username: 'tech', role: 'TECHNICIAN', branch_id: 'b1' };
    const token = jwt.sign(payload, SECRET, { expiresIn: '1h' });
    const { req, res, next } = makeReqResNext({
      headers: {},
      cookies: { token },
    });
    authenticate(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect((req as Request).user?.role).toBe('TECHNICIAN');
  });

  it('returns 401 for expired token', () => {
    const payload: AuthUser = { id: 'u3', username: 'expired', role: 'ADMIN', branch_id: null };
    const token = jwt.sign(payload, SECRET, { expiresIn: '-1s' });
    const { req, res, next } = makeReqResNext({
      headers: { authorization: `Bearer ${token}` },
    });
    authenticate(req as Request, res as Response, next);
    expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireAdmin middleware', () => {
  it('calls next() when user role is ADMIN', () => {
    const { req, res, next } = makeReqResNext();
    (req as Request).user = { id: 'u1', username: 'admin', role: 'ADMIN', branch_id: null };
    requireAdmin(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect((res.status as jest.Mock)).not.toHaveBeenCalled();
  });

  it('returns 403 when user role is TECHNICIAN', () => {
    const { req, res, next } = makeReqResNext();
    (req as Request).user = { id: 'u2', username: 'tech', role: 'TECHNICIAN', branch_id: null };
    requireAdmin(req as Request, res as Response, next);
    expect((res.status as jest.Mock).mock.calls[0][0]).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when req.user is undefined', () => {
    const { req, res, next } = makeReqResNext();
    (req as Request).user = undefined;
    requireAdmin(req as Request, res as Response, next);
    expect((res.status as jest.Mock).mock.calls[0][0]).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});
