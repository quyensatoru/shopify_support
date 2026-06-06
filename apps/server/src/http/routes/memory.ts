import { Router } from 'express';
import { ListMemoriesQuerySchema } from '@shopify-support/shared';
import { listMemories, deleteMemory } from '../../db/repo/index.js';

const router = Router();

router.get('/memory', async (req, res) => {
    try {
        const query = ListMemoriesQuerySchema.parse(req.query);
        const rows = await listMemories(query);
        res.json({ memories: rows });
    } catch (err) {
        res.status(400).json({ error: String(err) });
    }
});

router.delete('/memory/:id', async (req, res) => {
    await deleteMemory(req.params['id']!);
    res.json({ ok: true });
});

export { router as memoryRouter };
