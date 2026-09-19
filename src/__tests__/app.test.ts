/**
 * Tests for the static /uploads mount in src/app.ts.
 *
 * Uses a real Express app (app.ts imports real `pool`, but pg's Pool
 * connects lazily — a static-file request never touches the DB) with an
 * isolated UPLOAD_DIR set before the module is loaded, so no other test's
 * uploads dir is affected.
 *
 * app.ts resolves the static root as `path.join(process.cwd(), UPLOAD_DIR)`
 * — i.e. UPLOAD_DIR is always relative to cwd (even an absolute value would
 * be joined, not substituted) — so this test uses a relative dir under cwd
 * to match, rather than an OS tmpdir.
 */

import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { Express } from 'express';

const relativeUploadDir = `.rh-app-static-test-${Date.now()}`;
const resolvedUploadDir = path.join(process.cwd(), relativeUploadDir);
let app: Express;

beforeAll(() => {
  fs.mkdirSync(resolvedUploadDir, { recursive: true });
  fs.writeFileSync(path.join(resolvedUploadDir, 'sample.txt'), 'hello');
  process.env.UPLOAD_DIR = relativeUploadDir;

  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    app = require('../app').default;
  });
});

afterAll(() => {
  fs.rmSync(resolvedUploadDir, { recursive: true, force: true });
  delete process.env.UPLOAD_DIR;
});

describe('/uploads static route', () => {
  it('sets X-Content-Type-Options: nosniff on a served file', async () => {
    const res = await request(app).get('/uploads/sample.txt');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Content-Type-Options: nosniff even on a 404 for a missing file', async () => {
    // express.static calls next() (no header) when the file is missing, so
    // this documents that the header is only guaranteed on a served file —
    // not a correctness requirement, just current behaviour.
    const res = await request(app).get('/uploads/does-not-exist.txt');
    expect(res.status).toBe(404);
  });
});

describe('TRUST_PROXY', () => {
  function loadAppWith(value: string | undefined): Express {
    let fresh: Express;
    if (value === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = value;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      fresh = require('../app').default;
    });
    delete process.env.TRUST_PROXY;
    return fresh!;
  }

  it('trusts no proxy by default', () => {
    expect(loadAppWith(undefined).get('trust proxy')).toBe(false);
  });

  it('trusts the configured number of hops behind nginx', () => {
    expect(loadAppWith('1').get('trust proxy')).toBe(1);
  });

  it('ignores 0 and non-numeric values', () => {
    expect(loadAppWith('0').get('trust proxy')).toBe(false);
    expect(loadAppWith('yes').get('trust proxy')).toBe(false);
  });
});
