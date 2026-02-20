import stripe from "../config/stripe.js";

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

      case "checkout.session.completed":
        const session = event.data.object;

        const userId = session.metadata.userId;

        console.log("Pagamento concluído para usuário:", userId);

        // TODO: Atualizar plano no banco (Supabase)
        // Exemplo:
        // await supabase
        //   .from("users")
        //   .update({ plan: "pro", subscription_status: "active" })
        //   .eq("id", userId);

        break;

      case "customer.subscription.deleted":
        const subscription = event.data.object;

        console.log("Assinatura cancelada:", subscription.id);

        // TODO: Atualizar usuário para plano free

        break;

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
 * Obtém status da assinatura
 */
export const getSubscriptionStatus = async (req, res) => {
  try {
    const userId = req.user.id;

    // Aqui você deve buscar no banco real
    // Exemplo com Supabase depois

    return res.status(200).json({
      success: true,
      subscription: {
        status: "free",
        plan: "free",
        expiresAt: null,
      },
    });

  } catch (error) {
    console.error("Erro ao obter status:", error);
    return res.status(500).json({ error: "Erro ao obter status" });
  }
};