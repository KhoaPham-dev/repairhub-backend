import { Router, Request, Response } from 'express';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  res.json({
    success: true,
    data: { status: 'ok', timestamp: new Date().toISOString() },
    error: null,
  });
});

export default router;
