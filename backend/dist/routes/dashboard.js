"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const auth_1 = require("../middleware/auth");
const database_1 = require("../services/database");
const router = (0, express_1.Router)();
router.use(auth_1.authenticateToken);
router.get('/stats', async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const days = parseInt(req.query.days) || 30;
        const stats = await database_1.db.getTenantStats(tenantId, days);
        const limits = await database_1.db.checkTenantLimits(tenantId);
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const [activeWidgets, activeChatbots, avgResponseTime, topConversationDays] = await Promise.all([
            database_1.db.getClient().widget.count({
                where: { tenantId, isActive: true }
            }),
            database_1.db.getClient().chatbot.count({
                where: { tenantId, isActive: true }
            }),
            Promise.resolve(250),
            database_1.db.getClient().conversation.groupBy({
                by: ['createdAt'],
                where: {
                    tenantId,
                    createdAt: { gte: startDate }
                },
                _count: { id: true },
                orderBy: { _count: { id: 'desc' } },
                take: 7
            })
        ]);
        res.json({
            success: true,
            period: { days, startDate, endDate: new Date() },
            stats: {
                ...stats,
                activeWidgets,
                activeChatbots,
                avgResponseTime,
                usage: limits
            },
            trends: {
                conversationsByDay: topConversationDays.map(day => ({
                    date: day.createdAt,
                    count: day._count.id
                }))
            }
        });
    }
    catch (error) {
        console.error('Error obteniendo estadísticas:', error);
        res.status(500).json({ error: 'Error obteniendo estadísticas' });
    }
});
router.get('/conversations', async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const status = req.query.status;
        const widgetId = req.query.widgetId;
        const skip = (page - 1) * limit;
        const where = { tenantId };
        if (status)
            where.status = status;
        if (widgetId)
            where.widgetId = widgetId;
        const [conversations, total] = await Promise.all([
            database_1.db.getClient().conversation.findMany({
                where,
                include: {
                    widget: { select: { id: true, name: true } },
                    chatbot: { select: { id: true, name: true } },
                    messages: {
                        select: { id: true, content: true, sender: true, createdAt: true },
                        orderBy: { createdAt: 'desc' },
                        take: 1
                    },
                    _count: { select: { messages: true } }
                },
                orderBy: { updatedAt: 'desc' },
                skip,
                take: limit
            }),
            database_1.db.getClient().conversation.count({ where })
        ]);
        res.json({
            success: true,
            conversations: conversations.map(conv => ({
                id: conv.id,
                status: conv.status,
                userId: conv.userId,
                createdAt: conv.createdAt,
                updatedAt: conv.updatedAt,
                widget: conv.widget,
                chatbot: conv.chatbot,
                messageCount: conv._count.messages,
                lastMessage: conv.messages[0] || null
            })),
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        });
    }
    catch (error) {
        console.error('Error obteniendo conversaciones:', error);
        res.status(500).json({ error: 'Error obteniendo conversaciones' });
    }
});
router.get('/conversation/:id', async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const conversationId = req.params.id;
        const conversation = await database_1.db.getClient().conversation.findFirst({
            where: { id: conversationId, tenantId },
            include: {
                widget: { select: { id: true, name: true, config: true } },
                chatbot: { select: { id: true, name: true } },
                messages: {
                    orderBy: { createdAt: 'asc' },
                    select: {
                        id: true,
                        content: true,
                        sender: true,
                        createdAt: true
                    }
                }
            }
        });
        if (!conversation) {
            return res.status(404).json({ error: 'Conversación no encontrada' });
        }
        res.json({
            success: true,
            conversation
        });
    }
    catch (error) {
        console.error('Error obteniendo conversación:', error);
        res.status(500).json({ error: 'Error obteniendo conversación' });
    }
});
router.get('/chatbots', async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const chatbots = await database_1.db.getClient().chatbot.findMany({
            where: { tenantId },
            include: {
                widgets: { select: { id: true, name: true, isActive: true } },
                _count: { select: { conversations: true, widgets: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        res.json({
            success: true,
            chatbots: chatbots.map(bot => ({
                id: bot.id,
                name: bot.name,
                model: bot.model,
                isActive: bot.isActive,
                welcomeMessage: bot.welcomeMessage,
                systemPrompt: bot.systemPrompt,
                createdAt: bot.createdAt,
                updatedAt: bot.updatedAt,
                widgets: bot.widgets,
                stats: {
                    conversationCount: bot._count.conversations,
                    widgetCount: bot._count.widgets
                }
            }))
        });
    }
    catch (error) {
        console.error('Error obteniendo chatbots:', error);
        res.status(500).json({ error: 'Error obteniendo chatbots' });
    }
});
router.post('/chatbot', async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const { name, model, systemPrompt, welcomeMessage } = req.body;
        if (!name || !systemPrompt) {
            return res.status(400).json({ error: 'Nombre y prompt del sistema son requeridos' });
        }
        const chatbot = await database_1.db.getClient().chatbot.create({
            data: {
                tenantId,
                name,
                model: model || 'gpt-4',
                systemPrompt,
                welcomeMessage: welcomeMessage || '¡Hola! ¿En qué puedo ayudarte?'
            }
        });
        res.status(201).json({
            success: true,
            chatbot: {
                id: chatbot.id,
                name: chatbot.name,
                model: chatbot.model,
                isActive: chatbot.isActive,
                createdAt: chatbot.createdAt
            }
        });
    }
    catch (error) {
        console.error('Error creando chatbot:', error);
        res.status(500).json({ error: 'Error creando chatbot' });
    }
});
router.put('/chatbot/:id', async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const chatbotId = req.params.id;
        const { name, model, systemPrompt, welcomeMessage, isActive } = req.body;
        const chatbot = await database_1.db.getClient().chatbot.findFirst({
            where: { id: chatbotId, tenantId }
        });
        if (!chatbot) {
            return res.status(404).json({ error: 'Chatbot no encontrado' });
        }
        const updatedChatbot = await database_1.db.getClient().chatbot.update({
            where: { id: chatbotId },
            data: {
                ...(name && { name }),
                ...(model && { model }),
                ...(systemPrompt && { systemPrompt }),
                ...(welcomeMessage && { welcomeMessage }),
                ...(typeof isActive === 'boolean' && { isActive })
            }
        });
        res.json({
            success: true,
            chatbot: updatedChatbot
        });
    }
    catch (error) {
        console.error('Error actualizando chatbot:', error);
        res.status(500).json({ error: 'Error actualizando chatbot' });
    }
});
router.get('/widgets', async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const widgets = await database_1.db.getClient().widget.findMany({
            where: { tenantId },
            include: {
                chatbot: { select: { id: true, name: true } },
                _count: { select: { conversations: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        res.json({
            success: true,
            widgets: widgets.map(widget => ({
                id: widget.id,
                name: widget.name,
                isActive: widget.isActive,
                createdAt: widget.createdAt,
                updatedAt: widget.updatedAt,
                chatbot: widget.chatbot,
                config: widget.config,
                theme: widget.theme,
                stats: {
                    conversationCount: widget._count.conversations
                }
            }))
        });
    }
    catch (error) {
        console.error('Error obteniendo widgets:', error);
        res.status(500).json({ error: 'Error obteniendo widgets' });
    }
});
router.post('/widget', async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const { name, chatbotId, config, theme } = req.body;
        if (!name || !chatbotId) {
            return res.status(400).json({ error: 'Nombre y chatbot son requeridos' });
        }
        const chatbot = await database_1.db.getClient().chatbot.findFirst({
            where: { id: chatbotId, tenantId }
        });
        if (!chatbot) {
            return res.status(404).json({ error: 'Chatbot no encontrado' });
        }
        const widget = await database_1.db.getClient().widget.create({
            data: {
                tenantId,
                chatbotId,
                name,
                config: config || {
                    position: 'bottom-right',
                    primaryColor: '#4F46E5',
                    greeting: `¡Hola! Soy ${chatbot.name}`,
                    placeholder: 'Escribe tu mensaje...'
                },
                theme: theme || {
                    primaryColor: '#4F46E5',
                    backgroundColor: '#FFFFFF',
                    textColor: '#1F2937',
                    borderRadius: '12px'
                }
            },
            include: {
                chatbot: { select: { id: true, name: true } }
            }
        });
        res.status(201).json({
            success: true,
            widget: {
                id: widget.id,
                name: widget.name,
                isActive: widget.isActive,
                config: widget.config,
                theme: widget.theme,
                chatbot: widget.chatbot,
                createdAt: widget.createdAt
            }
        });
    }
    catch (error) {
        console.error('Error creando widget:', error);
        res.status(500).json({ error: 'Error creando widget' });
    }
});
router.put('/widget/:id', async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const widgetId = req.params.id;
        const { name, config, theme, isActive } = req.body;
        const widget = await database_1.db.getClient().widget.findFirst({
            where: { id: widgetId, tenantId }
        });
        if (!widget) {
            return res.status(404).json({ error: 'Widget no encontrado' });
        }
        const updatedWidget = await database_1.db.getClient().widget.update({
            where: { id: widgetId },
            data: {
                ...(name && { name }),
                ...(config && { config }),
                ...(theme && { theme }),
                ...(typeof isActive === 'boolean' && { isActive })
            },
            include: {
                chatbot: { select: { id: true, name: true } }
            }
        });
        res.json({
            success: true,
            widget: updatedWidget
        });
    }
    catch (error) {
        console.error('Error actualizando widget:', error);
        res.status(500).json({ error: 'Error actualizando widget' });
    }
});
router.get('/widget/:id/script', async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const widgetId = req.params.id;
        const widget = await database_1.db.getClient().widget.findFirst({
            where: { id: widgetId, tenantId },
            select: { id: true, name: true }
        });
        if (!widget) {
            return res.status(404).json({ error: 'Widget no encontrado' });
        }
        const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
        const script = `<!-- Conversa.ai Widget -->
<script>
  (function() {
    window.conversaAI = window.conversaAI || {};
    window.conversaAI.widgetId = '${widgetId}';
    window.conversaAI.server = '${baseUrl}';
    
    var script = document.createElement('script');
    script.src = window.conversaAI.server + '/api/widget/js/widget.js';
    script.async = true;
    document.head.appendChild(script);
  })();
</script>
<!-- Fin Conversa.ai Widget -->`;
        res.json({
            success: true,
            script,
            instructions: [
                'Copia el código anterior',
                'Pégalo antes de la etiqueta </body> en tu sitio web',
                'El widget aparecerá automáticamente en tu sitio',
                'Puedes personalizar la apariencia desde el dashboard'
            ]
        });
    }
    catch (error) {
        console.error('Error generando script:', error);
        res.status(500).json({ error: 'Error generando script' });
    }
});
router.get('/analytics', async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const days = parseInt(req.query.days) || 30;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const dailyStats = await database_1.db.getClient().conversation.groupBy({
            by: ['createdAt'],
            where: {
                tenantId,
                createdAt: { gte: startDate }
            },
            _count: { id: true },
            orderBy: { createdAt: 'asc' }
        });
        const widgetStats = await database_1.db.getClient().conversation.groupBy({
            by: ['widgetId'],
            where: {
                tenantId,
                createdAt: { gte: startDate }
            },
            _count: { id: true },
            orderBy: { _count: { id: 'desc' } }
        });
        const widgets = await database_1.db.getClient().widget.findMany({
            where: { tenantId },
            select: { id: true, name: true }
        });
        const widgetMap = widgets.reduce((acc, widget) => {
            acc[widget.id] = widget.name;
            return acc;
        }, {});
        res.json({
            success: true,
            period: { days, startDate, endDate: new Date() },
            analytics: {
                dailyConversations: dailyStats.map(stat => ({
                    date: stat.createdAt,
                    conversations: stat._count.id
                })),
                widgetPerformance: widgetStats.map(stat => ({
                    widgetId: stat.widgetId,
                    widgetName: widgetMap[stat.widgetId] || 'Sin nombre',
                    conversations: stat._count.id
                }))
            }
        });
    }
    catch (error) {
        console.error('Error obteniendo analytics:', error);
        res.status(500).json({ error: 'Error obteniendo analytics' });
    }
});
router.get('/team', async (req, res) => {
    try {
        const tenantId = req.tenantId;
        const users = await database_1.db.getClient().user.findMany({
            where: { tenantId },
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                isActive: true,
                lastLoginAt: true,
                createdAt: true
            },
            orderBy: { createdAt: 'asc' }
        });
        res.json({
            success: true,
            team: users
        });
    }
    catch (error) {
        console.error('Error obteniendo equipo:', error);
        res.status(500).json({ error: 'Error obteniendo equipo' });
    }
});
router.post('/team/invite', (0, auth_1.requireRole)(['OWNER', 'ADMIN']), async (req, res) => {
    try {
        const { email, name, role } = req.body;
        if (!email || !name) {
            return res.status(400).json({ error: 'Email y nombre son requeridos' });
        }
        const existingUser = await database_1.db.getClient().user.findUnique({
            where: { email }
        });
        if (existingUser) {
            return res.status(400).json({ error: 'El usuario ya existe' });
        }
        const tempPassword = Math.random().toString(36).slice(-8);
        const hashedPassword = await bcryptjs_1.default.hash(tempPassword, 12);
        const user = await database_1.db.getClient().user.create({
            data: {
                email,
                name,
                password: hashedPassword,
                role: role || 'USER',
                tenantId: req.tenantId,
                isActive: false
            },
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                isActive: true,
                createdAt: true
            }
        });
        if (process.env.NODE_ENV === 'development') {
            console.log(`Contraseña temporal para ${email}: ${tempPassword}`);
        }
        res.status(201).json({
            success: true,
            user,
            message: 'Invitación enviada exitosamente',
            ...(process.env.NODE_ENV === 'development' && { tempPassword })
        });
    }
    catch (error) {
        console.error('Error invitando usuario:', error);
        res.status(500).json({ error: 'Error invitando usuario' });
    }
});
exports.default = router;
//# sourceMappingURL=dashboard.js.map