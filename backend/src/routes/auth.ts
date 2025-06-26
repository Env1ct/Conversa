import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import Stripe from 'stripe';
import { db } from '../services/database';
import { authenticateToken } from '../middleware/auth';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-05-28.basil' });

// Schemas de validación
const signupSchema = z.object({
  name: z.string().min(2, 'El nombre debe tener al menos 2 caracteres'),
  email: z.string().email('Email inválido'),
  company: z.string().min(2, 'El nombre de la empresa debe tener al menos 2 caracteres'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  plan: z.enum(['starter', 'professional', 'business', 'enterprise'])
});

const loginSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(1, 'Contraseña requerida')
});

const forgotPasswordSchema = z.object({
  email: z.string().email('Email inválido')
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token requerido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres')
});

// POST /api/auth/signup - Registro de usuario
router.post('/signup', async (req: Request, res: Response): Promise<void> => {
  try {
    // Validar datos de entrada
    const validatedData = signupSchema.parse(req.body);

    // Verificar si el usuario ya existe
    const existingUser = await db.getClient().user.findUnique({
      where: { email: validatedData.email }
    });

    if (existingUser) {
      res.status(400).json({ 
        error: 'Ya existe una cuenta con este email',
        code: 'USER_EXISTS'
      });
      return;
    }

    // Hash de la contraseña
    const hashedPassword = await bcrypt.hash(validatedData.password, 12);

    // Crear cliente en Stripe
    const customer = await stripe.customers.create({
      email: validatedData.email,
      name: validatedData.name,
      metadata: { 
        company: validatedData.company, 
        plan: validatedData.plan,
        source: 'conversa_ai'
      }
    });

    // Obtener Price ID basado en el plan
    const priceIds = {
      starter: process.env.STRIPE_STARTER_PRICE_ID,
      professional: process.env.STRIPE_PROFESSIONAL_PRICE_ID,
      business: process.env.STRIPE_BUSINESS_PRICE_ID,
      enterprise: process.env.STRIPE_ENTERPRISE_PRICE_ID
    };

    const priceId = priceIds[validatedData.plan];
    if (!priceId) {
      res.status(400).json({ error: 'Plan no válido' });
      return;
    }

    // Crear suscripción en Stripe
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

    // Crear tenant y usuario en la base de datos
    const result = await db.createTenantWithUser({
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

    // Generar JWT
    const token = jwt.sign(
      { userId: result.user.id },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );

    // Respuesta exitosa
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
        clientSecret: (subscription.latest_invoice as any)?.payment_intent?.client_secret
      },
      onboarding: {
        chatbotId: result.chatbot.id,
        widgetId: result.widget.id
      }
    });

  } catch (error) {
    console.error('Error en signup:', error);

    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Datos inválidos',
        details: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
      return;
    }

    if (error instanceof Error && error.message.includes('Stripe')) {
      res.status(400).json({
        error: 'Error procesando el pago',
        details: error.message
      });
      return;
    }

    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/auth/login - Inicio de sesión
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    // Validar datos de entrada
    const validatedData = loginSchema.parse(req.body);

    // Buscar usuario
    const user = await db.getClient().user.findUnique({
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
      res.status(401).json({ 
        error: 'Email o contraseña incorrectos',
        code: 'INVALID_CREDENTIALS'
      });
      return;
    }

    // Verificar contraseña
    const isPasswordValid = await bcrypt.compare(validatedData.password, user.password);
    if (!isPasswordValid) {
      res.status(401).json({ 
        error: 'Email o contraseña incorrectos',
        code: 'INVALID_CREDENTIALS'
      });
      return;
    }

    // Verificar que el usuario esté activo
    if (!user.isActive) {
      res.status(401).json({ 
        error: 'Cuenta desactivada. Contacta soporte.',
        code: 'ACCOUNT_DISABLED'
      });
      return;
    }

    // Verificar que el tenant esté activo
    if (!user.tenant.isActive) {
      res.status(401).json({ 
        error: 'Cuenta suspendida. Contacta soporte.',
        code: 'ACCOUNT_SUSPENDED'
      });
      return;
    }

    // Actualizar último login
    await db.getClient().user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() }
    });

    // Generar JWT
    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );

    // Respuesta exitosa
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

  } catch (error) {
    console.error('Error en login:', error);

    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Datos inválidos',
        details: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
      return;
    }

    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/auth/logout - Cerrar sesión
router.post('/logout', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    res.json({
      success: true,
      message: 'Sesión cerrada exitosamente'
    });

  } catch (error) {
    console.error('Error en logout:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/auth/me - Información del usuario actual
router.get('/me', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await db.getClient().user.findUnique({
      where: { id: req.user!.id },
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
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
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

  } catch (error) {
    console.error('Error obteniendo información del usuario:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/auth/forgot-password - Solicitar reset de contraseña
router.post('/forgot-password', async (req: Request, res: Response): Promise<void> => {
  try {
    const validatedData = forgotPasswordSchema.parse(req.body);

    const user = await db.getClient().user.findUnique({
      where: { email: validatedData.email }
    });

    // Por seguridad, siempre respondemos éxito incluso si el email no existe
    if (!user) {
      res.json({
        success: true,
        message: 'Si el email existe, recibirás instrucciones para resetear tu contraseña'
      });
      return;
    }

    // Generar token de reset (válido por 1 hora)
    const resetToken = jwt.sign(
      { userId: user.id, type: 'password_reset' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );

    console.log(`Reset token para ${user.email}: ${resetToken}`);

    res.json({
      success: true,
      message: 'Si el email existe, recibirás instrucciones para resetear tu contraseña',
      // En desarrollo, incluir el token
      ...(process.env.NODE_ENV === 'development' && { resetToken })
    });

  } catch (error) {
    console.error('Error en forgot-password:', error);

    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Email inválido',
        details: error.errors
      });
      return;
    }

    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/auth/reset-password - Resetear contraseña
router.post('/reset-password', async (req: Request, res: Response): Promise<void> => {
  try {
    const validatedData = resetPasswordSchema.parse(req.body);

    // Verificar token
    const decoded = jwt.verify(validatedData.token, process.env.JWT_SECRET!) as any;

    if (decoded.type !== 'password_reset') {
      res.status(400).json({ error: 'Token inválido' });
      return;
    }

    // Hash de la nueva contraseña
    const hashedPassword = await bcrypt.hash(validatedData.password, 12);

    // Actualizar contraseña
    await db.getClient().user.update({
      where: { id: decoded.userId },
      data: { password: hashedPassword }
    });

    res.json({
      success: true,
      message: 'Contraseña actualizada exitosamente'
    });

  } catch (error) {
    console.error('Error en reset-password:', error);

    if (error instanceof jwt.JsonWebTokenError) {
      res.status(400).json({ error: 'Token inválido o expirado' });
      return;
    }

    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Datos inválidos',
        details: error.errors
      });
      return;
    }

    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/auth/verify-token - Verificar si un token es válido
router.post('/verify-token', async (req: Request, res: Response): Promise<void> => {
  try {
    const { token } = req.body;

    if (!token) {
      res.status(400).json({ error: 'Token requerido' });
      return;
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

    const user = await db.getClient().user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, isActive: true }
    });

    if (!user || !user.isActive) {
      res.status(401).json({ error: 'Token inválido' });
      return;
    }

    res.json({
      valid: true,
      userId: user.id,
      email: user.email
    });

  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      res.json({ valid: false, error: 'Token inválido' });
      return;
    }

    console.error('Error verificando token:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;