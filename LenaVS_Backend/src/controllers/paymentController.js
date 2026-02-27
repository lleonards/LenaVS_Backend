import stripe from '../config/stripe.js';
import supabase from '../config/supabase.js';

/* =====================================================
   🔥 CRIAR SESSÃO DE PAGAMENTO
===================================================== */

export const createPaymentSession = async (req, res) => {
  try {
    const user = req.user;

    if (!user || !user.id) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const { currency } = req.body; // "usd" ou "brl"

    const { data: profile, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

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

    return res.json({ sessionUrl: session.url });

  } catch (err) {
    console.error('❌ Erro ao criar sessão Stripe:', err);
    return res.status(500).json({
      error: 'Erro ao criar sessão de pagamento',
      details: err.message,
    });
  }
};

/* =====================================================
   🔥 WEBHOOK STRIPE
===================================================== */

export const handlePaymentWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Erro ao verificar webhook:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // Pagamento concluído
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      const customerEmail = session.customer_email;

      if (!customerEmail) {
        return res.status(400).json({ error: 'Email não encontrado' });
      }

      // Atualizar usuário para PRO
      const { error } = await supabase
        .from('users')
        .update({
          plan: 'pro',
          credits: 999999
        })
        .eq('email', customerEmail);

      if (error) {
        console.error('Erro ao atualizar plano:', error);
      } else {
        console.log(`✅ Usuário ${customerEmail} atualizado para PRO`);
      }
    }

    res.json({ received: true });

  } catch (err) {
    console.error('❌ Erro interno webhook:', err);
    res.status(500).json({ error: 'Erro no webhook' });
  }
};

/* =====================================================
   🔥 STATUS DA ASSINATURA
===================================================== */

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