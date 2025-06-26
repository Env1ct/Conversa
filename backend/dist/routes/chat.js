"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const database_1 = require("../services/database");
const ai_1 = require("../services/ai");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
const chatLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Demasiados mensajes. Intenta más tarde.',
    standardHeaders: true,
    legacyHeaders: false,
});
const chatMessageSchema = zod_1.z.object({
    message: zod_1.z.string().min(1, 'El mensaje no puede estar vacío').max(1000, 'El mensaje es demasiado largo'),
    conversationId: zod_1.z.string().uuid().optional(),
    widgetId: zod_1.z.string().uuid('Widget ID inválido'),
    userId: zod_1.z.string().optional(),
    metadata: zod_1.z.object({
        userAgent: zod_1.z.string().optional(),
        url: zod_1.z.string().optional(),
        referrer: zod_1.z.string().optional(),
    }).optional()
});
const conversationSchema = zod_1.z.object({
    widgetId: zod_1.z.string().uuid('Widget ID inválido'),
    userId: zod_1.z.string().optional(),
    metadata: zod_1.z.object({
        userAgent: zod_1.z.string().optional(),
        url: zod_1.z.string().optional(),
        referrer: zod_1.z.string().optional(),
        location: zod_1.z.object({
            country: zod_1.z.string().optional(),
            city: zod_1.z.string().optional(),
        }).optional(),
    }).optional()
});
router.post('/message', auth_1.tenantCors, chatLimiter, auth_1.validateWidgetAccess, (0, auth_1.checkUsageLimits)('conversations'), async (req, res) => {
    try {
        const validatedData = chatMessageSchema.parse(req.body);
        const widget = await database_1.db.getClient().widget.findUnique({
            where: { id: validatedData.widgetId },
            include: {
                chatbot: true,
                tenant: {
                    select: {
                        id: true,
                        name: true,
                        plan: true,
                        limits: true
                    }
                }
            }
        });
        if (!widget || !widget.isActive) {
            return res.status(404).json({ error: 'Widget no encontrado o inactivo' });
        }
        if (!widget.chatbot || !widget.chatbot.isActive) {
            return res.status(503).json({ error: 'Chatbot no disponible' });
        }
        let conversation;
        if (validatedData.conversationId) {
            conversation = await database_1.db.getClient().conversation.findUnique({
                where: { id: validatedData.conversationId },
                include: {
                    messages: {
                        orderBy: { createdAt: 'desc' },
                        take: 10
                    }
                }
            });
            if (!conversation || conversation.tenantId !== widget.tenantId) {
                return res.status(404).json({ error: 'Conversación no encontrada' });
            }
        }
        if (!conversation) {
            conversation = await database_1.db.getClient().conversation.create({
                data: {
                    tenantId: widget.tenantId,
                    widgetId: widget.id,
                    chatbotId: widget.chatbot.id,
                    userId: validatedData.userId || `anonymous_${Date.now()}`,
                    status: 'ACTIVE'
                },
                include: {
                    messages: {
                        orderBy: { createdAt: 'desc' },
                        take: 10
                    }
                }
            });
        }
        const userMessage = await database_1.db.getClient().message.create({
            data: {
                conversationId: conversation.id,
                content: validatedData.message,
                sender: 'USER'
            }
        });
        const conversationHistory = conversation.messages
            .reverse()
            .map(msg => ({
            role: msg.sender === 'USER' ? 'user' : 'assistant',
            content: msg.content
        }));
        const context = {
            systemPrompt: widget.chatbot.systemPrompt,
            conversationHistory,
            companyInfo: `Empresa: ${widget.tenant.name}`,
            userInfo: validatedData.metadata
        };
        const complexity = ai_1.aiService.detectComplexity(validatedData.message);
        const model = ai_1.aiService.selectModelForTenant(widget.tenant.plan, complexity);
        const aiResponse = await ai_1.aiService.generateResponse(validatedData.message, context, model);
        const botMessage = await database_1.db.getClient().message.create({
            data: {
                conversationId: conversation.id,
                content: aiResponse.content,
                sender: 'BOT'
            }
        });
        res.json({
            success: true,
            conversationId: conversation.id,
            message: {
                id: botMessage.id,
                content: aiResponse.content,
                sender: 'BOT',
                timestamp: botMessage.createdAt
            },
            metadata: {
                model: aiResponse.model,
                responseTime: aiResponse.responseTime,
                tokensUsed: aiResponse.tokensUsed
            }
        });
    }
    catch (error) {
        console.error('Error en chat message:', error);
        if (error instanceof zod_1.z.ZodError) {
            return res.status(400).json({
                error: 'Datos inválidos',
                details: error.errors.map(e => ({
                    field: e.path.join('.'),
                    message: e.message
                }))
            });
        }
        if (error.message?.includes('límite')) {
            return res.status(429).json({
                error: 'Límite de uso alcanzado',
                details: error.message
            });
        }
        res.status(500).json({
            error: 'Error procesando el mensaje',
            fallback: 'Lo siento, estoy experimentando dificultades técnicas. Por favor, intenta más tarde o contacta a nuestro equipo de soporte.'
        });
    }
});
router.post('/conversation', auth_1.tenantCors, auth_1.validateWidgetAccess, async (req, res) => {
    try {
        const validatedData = conversationSchema.parse(req.body);
        const widget = await database_1.db.getClient().widget.findUnique({
            where: { id: validatedData.widgetId },
            include: {
                chatbot: true,
                tenant: { select: { id: true, name: true } }
            }
        });
        if (!widget || !widget.isActive) {
            return res.status(404).json({ error: 'Widget no encontrado' });
        }
        const conversation = await database_1.db.getClient().conversation.create({
            data: {
                tenantId: widget.tenantId,
                widgetId: widget.id,
                chatbotId: widget.chatbot?.id,
                userId: validatedData.userId || `anonymous_${Date.now()}`,
                status: 'ACTIVE'
            }
        });
        res.status(201).json({
            success: true,
            conversation: {
                id: conversation.id,
                status: conversation.status,
                createdAt: conversation.createdAt
            },
            welcomeMessage: widget.chatbot?.welcomeMessage || '¡Hola! ¿En qué puedo ayudarte?'
        });
    }
    catch (error) {
        console.error('Error creando conversación:', error);
        if (error instanceof zod_1.z.ZodError) {
            return res.status(400).json({
                error: 'Datos inválidos',
                details: error.errors
            });
        }
        res.status(500).json({ error: 'Error creando conversación' });
    }
});
router.get('/conversation/:id', auth_1.tenantCors, async (req, res) => {
    try {
        const conversationId = req.params.id;
        if (!conversationId) {
            return res.status(400).json({ error: 'ID de conversación requerido' });
        }
        const conversation = await database_1.db.getClient().conversation.findUnique({
            where: { id: conversationId },
            include: {
                messages: {
                    orderBy: { createdAt: 'asc' },
                    select: {
                        id: true,
                        content: true,
                        sender: true,
                        createdAt: true
                    }
                },
                widget: {
                    select: { id: true, name: true }
                },
                chatbot: {
                    select: { id: true, name: true }
                }
            }
        });
        if (!conversation) {
            return res.status(404).json({ error: 'Conversación no encontrada' });
        }
        res.json({
            success: true,
            conversation: {
                id: conversation.id,
                status: conversation.status,
                createdAt: conversation.createdAt,
                updatedAt: conversation.updatedAt,
                widget: conversation.widget,
                chatbot: conversation.chatbot,
                messages: conversation.messages
            }
        });
    }
    catch (error) {
        console.error('Error obteniendo conversación:', error);
        res.status(500).json({ error: 'Error obteniendo conversación' });
    }
});
router.put('/conversation/:id/close', auth_1.tenantCors, async (req, res) => {
    try {
        const conversationId = req.params.id;
        const { rating, feedback } = req.body;
        const conversation = await database_1.db.getClient().conversation.update({
            where: { id: conversationId },
            data: {
                status: 'CLOSED',
                ...(rating && { rating: parseInt(rating) }),
                ...(feedback && { feedback })
            }
        });
        res.json({
            success: true,
            message: 'Conversación cerrada exitosamente',
            conversation: {
                id: conversation.id,
                status: conversation.status
            }
        });
    }
    catch (error) {
        console.error('Error cerrando conversación:', error);
        res.status(500).json({ error: 'Error cerrando conversación' });
    }
});
router.post('/feedback', auth_1.tenantCors, async (req, res) => {
    try {
        const { messageId, rating, feedback } = req.body;
        if (!messageId) {
            return res.status(400).json({ error: 'ID de mensaje requerido' });
        }
        console.log(`Feedback recibido - Mensaje: ${messageId}, Rating: ${rating}, Comentario: ${feedback}`);
        res.json({
            success: true,
            message: 'Feedback recibido exitosamente'
        });
    }
    catch (error) {
        console.error('Error guardando feedback:', error);
        res.status(500).json({ error: 'Error guardando feedback' });
    }
});
router.get('/widget/:widgetId/config', auth_1.tenantCors, auth_1.validateWidgetAccess, async (req, res) => {
    try {
        const widget = await database_1.db.getClient().widget.findUnique({
            where: { id: req.params.widgetId },
            include: {
                chatbot: {
                    select: {
                        id: true,
                        name: true,
                        welcomeMessage: true
                    }
                },
                tenant: {
                    select: {
                        id: true,
                        name: true,
                        plan: true
                    }
                }
            }
        });
        if (!widget) {
            return res.status(404).json({ error: 'Widget no encontrado' });
        }
        res.json({
            success: true,
            widget: {
                id: widget.id,
                name: widget.name,
                config: widget.config,
                theme: widget.theme,
                chatbot: widget.chatbot,
                tenant: {
                    name: widget.tenant.name
                }
            }
        });
    }
    catch (error) {
        console.error('Error obteniendo configuración del widget:', error);
        res.status(500).json({ error: 'Error obteniendo configuración' });
    }
});
router.post('/transfer-to-human', auth_1.tenantCors, async (req, res) => {
    try {
        const { conversationId, reason } = req.body;
        if (!conversationId) {
            return res.status(400).json({ error: 'ID de conversación requerido' });
        }
        const conversation = await database_1.db.getClient().conversation.update({
            where: { id: conversationId },
            data: {
                status: 'PENDING_TRANSFER'
            }
        });
        await database_1.db.getClient().message.create({
            data: {
                conversationId: conversation.id,
                content: 'Te estoy transfiriendo con un agente humano. Un momento por favor...',
                sender: 'BOT'
            }
        });
        res.json({
            success: true,
            message: 'Solicitud de transferencia enviada',
            estimatedWaitTime: '2-5 minutos'
        });
    }
    catch (error) {
        console.error('Error en transferencia:', error);
        res.status(500).json({ error: 'Error procesando transferencia' });
    }
});
router.get('/health', async (req, res) => {
    try {
        const dbHealth = await database_1.db.healthCheck();
        let aiHealth = true;
        try {
            await ai_1.aiService.generateResponse('test', { systemPrompt: 'Responde solo "ok"' }, 'gemini-pro');
        }
        catch (error) {
            aiHealth = false;
        }
        const status = dbHealth && aiHealth ? 'healthy' : 'degraded';
        res.status(status === 'healthy' ? 200 : 503).json({
            status,
            timestamp: new Date().toISOString(),
            services: {
                database: dbHealth ? 'up' : 'down',
                ai: aiHealth ? 'up' : 'down'
            }
        });
    }
    catch (error) {
        console.error('Error en health check:', error);
        res.status(503).json({
            status: 'unhealthy',
            timestamp: new Date().toISOString(),
            error: error.message
        });
    }
});
exports.default = router;
//# sourceMappingURL=chat.js.map