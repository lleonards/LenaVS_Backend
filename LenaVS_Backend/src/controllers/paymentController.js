import stripe from "../config/stripe.js";
import { supabase } from "../config/supabase.js";

/**
 * =====================================================
 * 💳 CRIAR SESSÃO DE PAGAMENTO
 * =====================================================
 */
export const createPaymentSession = async (req, res) => {
  try {
    const { currency } = req.body;
    const userId = req.user.id;
    const userEmail = req.user.email;

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

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: userEmail,
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
        userId: userId,
      },
    });

    return res.status(200).json({
      success: true,
      sessionUrl: session.url,
    });

  } catch (error) {
    console.error("Erro ao criar sessão Stripe:", error);
    return res.status(500).json({
      error: "Erro ao criar sessão de pagamento"
    });
  }
};


/**
 * =====================================================
 * 🔔 WEBHOOK STRIPE
 * =====================================================
 */
export const handlePaymentWebhook = async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];

    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    switch (event.type) {

      /**
       * ✅ Pagamento concluído
       */
      case "checkout.session.completed": {
        const session = event.data.object;

        const userId = session.metadata.userId;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        console.log("Pagamento concluído para usuário:", userId);

        await supabase
          .from("users")
          .update({
            plan: "pro",
            subscription_status: "active",
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            updated_at: new Date()
          })
          .eq("id", userId);

        break;
      }

      /**
       * ❌ Assinatura cancelada
       */
      case "customer.subscription.deleted": {
        const subscription = event.data.object;

        console.log("Assinatura cancelada:", subscription.id);

        await supabase
          .from("users")
          .update({
            plan: "free",
            subscription_status: "canceled",
            updated_at: new Date()
          })
          .eq("stripe_subscription_id", subscription.id);

        break;
      }

      default:
        console.log(`Evento não tratado: ${event.type}`);
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error("Erro no webhook Stripe:", error);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }
};


/**
 * =====================================================
 * 📊 STATUS DA ASSINATURA
 * =====================================================
 */
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
        error: "Usuário não encontrado"
      });
    }

    return res.status(200).json({
      success: true,
      subscription: {
        plan: user.plan,
        status: user.subscription_status,
        subscriptionId: user.stripe_subscription_id || null
      },
    });

  } catch (error) {
    console.error("Erro ao obter status:", error);
    return res.status(500).json({
      error: "Erro ao obter status"
    });
  }
};