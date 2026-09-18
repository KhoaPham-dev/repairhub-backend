import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { discardUploadedFiles } from '../utils/uploadCleanup';

export function errorHandler(
  err: Error & { status?: number },
  req: Request,
  res: Response,
  next: NextFunction
): void {
  console.error(err.stack);

  if (err instanceof multer.MulterError) {
    // multer does not clean up sibling files itself when a later file in the
    // same multipart request trips a limit (e.g. LIMIT_FILE_SIZE /
    // LIMIT_FILE_COUNT) — without this, files already parsed successfully
    // leak on disk.
    discardUploadedFiles(req);

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
