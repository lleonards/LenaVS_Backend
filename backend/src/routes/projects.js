import express from 'express';
import {
  createProject,
  listProjects,
  listPublicProjects,
  getProject,
  updateProject,
  updateVisibility,
  forkProject,
  deleteProject,
} from '../controllers/projectController.js';

import { authenticateToken } from '../middleware/auth.js';
import { requireActiveAccess } from '../middleware/requireActiveAccess.js';

const router = express.Router();

/* ────────────────────────────────────────────────
   ROTA PÚBLICA — biblioteca (requer login, não crédito)
──────────────────────────────────────────────── */

// Biblioteca de projetos públicos
router.get('/public', authenticateToken, listPublicProjects);

/* ────────────────────────────────────────────────
   ROTAS PRIVADAS — requerem acesso ativo
──────────────────────────────────────────────── */

// Criar projeto
router.post('/',           authenticateToken, requireActiveAccess, createProject);

// Listar projetos do usuário (histórico)
router.get('/',            authenticateToken, requireActiveAccess, listProjects);

// Obter projeto específico
router.get('/:id',         authenticateToken, requireActiveAccess, getProject);

// Atualizar projeto
router.put('/:id',         authenticateToken, requireActiveAccess, updateProject);

// Alterar visibilidade (público / privado)
router.patch('/:id/visibility', authenticateToken, requireActiveAccess, updateVisibility);

// Fork — duplicar projeto público para edição
router.post('/:id/fork',   authenticateToken, requireActiveAccess, forkProject);

// Deletar projeto
router.delete('/:id',      authenticateToken, requireActiveAccess, deleteProject);

export default router;
