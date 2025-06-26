import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../services/database';

// Extender el tipo Request para incluir user y tenant
declare global {
  namespace Express {
    interface Request {
      user?: any;
      tenant?: any;
      tenantId?: string;
    }
  }
}

// Interfaz para el payload del JWT
interface JWTPayload {
  userId: string;
  iat: number;
  exp: number;
}

// Middleware principal de autenticación
export const authenticateToken = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      res.status(401).json({ error: 'Token de acceso requerido' });
      return;
    }

    // Verificar el token
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JWTPayload;

    // Buscar el usuario en la base de datos
    const user = await db.getClient().user.findUnique({
      where: { id: decoded.userId },
      include: { 
        tenant: {
          select: {
            id: true,
            name: true,
            plan: true,
            features: true,
            limits: true,
            isActive: true,
            subscriptionStatus: true,
          }
        }
      }
    });

    if (!user) {
      res.status(401).json({ error: 'Usuario no encontrado' });
      return;
    }

    if (!user.isActive) {
      res.status(401).json({ error: 'Usuario desactivado' });
      return;
    }

    if (!user.tenant.isActive) {
      res.status(401).json({ error: 'Cuenta suspendida' });
      return;
    }

    // Verificar estado de suscripción
    if (user.tenant.subscriptionStatus !== 'active' && user.tenant.plan !== 'starter') {
      res.status(402).json({ error: 'Suscripción inactiva. Actualiza tu método de pago.' });
      return;
    }

    // Agregar información al request
    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };

    req.tenant = user.tenant;
    req.tenantId = user.tenant.id;

    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(403).json({ error: 'Token inválido' });
      return;
    }

    if (error instanceof jwt.TokenExpiredError) {
      res.status(403).json({ error: 'Token expirado' });
      return;
    }

    console.error('Error en autenticación:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Middleware para verificar roles específicos
export const requireRole = (roles: string | string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const userRole = req.user?.role;
    const allowedRoles = Array.isArray(roles) ? roles : [roles];

    if (!userRole || !allowedRoles.includes(userRole)) {
      res.status(403).json({ error: 'Permisos insuficientes' });
      return;
    }

    next();
  };
};

// Middleware para verificar características del plan
export const requireFeature = (feature: string) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const tenantFeatures = req.tenant?.features as string[];

    if (!tenantFeatures || !tenantFeatures.includes(feature)) {
      res.status(403).json({ 
        error: 'Característica no disponible en tu plan',
        requiredFeature: feature,
        currentPlan: req.tenant?.plan,
        upgradeUrl: '/dashboard/billing'
      });
      return;
    }

    next();
  };
};

// Middleware para verificar límites de uso
export const checkUsageLimits = (limitType: 'conversations' | 'messages' | 'agents') => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const tenantId = req.tenantId!;
      const limits = await db.checkTenantLimits(tenantId);

      const limit = limits[limitType];
      if (limit && limit.exceeded) {
        res.status(429).json({
          error: `Límite de ${limitType} alcanzado`,
          used: limit.used,
          limit: limit.limit,
          upgradeUrl: '/dashboard/billing'
        });
        return;
      }

      next();
    } catch (error) {
      console.error('Error verificando límites:', error);
      res.status(500).json({ error: 'Error verificando límites de uso' });
    }
  };
};

// Middleware opcional para APIs públicas (widget)
export const optionalAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    // Sin token, continuar sin autenticación
    next();
    return;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JWTPayload;
    const user = await db.getClient().user.findUnique({
      where: { id: decoded.userId },
      include: { tenant: true }
    });

    if (user && user.isActive && user.tenant.isActive) {
      req.user = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      };
      req.tenant = user.tenant;
      req.tenantId = user.tenant.id;
    }
  } catch (error) {
    // Si hay error con el token, simplemente continuar sin autenticación
    console.log('Token opcional inválido:', error.message);
  }

  next();
};

// Middleware para validar tenant por widget ID
export const validateWidgetAccess = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const widgetId = req.params.widgetId || req.body.widgetId;

    if (!widgetId) {
      res.status(400).json({ error: 'Widget ID requerido' });
      return;
    }

    const widget = await db.getClient().widget.findUnique({
      where: { id: widgetId },
      include: { 
        tenant: {
          select: {
            id: true,
            name: true,
            plan: true,
            isActive: true,
            subscriptionStatus: true,
          }
        }
      }
    });

    if (!widget) {
      res.status(404).json({ error: 'Widget no encontrado' });
      return;
    }

    if (!widget.isActive) {
      res.status(403).json({ error: 'Widget desactivado' });
      return;
    }

    if (!widget.tenant.isActive) {
      res.status(403).json({ error: 'Cuenta suspendida' });
      return;
    }

    // Agregar información del widget y tenant al request
    req.widget = widget;
    req.tenant = widget.tenant;
    req.tenantId = widget.tenant.id;

    next();
  } catch (error) {
    console.error('Error validando acceso al widget:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Middleware para logging de accesos
export const logAccess = (req: Request, res: Response, next: NextFunction): void => {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.originalUrl;
  const ip = req.ip || req.connection.remoteAddress;
  const userAgent = req.get('User-Agent');
  const userId = req.user?.id || 'anonymous';

  console.log(`[${timestamp}] ${method} ${url} - User: ${userId} - IP: ${ip} - UA: ${userAgent}`);
  next();
};

// Middleware para CORS específico por tenant
export const tenantCors = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const origin = req.get('Origin');
    const referer = req.get('Referer');
    const widgetId = req.params.widgetId || req.body.widgetId;

    if (widgetId) {
      const widget = await db.getClient().widget.findUnique({
        where: { id: widgetId },
        select: { 
          config: true,
          tenant: { select: { name: true } }
        }
      });

      if (widget) {
        const allowedDomains = (widget.config as any)?.allowedDomains || [];
        
        // Si no hay dominios especificados, permitir todos
        if (allowedDomains.length === 0) {
          res.header('Access-Control-Allow-Origin', '*');
        } else {
          // Verificar si el origen está permitido
          const isAllowed = allowedDomains.some((domain: string) => {
            return origin?.includes(domain) || referer?.includes(domain);
          });

          if (isAllowed && origin) {
            res.header('Access-Control-Allow-Origin', origin);
          }
        }
      }
    }

    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin,X-Requested-With,Content-Type,Accept,Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }

    next();
  } catch (error) {
    console.error('Error en CORS por tenant:', error);
    next();
  }
};

// Tipos para TypeScript
export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
  tenant: {
    id: string;
    name: string;
    plan: string;
    features: string[];
    limits: any;
    isActive: boolean;
    subscriptionStatus: string;
  };
  tenantId: string;
  widget?: any;
}