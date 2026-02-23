// 🔥 IMPORTANTE: Importe o supabase da sua pasta de config, 
// para garantir que ele use as chaves corretas já configuradas.
import { supabase } from '../config/supabase.js';

export const requireActiveAccess = async (req, res, next) => {
  try {
    // 1. Verifica se o middleware de autenticação (auth.js) passou o usuário
    if (!req.user || !req.user.id) {
      console.warn('Tentativa de acesso sem req.user.id');
      return res.status(401).json({
        error: 'Usuário não autenticado ou token inválido'
      });
    }

    const userId = req.user.id;

    // 2. Busca dados do banco
    const { data: user, error } = await supabase
      .from('users')
      .select('plan, credits, subscription_status')
      .eq('id', userId)
      .single();

    // 3. Se houver erro no banco ou usuário não existir
    if (error || !user) {
      console.error('Erro ao buscar usuário no banco:', error);
      return res.status(403).json({
        error: 'Acesso negado: Perfil de usuário não encontrado no banco de dados.'
      });
    }

    /* =====================================================
        💎 PLANO PRO → ACESSO TOTAL
    ===================================================== */
    const isPro =
      user.plan === 'pro' &&
      user.subscription_status === 'active';

    if (isPro) {
      return next(); // Libera acesso
    }

    /* =====================================================
        🎁 PLANO FREE → VERIFICAR CRÉDITOS
    ===================================================== */
    if (user.plan === 'free' || !user.plan) {
      const availableCredits = Number(user.credits) || 0;

      if (availableCredits <= 0) {
        return res.status(403).json({
          error: 'Créditos esgotados',
          code: 'NO_CREDITS',
          action: 'UPGRADE_REQUIRED'
        });
      }

      return next(); // Tem créditos, libera acesso
    }

    /* =====================================================
        ❌ CASO INVÁLIDO (Ex: Assinatura cancelada ou pendente)
    ===================================================== */
    return res.status(403).json({
      error: 'Assinatura inativa ou plano inválido. Verifique seu pagamento.',
      status: user.subscription_status
    });

  } catch (err) {
    console.error('Erro CRÍTICO no requireActiveAccess:', err);
    // 🔥 Garante que o servidor RESPONDA, mesmo em caso de erro no código
    return res.status(500).json({
      error: 'Erro interno ao verificar permissões de acesso.'
    });
  }
};
