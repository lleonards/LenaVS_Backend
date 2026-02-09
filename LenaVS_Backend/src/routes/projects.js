import express from 'express';
import {
  createProject,
  listProjects,
  getProject,
  updateProject,
  deleteProject
} from '../controllers/projectController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Criar novo projeto
router.post('/', authenticateToken, createProject);

// Listar projetos do usuário
router.get('/', authenticateToken, listProjects);

// Obter projeto específico
router.get('/:id', authenticateToken, getProject);

// Atualizar projeto
router.put('/:id', authenticateToken, updateProject);

// Deletar projeto
router.delete('/:id', authenticateToken, deleteProject);

export default router;
