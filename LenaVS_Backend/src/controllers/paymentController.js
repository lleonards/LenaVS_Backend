import stripe from "../config/stripe.js";
import { supabase } from "../config/supabase.js";

/**
 * Cria sessão de pagamento Stripe
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
    return res.status(500).json({ error: "Erro ao criar sessão de pagamento" });
  }
};


/**
 * Webhook Stripe
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
       * PAGAMENTO CONFIRMADO
       */
      case "checkout.session.completed": {
        const session = event.data.object;

        const userId = session.metadata.userId;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        console.log("Pagamento concluído para usuário:", userId);

        const { error } = await supabase
          .from("users")
          .update({
            plan: "pro",
            subscription_status: "active",
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
          })
          .eq("id", userId);

        if (error) {
          console.error("Erro ao atualizar usuário:", error);
        }

        break;
      }

      /**
       * ASSINATURA CANCELADA
       */
      case "customer.subscription.deleted": {
        const subscription = event.data.object;

        console.log("Assinatura cancelada:", subscription.id);

        const { error } = await supabase
          .from("users")
          .update({
            plan: "free",
            subscription_status: "canceled",
          })
          .eq("stripe_subscription_id", subscription.id);

        if (error) {
          console.error("Erro ao cancelar assinatura:", error);
        }

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
 * Obtém status real da assinatura
 */
export const getSubscriptionStatus = async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from("users")
      .select("plan, subscription_status")
      .eq("id", userId)
      .single();

    if (error) {
      return res.status(500).json({ error: "Erro ao buscar assinatura" });
    }

    return res.status(200).json({
      success: true,
      subscription: {
        status: data.subscription_status,
        plan: data.plan,
      },
    });

  } catch (error) {
    console.error("Erro ao obter status:", error);
    return res.status(500).json({ error: "Erro ao obter status" });
  }
};