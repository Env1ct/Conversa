import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { authenticateToken, requireRole, requireFeature } from '../middleware/auth';
import { db } from '../services/database';

const router = Router();

// Todos los endpoints requieren autenticación
router.use(authenticateToken);

// GET /api/dashboard/stats - Estadísticas generales del tenant
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const days = parseInt(req.query.days as string) || 30;

    // Obtener estadísticas generales
    const stats = await db.getTenantStats(tenantId, days);

    // Obtener límites y uso actual
    const limits = await db.checkTenantLimits(tenantId);

    // Estadísticas adicionales
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const [
      activeWidgets,
      activeChatbots,
      avgResponseTime,
      topConversationDays
    ] = await Promise.all([
      // Widgets activos
      db.getClient().widget.count({
        where: { tenantId, isActive: true }
      }),

      // Chatbots activos
      db.getClient().chatbot.count({
        where: { tenantId, isActive: true }
      }),

      // Tiempo promedio de respuesta (simulado por ahora)
      Promise.resolve(250), // ms

      // Días con más conversaciones
      db.getClient().conversation.groupBy({
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

  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ error: 'Error obteniendo estadísticas' });
  }
});

// GET /api/dashboard/conversations - Lista de conversaciones
router.get('/conversations', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as string;
    const widgetId = req.query.widgetId as string;

    const skip = (page - 1) * limit;

    // Construir filtros
    const where: any = { tenantId };
    if (status) where.status = status;
    if (widgetId) where.widgetId = widgetId;

    const [conversations, total] = await Promise.all([
      db.getClient().conversation.findMany({
        where,
        include: {
          widget: { select: { id: true, name: true } },
          chatbot: { select: { id: true, name: true } },
          messages: {
            select: { id: true, content: true, sender: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 1 // Último mensaje
          },
          _count: { select: { messages: true } }
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit
      }),

      db.getClient().conversation.count({ where })
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

  } catch (error) {
    console.error('Error obteniendo conversaciones:', error);
    res.status(500).json({ error: 'Error obteniendo conversaciones' });
  }
});

// GET /api/dashboard/conversation/:id - Detalle de conversación
router.get('/conversation/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const conversationId = req.params.id;

    const conversation = await db.getClient().conversation.findFirst({
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

  } catch (error) {
    console.error('Error obteniendo conversación:', error);
    res.status(500).json({ error: 'Error obteniendo conversación' });
  }
});

// GET /api/dashboard/chatbots - Lista de chatbots
router.get('/chatbots', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;

    const chatbots = await db.getClient().chatbot.findMany({
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

  } catch (error) {
    console.error('Error obteniendo chatbots:', error);
    res.status(500).json({ error: 'Error obteniendo chatbots' });
  }
});

// POST /api/dashboard/chatbot - Crear nuevo chatbot
router.post('/chatbot', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const { name, model, systemPrompt, welcomeMessage } = req.body;

    // Validación básica
    if (!name || !systemPrompt) {
      return res.status(400).json({ error: 'Nombre y prompt del sistema son requeridos' });
    }

    const chatbot = await db.getClient().chatbot.create({
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

  } catch (error) {
    console.error('Error creando chatbot:', error);
    res.status(500).json({ error: 'Error creando chatbot' });
  }
});

// PUT /api/dashboard/chatbot/:id - Actualizar chatbot
router.put('/chatbot/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const chatbotId = req.params.id;
    const { name, model, systemPrompt, welcomeMessage, isActive } = req.body;

    const chatbot = await db.getClient().chatbot.findFirst({
      where: { id: chatbotId, tenantId }
    });

    if (!chatbot) {
      return res.status(404).json({ error: 'Chatbot no encontrado' });
    }

    const updatedChatbot = await db.getClient().chatbot.update({
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

  } catch (error) {
    console.error('Error actualizando chatbot:', error);
    res.status(500).json({ error: 'Error actualizando chatbot' });
  }
});

// GET /api/dashboard/widgets - Lista de widgets
router.get('/widgets', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;

    const widgets = await db.getClient().widget.findMany({
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

  } catch (error) {
    console.error('Error obteniendo widgets:', error);
    res.status(500).json({ error: 'Error obteniendo widgets' });
  }
});

// POST /api/dashboard/widget - Crear nuevo widget
router.post('/widget', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const { name, chatbotId, config, theme } = req.body;

    if (!name || !chatbotId) {
      return res.status(400).json({ error: 'Nombre y chatbot son requeridos' });
    }

    // Verificar que el chatbot pertenece al tenant
    const chatbot = await db.getClient().chatbot.findFirst({
      where: { id: chatbotId, tenantId }
    });

    if (!chatbot) {
      return res.status(404).json({ error: 'Chatbot no encontrado' });
    }

    const widget = await db.getClient().widget.create({
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

  } catch (error) {
    console.error('Error creando widget:', error);
    res.status(500).json({ error: 'Error creando widget' });
  }
});

// PUT /api/dashboard/widget/:id - Actualizar widget
router.put('/widget/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const widgetId = req.params.id;
    const { name, config, theme, isActive } = req.body;

    const widget = await db.getClient().widget.findFirst({
      where: { id: widgetId, tenantId }
    });

    if (!widget) {
      return res.status(404).json({ error: 'Widget no encontrado' });
    }

    const updatedWidget = await db.getClient().widget.update({
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

  } catch (error) {
    console.error('Error actualizando widget:', error);
    res.status(500).json({ error: 'Error actualizando widget' });
  }
});

// GET /api/dashboard/widget/:id/script - Obtener script de instalación del widget
router.get('/widget/:id/script', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const widgetId = req.params.id;

    const widget = await db.getClient().widget.findFirst({
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

  } catch (error) {
    console.error('Error generando script:', error);
    res.status(500).json({ error: 'Error generando script' });
  }
});

// GET /api/dashboard/analytics - Analytics avanzado
router.get('/analytics', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const days = parseInt(req.query.days as string) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Métricas por día
    const dailyStats = await db.getClient().conversation.groupBy({
      by: ['createdAt'],
      where: {
        tenantId,
        createdAt: { gte: startDate }
      },
      _count: { id: true },
      orderBy: { createdAt: 'asc' }
    });

    // Distribución por widgets
    const widgetStats = await db.getClient().conversation.groupBy({
      by: ['widgetId'],
      where: {
        tenantId,
        createdAt: { gte: startDate }
      },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } }
    });

    // Obtener nombres de widgets para el reporte
    const widgets = await db.getClient().widget.findMany({
      where: { tenantId },
      select: { id: true, name: true }
    });

    const widgetMap = widgets.reduce((acc, widget) => {
      acc[widget.id] = widget.name;
      return acc;
    }, {} as Record<string, string>);

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
          widgetName: widgetMap[stat.widgetId!] || 'Sin nombre',
          conversations: stat._count.id
        }))
      }
    });

  } catch (error) {
    console.error('Error obteniendo analytics:', error);
    res.status(500).json({ error: 'Error obteniendo analytics' });
  }
});

// GET /api/dashboard/team - Miembros del equipo
router.get('/team', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;

    const users = await db.getClient().user.findMany({
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

  } catch (error) {
    console.error('Error obteniendo equipo:', error);
    res.status(500).json({ error: 'Error obteniendo equipo' });
  }
});

// POST /api/dashboard/team/invite - Invitar miembro al equipo
router.post('/team/invite',
  requireRole(['OWNER', 'ADMIN']),
  async (req: Request, res: Response) => {
    try {
      const { email, name, role } = req.body;

      if (!email || !name) {
        return res.status(400).json({ error: 'Email y nombre son requeridos' });
      }

      // Verificar que el usuario no exista ya
      const existingUser = await db.getClient().user.findUnique({
        where: { email }
      });

      if (existingUser) {
        return res.status(400).json({ error: 'El usuario ya existe' });
      }

      // Generar contraseña temporal
      const tempPassword = Math.random().toString(36).slice(-8);
      const hashedPassword = await bcrypt.hash(tempPassword, 12);

      const user = await db.getClient().user.create({
        data: {
          email,
          name,
          password: hashedPassword,
          role: role || 'USER',
          tenantId: req.tenantId!,
          isActive: false // Requiere activación
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

      // Log de la contraseña temporal (solo en desarrollo)
      if (process.env.NODE_ENV === 'development') {
        console.log(`Contraseña temporal para ${email}: ${tempPassword}`);
      }

      res.status(201).json({
        success: true,
        user,
        message: 'Invitación enviada exitosamente',
        ...(process.env.NODE_ENV === 'development' && { tempPassword })
      });

    } catch (error) {
      console.error('Error invitando usuario:', error);
      res.status(500).json({ error: 'Error invitando usuario' });
    }
  }
);

export default router;