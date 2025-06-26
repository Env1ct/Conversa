"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const zod_1 = require("zod");
const stripe_1 = __importDefault(require("stripe"));
const database_1 = require("../services/database");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
const stripe = new stripe_1.default(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
const signupSchema = zod_1.z.object({
    name: zod_1.z.string().min(2, 'El nombre debe tener al menos 2 caracteres'),
    email: zod_1.z.string().email('Email inválido'),
    company: zod_1.z.string().min(2, 'El nombre de la empresa debe tener al menos 2 caracteres'),
    password: zod_1.z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
    plan: zod_1.z.enum(['starter', 'professional', 'business', 'enterprise'])
});
const loginSchema = zod_1.z.object({
    email: zod_1.z.string().email('Email inválido'),
    password: zod_1.z.string().min(1, 'Contraseña requerida')
});
const forgotPasswordSchema = zod_1.z.object({
    email: zod_1.z.string().email('Email inválido')
});
const resetPasswordSchema = zod_1.z.object({
    token: zod_1.z.string().min(1, 'Token requerido'),
    password: zod_1.z.string().min(8, 'La contraseña debe tener al menos 8 caracteres')
});
router.post('/signup', async (req, res) => {
    try {
        const validatedData = signupSchema.parse(req.body);
        const existingUser = await database_1.db.getClient().user.findUnique({
            where: { email: validatedData.email }
        });
        if (existingUser) {
            return res.status(400).json({
                error: 'Ya existe una cuenta con este email',
                code: 'USER_EXISTS'
            });
        }
        const hashedPassword = await bcryptjs_1.default.hash(validatedData.password, 12);
        const customer = await stripe.customers.create({
            email: validatedData.email,
            name: validatedData.name,
            metadata: {
                company: validatedData.company,
                plan: validatedData.plan,
                source: 'conversa_ai'
            }
        });
        const priceIds = {
            starter: process.env.STRIPE_STARTER_PRICE_ID,
            professional: process.env.STRIPE_PROFESSIONAL_PRICE_ID,
            business: process.env.STRIPE_BUSINESS_PRICE_ID,
            enterprise: process.env.STRIPE_ENTERPRISE_PRICE_ID
        };
        const priceId = priceIds[validatedData.plan];
        if (!priceId) {
            return res.status(400).json({ error: 'Plan no válido' });
        }
        const subscription = await stripe.subscriptions.create({
            customer: customer.id,
            items: [{ price: priceId }],
            payment_behavior: 'default_incomplete',
            payment_settings: { save_default_payment_method: 'on_subscription' },
            expand: ['latest_invoice.payment_intent'],
            metadata: {
                plan: validatedData.plan,
                company: validatedData.company
            }
        });
        const result = await database_1.db.createTenantWithUser({
            name: validatedData.company,
            plan: validatedData.plan,
            user: {
                email: validatedData.email,
                name: validatedData.name,
                password: hashedPassword
            },
            stripe: {
                customerId: customer.id,
                subscriptionId: subscription.id
            }
        });
        const token = jsonwebtoken_1.default.sign({ userId: result.user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.status(201).json({
            success: true,
            user: {
                id: result.user.id,
                email: result.user.email,
                name: result.user.name,
                role: result.user.role
            },
            tenant: {
                id: result.tenant.id,
                name: result.tenant.name,
                plan: result.tenant.plan
            },
            token,
            subscription: {
                id: subscription.id,
                status: subscription.status,
                clientSecret: subscription.latest_invoice?.payment_intent?.client_secret
            },
            onboarding: {
                chatbotId: result.chatbot.id,
                widgetId: result.widget.id
            }
        });
    }
    catch (error) {
        console.error('Error en signup:', error);
        if (error instanceof zod_1.z.ZodError) {
            return res.status(400).json({
                error: 'Datos inválidos',
                details: error.errors.map(e => ({
                    field: e.path.join('.'),
                    message: e.message
                }))
            });
        }
        if (error instanceof Error && error.message.includes('Stripe')) {
            return res.status(400).json({
                error: 'Error procesando el pago',
                details: error.message
            });
        }
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
router.post('/login', async (req, res) => {
    try {
        const validatedData = loginSchema.parse(req.body);
        const user = await database_1.db.getClient().user.findUnique({
            where: { email: validatedData.email },
            include: {
                tenant: {
                    select: {
                        id: true,
                        name: true,
                        plan: true,
                        features: true,
                        isActive: true,
                        subscriptionStatus: true
                    }
                }
            }
        });
        if (!user) {
            return res.status(401).json({
                error: 'Email o contraseña incorrectos',
                code: 'INVALID_CREDENTIALS'
            });
        }
        const isPasswordValid = await bcryptjs_1.default.compare(validatedData.password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({
                error: 'Email o contraseña incorrectos',
                code: 'INVALID_CREDENTIALS'
            });
        }
        if (!user.isActive) {
            return res.status(401).json({
                error: 'Cuenta desactivada. Contacta soporte.',
                code: 'ACCOUNT_DISABLED'
            });
        }
        if (!user.tenant.isActive) {
            return res.status(401).json({
                error: 'Cuenta suspendida. Contacta soporte.',
                code: 'ACCOUNT_SUSPENDED'
            });
        }
        await database_1.db.getClient().user.update({
            where: { id: user.id },
            data: { lastLoginAt: new Date() }
        });
        const token = jsonwebtoken_1.default.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role
            },
            tenant: {
                id: user.tenant.id,
                name: user.tenant.name,
                plan: user.tenant.plan,
                features: user.tenant.features
            },
            token
        });
    }
    catch (error) {
        console.error('Error en login:', error);
        if (error instanceof zod_1.z.ZodError) {
            return res.status(400).json({
                error: 'Datos inválidos',
                details: error.errors.map(e => ({
                    field: e.path.join('.'),
                    message: e.message
                }))
            });
        }
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
router.post('/logout', auth_1.authenticateToken, async (req, res) => {
    try {
        res.json({
            success: true,
            message: 'Sesión cerrada exitosamente'
        });
    }
    catch (error) {
        console.error('Error en logout:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
router.get('/me', auth_1.authenticateToken, async (req, res) => {
    try {
        const user = await database_1.db.getClient().user.findUnique({
            where: { id: req.user.id },
            include: {
                tenant: {
                    select: {
                        id: true,
                        name: true,
                        plan: true,
                        features: true,
                        limits: true,
                        subscriptionStatus: true,
                        currentPeriodEnd: true
                    }
                }
            }
        });
        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }
        res.json({
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                lastLoginAt: user.lastLoginAt
            },
            tenant: user.tenant
        });
    }
    catch (error) {
        console.error('Error obteniendo información del usuario:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
router.post('/forgot-password', async (req, res) => {
    try {
        const validatedData = forgotPasswordSchema.parse(req.body);
        const user = await database_1.db.getClient().user.findUnique({
            where: { email: validatedData.email }
        });
        if (!user) {
            return res.json({
                success: true,
                message: 'Si el email existe, recibirás instrucciones para resetear tu contraseña'
            });
        }
        const resetToken = jsonwebtoken_1.default.sign({ userId: user.id, type: 'password_reset' }, process.env.JWT_SECRET, { expiresIn: '1h' });
        console.log(`Reset token para ${user.email}: ${resetToken}`);
        res.json({
            success: true,
            message: 'Si el email existe, recibirás instrucciones para resetear tu contraseña',
            ...(process.env.NODE_ENV === 'development' && { resetToken })
        });
    }
    catch (error) {
        console.error('Error en forgot-password:', error);
        if (error instanceof zod_1.z.ZodError) {
            return res.status(400).json({
                error: 'Email inválido',
                details: error.errors
            });
        }
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
router.post('/reset-password', async (req, res) => {
    try {
        const validatedData = resetPasswordSchema.parse(req.body);
        const decoded = jsonwebtoken_1.default.verify(validatedData.token, process.env.JWT_SECRET);
        if (decoded.type !== 'password_reset') {
            return res.status(400).json({ error: 'Token inválido' });
        }
        const hashedPassword = await bcryptjs_1.default.hash(validatedData.password, 12);
        await database_1.db.getClient().user.update({
            where: { id: decoded.userId },
            data: { password: hashedPassword }
        });
        res.json({
            success: true,
            message: 'Contraseña actualizada exitosamente'
        });
    }
    catch (error) {
        console.error('Error en reset-password:', error);
        if (error instanceof jsonwebtoken_1.default.JsonWebTokenError) {
            return res.status(400).json({ error: 'Token inválido o expirado' });
        }
        if (error instanceof zod_1.z.ZodError) {
            return res.status(400).json({
                error: 'Datos inválidos',
                details: error.errors
            });
        }
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
router.post('/verify-token', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) {
            return res.status(400).json({ error: 'Token requerido' });
        }
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        const user = await database_1.db.getClient().user.findUnique({
            where: { id: decoded.userId },
            select: { id: true, email: true, isActive: true }
        });
        if (!user || !user.isActive) {
            return res.status(401).json({ error: 'Token inválido' });
        }
        res.json({
            valid: true,
            userId: user.id,
            email: user.email
        });
    }
    catch (error) {
        if (error instanceof jsonwebtoken_1.default.JsonWebTokenError) {
            return res.json({ valid: false, error: 'Token inválido' });
        }
        console.error('Error verificando token:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
exports.default = router;
//# sourceMappingURL=auth.js.map