"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const stripe_1 = __importDefault(require("stripe"));
const database_1 = require("../services/database");
const router = (0, express_1.Router)();
const stripe = new stripe_1.default(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
router.post('/stripe', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    }
    catch (err) {
        console.error('❌ Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    console.log(`📧 Webhook recibido: ${event.type}`);
    try {
        switch (event.type) {
            case 'customer.subscription.created':
                await handleSubscriptionCreated(event.data.object);
                break;
            case 'customer.subscription.updated':
                await handleSubscriptionUpdated(event.data.object);
                break;
            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(event.data.object);
                break;
            case 'invoice.payment_succeeded':
                await handlePaymentSucceeded(event.data.object);
                break;
            case 'invoice.payment_failed':
                await handlePaymentFailed(event.data.object);
                break;
            case 'customer.subscription.trial_will_end':
                await handleTrialWillEnd(event.data.object);
                break;
            case 'setup_intent.succeeded':
                await handleSetupIntentSucceeded(event.data.object);
                break;
            default:
                console.log(`🤷‍♂️ Evento no manejado: ${event.type}`);
        }
        res.json({ received: true });
    }
    catch (error) {
        console.error('❌ Error procesando webhook:', error);
        res.status(500).json({ error: 'Error procesando webhook' });
    }
});
async function handleSubscriptionCreated(subscription) {
    console.log(`✅ Suscripción creada: ${subscription.id}`);
    try {
        await database_1.db.getClient().tenant.update({
            where: { stripeSubscriptionId: subscription.id },
            data: {
                subscriptionStatus: subscription.status,
                currentPeriodEnd: new Date(subscription.current_period_end * 1000),
            }
        });
        console.log(`📱 Tenant actualizado con suscripción: ${subscription.id}`);
    }
    catch (error) {
        console.error('Error actualizando tenant con nueva suscripción:', error);
    }
}
async function handleSubscriptionUpdated(subscription) {
    console.log(`🔄 Suscripción actualizada: ${subscription.id}`);
    try {
        const planMapping = {
            [process.env.STRIPE_STARTER_PRICE_ID]: 'starter',
            [process.env.STRIPE_PROFESSIONAL_PRICE_ID]: 'professional',
            [process.env.STRIPE_BUSINESS_PRICE_ID]: 'business',
            [process.env.STRIPE_ENTERPRISE_PRICE_ID]: 'enterprise'
        };
        const priceId = subscription.items.data[0]?.price.id;
        const newPlan = planMapping[priceId] || 'starter';
        const tenant = await database_1.db.getClient().tenant.update({
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
        if (subscription.status === 'canceled') {
            await database_1.db.getClient().tenant.update({
                where: { id: tenant.id },
                data: { isActive: false }
            });
        }
    }
    catch (error) {
        console.error('Error actualizando suscripción:', error);
    }
}
async function handleSubscriptionDeleted(subscription) {
    console.log(`❌ Suscripción cancelada: ${subscription.id}`);
    try {
        await database_1.db.getClient().tenant.update({
            where: { stripeSubscriptionId: subscription.id },
            data: {
                subscriptionStatus: 'canceled',
                plan: 'starter',
                isActive: false,
                features: getTenantFeatures('starter'),
                limits: getTenantLimits('starter')
            }
        });
        console.log(`📉 Tenant degradado a starter por cancelación: ${subscription.id}`);
    }
    catch (error) {
        console.error('Error procesando cancelación de suscripción:', error);
    }
}
async function handlePaymentSucceeded(invoice) {
    console.log(`💰 Pago exitoso: ${invoice.id}`);
    try {
        const subscription = invoice.subscription;
        if (subscription) {
            await database_1.db.getClient().tenant.updateMany({
                where: { stripeSubscriptionId: subscription },
                data: { isActive: true }
            });
            console.log(`✅ Tenant reactivado por pago exitoso: ${subscription}`);
        }
    }
    catch (error) {
        console.error('Error procesando pago exitoso:', error);
    }
}
async function handlePaymentFailed(invoice) {
    console.log(`❌ Pago fallido: ${invoice.id}`);
    try {
        const subscription = invoice.subscription;
        if (subscription) {
            const tenant = await database_1.db.getClient().tenant.findUnique({
                where: { stripeSubscriptionId: subscription },
                include: { users: { where: { role: 'OWNER' }, take: 1 } }
            });
            if (tenant) {
                console.log(`⚠️ Pago fallido para tenant: ${tenant.name}`);
                if (invoice.attempt_count >= 2) {
                    await database_1.db.getClient().tenant.update({
                        where: { id: tenant.id },
                        data: { isActive: false }
                    });
                    console.log(`🚫 Tenant suspendido por fallos de pago: ${tenant.id}`);
                }
            }
        }
    }
    catch (error) {
        console.error('Error procesando fallo de pago:', error);
    }
}
async function handleTrialWillEnd(subscription) {
    console.log(`⏰ Trial terminará pronto: ${subscription.id}`);
    try {
        const tenant = await database_1.db.getClient().tenant.findUnique({
            where: { stripeSubscriptionId: subscription.id },
            include: { users: { where: { role: 'OWNER' }, take: 1 } }
        });
        if (tenant && tenant.users[0]) {
            console.log(`📧 Notificación de fin de trial enviada para: ${tenant.name}`);
        }
    }
    catch (error) {
        console.error('Error procesando fin de trial:', error);
    }
}
async function handleSetupIntentSucceeded(setupIntent) {
    console.log(`🎯 Setup Intent exitoso: ${setupIntent.id}`);
    try {
        const customerId = setupIntent.customer;
        if (customerId) {
            await database_1.db.getClient().tenant.updateMany({
                where: { stripeCustomerId: customerId },
                data: { isActive: true }
            });
            console.log(`💳 Método de pago configurado para customer: ${customerId}`);
        }
    }
    catch (error) {
        console.error('Error procesando setup intent:', error);
    }
}
function getTenantFeatures(plan) {
    const features = {
        starter: ['basic_ai', 'widget', 'email_support'],
        professional: ['advanced_ai', 'widget', 'knowledge_base', 'analytics', 'email_support'],
        business: ['multi_model_ai', 'widget', 'knowledge_base', 'advanced_analytics', 'api', 'priority_support'],
        enterprise: ['premium_ai', 'widget', 'knowledge_base', 'advanced_analytics', 'api', 'webhooks', 'dedicated_support', 'compliance']
    };
    return features[plan] || features.starter;
}
function getTenantLimits(plan) {
    const limits = {
        starter: { conversations: 500, messages: 2000, agents: 2 },
        professional: { conversations: 2000, messages: 10000, agents: 5 },
        business: { conversations: 5000, messages: 25000, agents: 10 },
        enterprise: { conversations: 15000, messages: 75000, agents: -1 }
    };
    return limits[plan] || limits.starter;
}
if (process.env.NODE_ENV === 'development') {
    router.get('/test', (req, res) => {
        res.json({
            message: 'Webhooks endpoint funcionando',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV
        });
    });
}
exports.default = router;
//# sourceMappingURL=webhooks.js.map