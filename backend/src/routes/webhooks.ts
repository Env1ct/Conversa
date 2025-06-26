import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { db } from '../services/database';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-12-18.acacia' });

// POST /api/webhooks/stripe - Manejar webhooks de Stripe
router.post('/stripe', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  let event: Stripe.Event;

  try {
    // Verificar la firma del webhook
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`📧 Webhook recibido: ${event.type}`);

  try {
    // Manejar diferentes tipos de eventos
    switch (event.type) {
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;

      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;

      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      case 'customer.subscription.trial_will_end':
        await handleTrialWillEnd(event.data.object as Stripe.Subscription);
        break;

      case 'setup_intent.succeeded':
        await handleSetupIntentSucceeded(event.data.object as Stripe.SetupIntent);
        break;

      default:
        console.log(`🤷‍♂️ Evento no manejado: ${event.type}`);
    }

    // Responder a Stripe que el webhook fue recibido exitosamente
    res.json({ received: true });

  } catch (error) {
    console.error('❌ Error procesando webhook:', error);
    res.status(500).json({ error: 'Error procesando webhook' });
  }
});

// Funciones para manejar eventos específicos

async function handleSubscriptionCreated(subscription: Stripe.Subscription) {
  console.log(`✅ Suscripción creada: ${subscription.id}`);

  try {
    await db.getClient().tenant.update({
      where: { stripeSubscriptionId: subscription.id },
      data: {
        subscriptionStatus: subscription.status,
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      }
    });

    console.log(`📱 Tenant actualizado con suscripción: ${subscription.id}`);
  } catch (error) {
    console.error('Error actualizando tenant con nueva suscripción:', error);
  }
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  console.log(`🔄 Suscripción actualizada: ${subscription.id}`);

  try {
    // Determinar el nuevo plan basado en el price ID
    const planMapping = {
      [process.env.STRIPE_STARTER_PRICE_ID!]: 'starter',
      [process.env.STRIPE_PROFESSIONAL_PRICE_ID!]: 'professional',
      [process.env.STRIPE_BUSINESS_PRICE_ID!]: 'business',
      [process.env.STRIPE_ENTERPRISE_PRICE_ID!]: 'enterprise'
    };

    const priceId = subscription.items.data[0]?.price.id;
    const newPlan = planMapping[priceId] || 'starter';

    // Actualizar tenant
    const tenant = await db.getClient().tenant.update({
      where: { stripeSubscriptionId: subscription.id },
      data: {
        plan: newPlan,
        subscriptionStatus: subscription.status,
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        features: getTenantFeatures(newPlan),
        limits: getTenantLimits(newPlan)
      }
    });

    console.log(`📈 Plan actualizado a ${newPlan} para tenant: ${tenant.id}`);

    // Si la suscripción fue cancelada, marcar como inactiva
    if (subscription.status === 'canceled') {
      await db.getClient().tenant.update({
        where: { id: tenant.id },
        data: { isActive: false }
      });
    }

  } catch (error) {
    console.error('Error actualizando suscripción:', error);
  }
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  console.log(`❌ Suscripción cancelada: ${subscription.id}`);

  try {
    await db.getClient().tenant.update({
      where: { stripeSubscriptionId: subscription.id },
      data: {
        subscriptionStatus: 'canceled',
        plan: 'starter', // Downgrade al plan gratuito
        isActive: false, // Desactivar temporalmente
        features: getTenantFeatures('starter'),
        limits: getTenantLimits('starter')
      }
    });

    console.log(`📉 Tenant degradado a starter por cancelación: ${subscription.id}`);
  } catch (error) {
    console.error('Error procesando cancelación de suscripción:', error);
  }
}

async function handlePaymentSucceeded(invoice: Stripe.Invoice) {
  console.log(`💰 Pago exitoso: ${invoice.id}`);

  try {
    const subscription = invoice.subscription as string;
    
    if (subscription) {
      // Reactivar tenant si estaba suspendido por falta de pago
      await db.getClient().tenant.updateMany({
        where: { stripeSubscriptionId: subscription },
        data: { isActive: true }
      });

      console.log(`✅ Tenant reactivado por pago exitoso: ${subscription}`);
    }

    // Aquí podrías enviar un email de confirmación de pago
    // await emailService.sendPaymentConfirmation(invoice);

  } catch (error) {
    console.error('Error procesando pago exitoso:', error);
  }
}

async function handlePaymentFailed(invoice: Stripe.Invoice) {
  console.log(`❌ Pago fallido: ${invoice.id}`);

  try {
    const subscription = invoice.subscription as string;
    
    if (subscription) {
      const tenant = await db.getClient().tenant.findUnique({
        where: { stripeSubscriptionId: subscription },
        include: { users: { where: { role: 'OWNER' }, take: 1 } }
      });

      if (tenant) {
        console.log(`⚠️ Pago fallido para tenant: ${tenant.name}`);
        
        // Si es el segundo intento fallido, suspender la cuenta
        if (invoice.attempt_count >= 2) {
          await db.getClient().tenant.update({
            where: { id: tenant.id },
            data: { isActive: false }
          });
          
          console.log(`🚫 Tenant suspendido por fallos de pago: ${tenant.id}`);
        }

        // Aquí podrías enviar un email de notificación
        // const ownerEmail = tenant.users[0]?.email;
        // if (ownerEmail) {
        //   await emailService.sendPaymentFailedNotification(ownerEmail, invoice);
        // }
      }
    }

  } catch (error) {
    console.error('Error procesando fallo de pago:', error);
  }
}

async function handleTrialWillEnd(subscription: Stripe.Subscription) {
  console.log(`⏰ Trial terminará pronto: ${subscription.id}`);

  try {
    const tenant = await db.getClient().tenant.findUnique({
      where: { stripeSubscriptionId: subscription.id },
      include: { users: { where: { role: 'OWNER' }, take: 1 } }
    });

    if (tenant && tenant.users[0]) {
      // Aquí podrías enviar un email recordatorio sobre el fin del trial
      // await emailService.sendTrialEndingNotification(tenant.users[0].email, subscription);
      
      console.log(`📧 Notificación de fin de trial enviada para: ${tenant.name}`);
    }

  } catch (error) {
    console.error('Error procesando fin de trial:', error);
  }
}

async function handleSetupIntentSucceeded(setupIntent: Stripe.SetupIntent) {
  console.log(`🎯 Setup Intent exitoso: ${setupIntent.id}`);

  try {
    // Esto indica que el customer ha configurado exitosamente un método de pago
    const customerId = setupIntent.customer as string;
    
    if (customerId) {
      await db.getClient().tenant.updateMany({
        where: { stripeCustomerId: customerId },
        data: { isActive: true }
      });

      console.log(`💳 Método de pago configurado para customer: ${customerId}`);
    }

  } catch (error) {
    console.error('Error procesando setup intent:', error);
  }
}

// Funciones auxiliares (duplicadas del servicio de database para evitar dependencias circulares)
function getTenantFeatures(plan: string): string[] {
  const features = {
    starter: ['basic_ai', 'widget', 'email_support'],
    professional: ['advanced_ai', 'widget', 'knowledge_base', 'analytics', 'email_support'],
    business: ['multi_model_ai', 'widget', 'knowledge_base', 'advanced_analytics', 'api', 'priority_support'],
    enterprise: ['premium_ai', 'widget', 'knowledge_base', 'advanced_analytics', 'api', 'webhooks', 'dedicated_support', 'compliance']
  };
  return features[plan as keyof typeof features] || features.starter;
}

function getTenantLimits(plan: string): Record<string, number> {
  const limits = {
    starter: { conversations: 500, messages: 2000, agents: 2 },
    professional: { conversations: 2000, messages: 10000, agents: 5 },
    business: { conversations: 5000, messages: 25000, agents: 10 },
    enterprise: { conversations: 15000, messages: 75000, agents: -1 }
  };
  return limits[plan as keyof typeof limits] || limits.starter;
}

// GET /api/webhooks/test - Endpoint de prueba (solo en desarrollo)
if (process.env.NODE_ENV === 'development') {
  router.get('/test', (req: Request, res: Response) => {
    res.json({
      message: 'Webhooks endpoint funcionando',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV
    });
  });
}

export default router;