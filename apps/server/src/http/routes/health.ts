import { Router } from 'express';

const router = Router();

router.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
});

export { router as healthRouter };
