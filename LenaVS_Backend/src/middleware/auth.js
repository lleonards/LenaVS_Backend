import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Middleware de autenticação
 * Valida o token JWT do Supabase corretamente
 */
export const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        error: 'Token de autenticação não fornecido'
      });
    }

    // Validação correta via Supabase
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(403).json({
        error: 'Token inválido'
      });
    }

    // Usuário autenticado
    req.user = {
      id: data.user.id,
      email: data.user.email,
      role: data.user.role || 'user'
    };

    next();
  } catch (err) {
    console.error('Erro na autenticação:', err);
    return res.status(500).json({
      error: 'Erro interno de autenticação'
    });
  }
};

/**
 * Middleware opcional de autenticação
 * Não bloqueia se não houver token
 */
export const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];

    if (!token) return next();

    const { data, error } = await supabase.auth.getUser(token);

    if (!error && data?.user) {
      req.user = {
        id: data.user.id,
        email: data.user.email,
        role: data.user.role || 'user'
      };
    }

    next();
  } catch {
    next();
  }
};
