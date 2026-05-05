import express from 'express';
import {
  createProject,
  listProjects,
  listPublicProjects,
  getProject,
  updateProject,
  toggleProjectPublicStatus,
  forkProject,
  deleteProject,
} from '../controllers/projectController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.use(authenticateToken);

router.get('/library', listPublicProjects);
router.post('/', createProject);
router.get('/', listProjects);
router.get('/:id', getProject);
router.put('/:id', updateProject);
router.patch('/:id/toggle-public', toggleProjectPublicStatus);
router.post('/:id/fork', forkProject);
router.delete('/:id', deleteProject);

export default router;
