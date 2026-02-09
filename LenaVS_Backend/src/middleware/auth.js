import jwt from 'jsonwebtoken';
import { supabaseConfig } from '../config/supabase.js';

/**
 * Middleware de autenticação
 * Valida o token JWT do Supabase
 */
export const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({ 
        error: 'Token de autenticação não fornecido' 
      });
    }

    // Verificar e decodificar o token usando a chave pública do Supabase
    const decoded = jwt.verify(token, supabaseConfig.jwtSecret, {
      algorithms: ['HS256']
    });

    // Adicionar informações do usuário à requisição
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role || 'user'
    };

    next();
  } catch (error) {
    console.error('Erro na autenticação:', error);
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado' });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(403).json({ error: 'Token inválido' });
    }

    return res.status(500).json({ error: 'Erro ao validar token' });
  }
};

/**
 * Middleware opcional de autenticação
 * Não bloqueia se não houver token
 */
export const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
      const decoded = jwt.verify(token, supabaseConfig.jwtSecret, {
        algorithms: ['HS256']
      });

      req.user = {
        id: decoded.sub,
        email: decoded.email,
        role: decoded.role || 'user'
      };
    }

    next();
  } catch (error) {
    // Continua sem autenticação
    next();
  }
};
