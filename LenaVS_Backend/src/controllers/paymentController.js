import stripe from "../config/stripe.js";
import { supabase } from "../config/supabase.js";

/* =====================================================
   💳 CRIAR SESSÃO DE PAGAMENTO
===================================================== */

export const createPaymentSession = async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;
    const { currency } = req.body;

    if (!currency) {
      return res.status(400).json({ error: "Moeda não informada" });
    }

    const priceId =
      currency === "USD"
        ? process.env.STRIPE_PRICE_USD
        : process.env.STRIPE_PRICE_BRL;

    if (!priceId) {
      return res.status(500).json({ error: "Price ID não configurado" });
    }

    // 🔎 Verificar se já existe customer salvo
    const { data: user } = await supabase
      .from("users")
      .select("stripe_customer_id")
      .eq("id", userId)
      .single();

    let customerId = user?.stripe_customer_id;

    // 🆕 Criar cliente no Stripe se não existir
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: userEmail,
        metadata: { userId }
      });

      customerId = customer.id;

      await supabase
        .from("users")
        .update({ stripe_customer_id: customerId })
        .eq("id", userId);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL}/success`,
      cancel_url: `${process.env.FRONTEND_URL}/upgrade`,
      metadata: {
        userId,
      },
    });

    return res.status(200).json({
      success: true,
      sessionUrl: session.url,
    });

  } catch (error) {
    console.error("Erro ao criar sessão Stripe:", error);
    return res.status(500).json({
      error: "Erro ao criar sessão de pagamento",
    });
  }
};

/* =====================================================
   🔔 WEBHOOK STRIPE
===================================================== */

export const handlePaymentWebhook = async (req, res) => {
  let event;

  try {
    const sig = req.headers["stripe-signature"];

    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Erro ao validar webhook:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {

      /* ==========================================
         ✅ CHECKOUT CONCLUÍDO
      ========================================== */
      case "checkout.session.completed": {
        const session = event.data.object;

        const userId = session.metadata.userId;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        await supabase
          .from("users")
          .update({
            plan: "pro",
            subscription_status: "active",
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            credits: null, // PRO não usa créditos
            updated_at: new Date().toISOString()
          })
          .eq("id", userId);

        console.log("Usuário atualizado para PRO:", userId);
        break;
      }

      /* ==========================================
         ❌ ASSINATURA CANCELADA
      ========================================== */
      case "customer.subscription.deleted": {
        const subscription = event.data.object;

        await supabase
          .from("users")
          .update({
            plan: "free",
            subscription_status: "canceled",
            credits: 0,
            updated_at: new Date().toISOString()
          })
          .eq("stripe_subscription_id", subscription.id);

        console.log("Usuário voltou para FREE");
        break;
      }

      /* ==========================================
         🔄 ASSINATURA ATUALIZADA
      ========================================== */
      case "customer.subscription.updated": {
        const subscription = event.data.object;

        const status = subscription.status;

        await supabase
          .from("users")
          .update({
            subscription_status: status,
            updated_at: new Date().toISOString()
          })
          .eq("stripe_subscription_id", subscription.id);

        console.log("Status atualizado:", status);
        break;
      }

      default:
        console.log(`Evento não tratado: ${event.type}`);
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error("Erro processando webhook:", error);
    return res.status(500).json({ error: "Erro interno webhook" });
  }
};

/* =====================================================
   📊 STATUS DA ASSINATURA
===================================================== */

export const getSubscriptionStatus = async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: user, error } = await supabase
      .from("users")
      .select("plan, subscription_status, stripe_subscription_id")
      .eq("id", userId)
      .single();

    if (error || !user) {
      return res.status(404).json({
        error: "Usuário não encontrado",
      });
    }

    return res.status(200).json({
      success: true,
      subscription: {
        plan: user.plan,
        status: user.subscription_status,
        subscriptionId: user.stripe_subscription_id || null,
      },
    });

  } catch (error) {
    console.error("Erro ao obter status:", error);
    return res.status(500).json({
      error: "Erro ao obter status",
    });
  }
};
