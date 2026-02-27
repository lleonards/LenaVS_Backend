import stripe from '../config/stripe.js';
import supabase from '../config/supabase.js';

export const createPaymentSession = async (req, res) => {
  try {
    const user = req.user;

    if (!user || !user.id) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const { currency } = req.body; // "usd" ou "brl"

    // Buscar usuário no banco
    const { data: profile, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    // Escolher price dinamicamente
    let priceId;

    if (currency === 'usd') {
      priceId = process.env.STRIPE_PRICE_USD;
    } else {
      priceId = process.env.STRIPE_PRICE_BRL;
    }

    if (!priceId) {
      return res.status(500).json({
        error: 'Price ID não configurado no environment',
      });
    }

    // Criar sessão Stripe
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: profile.email,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL}/success`,
      cancel_url: `${process.env.FRONTEND_URL}/upgrade`,
    });

    return res.json({ url: session.url });

  } catch (err) {
    console.error('❌ Erro ao criar sessão Stripe:', err.message);
    return res.status(500).json({
      error: 'Erro ao criar sessão de pagamento',
      details: err.message,
    });
  }
};

export const getSubscriptionStatus = async (req, res) => {
  try {
    const user = req.user;

    if (!user || !user.id) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const { data: profile, error } = await supabase
      .from('users')
      .select('plan, credits')
      .eq('id', user.id)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    return res.json({
      plan: profile.plan,
      credits: profile.credits,
    });

  } catch (err) {
    console.error('❌ Erro ao buscar assinatura:', err.message);
    return res.status(500).json({
      error: 'Erro ao buscar assinatura',
    });
  }
};
