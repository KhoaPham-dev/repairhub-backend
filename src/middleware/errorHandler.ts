import { Request, Response, NextFunction } from 'express';
import multer from 'multer';

export function errorHandler(
  err: Error & { status?: number },
  req: Request,
  res: Response,
  next: NextFunction
): void {
  console.error(err.stack);

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        success: false,
        data: null,
        error: 'Ảnh quá lớn (tối đa 10MB mỗi ảnh)',
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
