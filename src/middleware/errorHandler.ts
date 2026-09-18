import { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';

const uploadDir = process.env.UPLOAD_DIR || 'uploads';

// Deletes every file multer already wrote to disk for this request. multer
// does not do this itself when a later file in the same multipart request
// trips a limit (e.g. LIMIT_FILE_SIZE / LIMIT_FILE_COUNT) — without this,
// the sibling files that were already parsed successfully leak on disk.
function cleanupUploadedFiles(req: Request): void {
  const files: Express.Multer.File[] = [];
  if (Array.isArray(req.files)) {
    files.push(...req.files);
  } else if (req.files && typeof req.files === 'object') {
    for (const fieldFiles of Object.values(req.files)) {
      files.push(...(fieldFiles as Express.Multer.File[]));
    }
  }
  if (req.file) files.push(req.file);

  for (const f of files) {
    try { fs.unlinkSync(path.join(uploadDir, f.filename)); } catch { /* already gone / never written */ }
  }
}

export function errorHandler(
  err: Error & { status?: number },
  req: Request,
  res: Response,
  next: NextFunction
): void {
  console.error(err.stack);

  if (err instanceof multer.MulterError) {
    cleanupUploadedFiles(req);

    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        success: false,
        data: null,
        error: 'Tệp quá lớn (ảnh tối đa 10MB, video tối đa 100MB)',
      });
      return;
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      res.status(400).json({
        success: false,
        data: null,
        error: 'Quá nhiều tệp trong một lần tải lên',
      });
      return;
    }
    res.status(400).json({
      success: false,
      data: null,
      error: 'Tải ảnh không hợp lệ',
    });
    return;
  }

  if (typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({
      success: false,
      data: null,
      error: err.message,
    });
    return;
  }

  res.status(500).json({
    success: false,
    data: null,
    error:
      process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message,
  });
}
