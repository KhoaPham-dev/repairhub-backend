import path from 'path';
import fs from 'fs';
import { Request } from 'express';

const uploadDir = process.env.UPLOAD_DIR || 'uploads';

/**
 * Deletes every file in the given list from the uploads directory. Used
 * whenever a request is rejected after multer has already written files to
 * disk, so nothing is left orphaned.
 */
export function deleteUploadedFiles(files: Express.Multer.File[]): void {
  for (const f of files) {
    try { fs.unlinkSync(path.join(uploadDir, f.filename)); } catch { /* already gone */ }
  }
}

/**
 * Extracts every Multer file attached to a request, regardless of which
 * multer method produced them: `.array()`/`.any()` (req.files as an array),
 * `.fields()` (req.files as a field-name → File[] map), or `.single()`
 * (req.file).
 */
function extractUploadedFiles(req: Request): Express.Multer.File[] {
  const files: Express.Multer.File[] = [];
  if (Array.isArray(req.files)) {
    files.push(...req.files);
  } else if (req.files && typeof req.files === 'object') {
    for (const fieldFiles of Object.values(req.files)) {
      files.push(...(fieldFiles as Express.Multer.File[]));
    }
  }
  if (req.file) files.push(req.file);
  return files;
}

/**
 * Deletes every file multer already wrote to disk for this request.
 *
 * Call this on any early-return (4xx/5xx) response path that runs after a
 * multer upload middleware parsed the request but before the files were
 * persisted/used — otherwise multer's already-written files (up to the
 * configured fileSize × files limits) are orphaned on disk. Shared by
 * errorHandler (for MulterError responses) and every upload route's own
 * early-return validation branches.
 */
export function discardUploadedFiles(req: Request): void {
  deleteUploadedFiles(extractUploadedFiles(req));
}
