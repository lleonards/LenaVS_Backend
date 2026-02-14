import express from 'express';
import {
  createProject,
  listProjects,
  getProject,
  updateProject,
  deleteProject
} from '../controllers/projectController.js';

import { authenticateToken } from '../middleware/auth.js';
import { requireActiveAccess } from '../middleware/requireActiveAccess.js';

const router = express.Router();

/*
  🔐 TODAS as rotas exigem:
  1. Usuário autenticado
  2. Trial ativo OU assinatura ativa
*/

// Criar novo projeto
router.post(
  '/',
  authenticateToken,
  requireActiveAccess,
  createProject
);

// Listar projetos do usuário
router.get(
  '/',
  authenticateToken,
  requireActiveAccess,
  listProjects
);

// Obter projeto específico
router.get(
  '/:id',
  authenticateToken,
  requireActiveAccess,
  getProject
);

// Atualizar projeto
router.put(
  '/:id',
  authenticateToken,
  requireActiveAccess,
  updateProject
);

// Deletar projeto
router.delete(
  '/:id',
  authenticateToken,
  requireActiveAccess,
  deleteProject
);

export default router;
