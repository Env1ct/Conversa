"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tenantCors = exports.logAccess = exports.validateWidgetAccess = exports.optionalAuth = exports.checkUsageLimits = exports.requireFeature = exports.requireRole = exports.authenticateToken = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const database_1 = require("../services/database");
const authenticateToken = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (!token) {
            res.status(401).json({ error: 'Token de acceso requerido' });
            return;
        }
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        const user = await database_1.db.getClient().user.findUnique({
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
        if (user.tenant.subscriptionStatus !== 'active' && user.tenant.plan !== 'starter') {
            res.status(402).json({ error: 'Suscripción inactiva. Actualiza tu método de pago.' });
            return;
        }
        req.user = {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
        };
        req.tenant = user.tenant;
        req.tenantId = user.tenant.id;
        next();
    }
    catch (error) {
        if (error instanceof jsonwebtoken_1.default.JsonWebTokenError) {
            res.status(403).json({ error: 'Token inválido' });
            return;
        }
        if (error instanceof jsonwebtoken_1.default.TokenExpiredError) {
            res.status(403).json({ error: 'Token expirado' });
            return;
        }
        console.error('Error en autenticación:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};
exports.authenticateToken = authenticateToken;
const requireRole = (roles) => {
    return (req, res, next) => {
        const userRole = req.user?.role;
        const allowedRoles = Array.isArray(roles) ? roles : [roles];
        if (!userRole || !allowedRoles.includes(userRole)) {
            res.status(403).json({ error: 'Permisos insuficientes' });
            return;
        }
        next();
    };
};
exports.requireRole = requireRole;
const requireFeature = (feature) => {
    return (req, res, next) => {
        const tenantFeatures = req.tenant?.features;
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
exports.requireFeature = requireFeature;
const checkUsageLimits = (limitType) => {
    return async (req, res, next) => {
        try {
            const tenantId = req.tenantId;
            const limits = await database_1.db.checkTenantLimits(tenantId);
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
        }
        catch (error) {
            console.error('Error verificando límites:', error);
            res.status(500).json({ error: 'Error verificando límites de uso' });
        }
    };
};
exports.checkUsageLimits = checkUsageLimits;
const optionalAuth = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        next();
        return;
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        const user = await database_1.db.getClient().user.findUnique({
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
    }
    catch (error) {
        console.log('Token opcional inválido:', error.message);
    }
    next();
};
exports.optionalAuth = optionalAuth;
const validateWidgetAccess = async (req, res, next) => {
    try {
        const widgetId = req.params.widgetId || req.body.widgetId;
        if (!widgetId) {
            res.status(400).json({ error: 'Widget ID requerido' });
            return;
        }
        const widget = await database_1.db.getClient().widget.findUnique({
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
        req.widget = widget;
        req.tenant = widget.tenant;
        req.tenantId = widget.tenant.id;
        next();
    }
    catch (error) {
        console.error('Error validando acceso al widget:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};
exports.validateWidgetAccess = validateWidgetAccess;
const logAccess = (req, res, next) => {
    const timestamp = new Date().toISOString();
    const method = req.method;
    const url = req.originalUrl;
    const ip = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');
    const userId = req.user?.id || 'anonymous';
    console.log(`[${timestamp}] ${method} ${url} - User: ${userId} - IP: ${ip} - UA: ${userAgent}`);
    next();
};
exports.logAccess = logAccess;
const tenantCors = async (req, res, next) => {
    try {
        const origin = req.get('Origin');
        const referer = req.get('Referer');
        const widgetId = req.params.widgetId || req.body.widgetId;
        if (widgetId) {
            const widget = await database_1.db.getClient().widget.findUnique({
                where: { id: widgetId },
                select: {
                    config: true,
                    tenant: { select: { name: true } }
                }
            });
            if (widget) {
                const allowedDomains = widget.config?.allowedDomains || [];
                if (allowedDomains.length === 0) {
                    res.header('Access-Control-Allow-Origin', '*');
                }
                else {
                    const isAllowed = allowedDomains.some((domain) => {
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
    }
    catch (error) {
        console.error('Error en CORS por tenant:', error);
        next();
    }
};
exports.tenantCors = tenantCors;
//# sourceMappingURL=auth.js.map