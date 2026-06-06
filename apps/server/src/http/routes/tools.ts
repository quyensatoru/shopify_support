import { Router } from 'express';
import { listToolsFromDb, setToolEnabled } from '../../db/repo/index.js';

const router = Router();

router.get('/tools', async (_req, res) => {
    const rows = await listToolsFromDb();
    res.json({ tools: rows });
});

router.patch('/tools/:toolId', async (req, res) => {
    const { toolId } = req.params;
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be boolean' });
        return;
    }
    await setToolEnabled(toolId!, enabled);
    res.json({ ok: true });
});

export { router as toolsRouter };
