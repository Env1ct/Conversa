import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { db } from '../services/database';
import { aiService } from '../services/ai';
import { validateWidgetAccess, tenantCors, checkUsageLimits } from '../middleware/auth';

const router = Router();

// Rate limiting específico para chat (más restrictivo)
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 30, // 30 mensajes por minuto por IP
  message: 'Demasiados mensajes. Intenta más tarde.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Schemas de validación
const chatMessageSchema = z.object({
  message: z.string().min(1, 'El mensaje no puede estar vacío').max(1000, 'El mensaje es demasiado largo'),
  conversationId: z.string().uuid().optional(),
  widgetId: z.string().uuid('Widget ID inválido'),
  userId: z.string().optional(),
  metadata: z.object({
    userAgent: z.string().optional(),
    url: z.string().optional(),
    referrer: z.string().optional(),
  }).optional()
});

const conversationSchema = z.object({
  widgetId: z.string().uuid('Widget ID inválido'),
  userId: z.string().optional(),
  metadata: z.object({
    userAgent: z.string().optional(),
    url: z.string().optional(),
    referrer: z.string().optional(),
    location: z.object({
      country: z.string().optional(),
      city: z.string().optional(),
    }).optional(),
  }).optional()
});

// POST /api/chat/message - Enviar mensaje y obtener respuesta del bot
router.post('/message', 
  tenantCors,
  chatLimiter,
  validateWidgetAccess,
  checkUsageLimits('conversations'),
  async (req: Request, res: Response) => {
    try {
      // Validar datos de entrada
      const validatedData = chatMessageSchema.parse(req.body);

      // Obtener información del widget y chatbot
      const widget = await db.getClient().widget.findUnique({
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

      // Buscar o crear conversación
      let conversation;
      if (validatedData.conversationId) {
        conversation = await db.getClient().conversation.findUnique({
          where: { id: validatedData.conversationId },
          include: { 
            messages: { 
              orderBy: { createdAt: 'desc' },
              take: 10 // Últimos 10 mensajes para contexto
            }
          }
        });

        if (!conversation || conversation.tenantId !== widget.tenantId) {
          return res.status(404).json({ error: 'Conversación no encontrada' });
        }
      }

      if (!conversation) {
        conversation = await db.getClient().conversation.create({
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

      // Guardar mensaje del usuario
      const userMessage = await db.getClient().message.create({
        data: {
          conversationId: conversation.id,
          content: validatedData.message,
          sender: 'USER'
        }
      });

      // Preparar contexto para la IA
      const conversationHistory = conversation.messages
        .reverse() // Orden cronológico
        .map(msg => ({
          role: msg.sender === 'USER' ? 'user' as const : 'assistant' as const,
          content: msg.content
        }));

      const context = {
        systemPrompt: widget.chatbot.systemPrompt,
        conversationHistory,
        companyInfo: `Empresa: ${widget.tenant.name}`,
        userInfo: validatedData.metadata
      };

      // Detectar complejidad del mensaje
      const complexity = aiService.detectComplexity(validatedData.message);
      
      // Seleccionar modelo basado en el plan del tenant
      const model = aiService.selectModelForTenant(widget.tenant.plan, complexity);

      // Generar respuesta con IA
      const aiResponse = await aiService.generateResponse(
        validatedData.message,
        context,
        model
      );

      // Guardar respuesta del bot
      const botMessage = await db.getClient().message.create({
        data: {
          conversationId: conversation.id,
          content: aiResponse.content,
          sender: 'BOT'
        }
      });

      // Respuesta exitosa
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

    } catch (error) {
      console.error('Error en chat message:', error);

      if (error instanceof z.ZodError) {
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
  }
);

// POST /api/chat/conversation - Crear nueva conversación
router.post('/conversation',
  tenantCors,
  validateWidgetAccess,
  async (req: Request, res: Response) => {
    try {
      const validatedData = conversationSchema.parse(req.body);

      const widget = await db.getClient().widget.findUnique({
        where: { id: validatedData.widgetId },
        include: { 
          chatbot: true,
          tenant: { select: { id: true, name: true } }
        }
      });

      if (!widget || !widget.isActive) {
        return res.status(404).json({ error: 'Widget no encontrado' });
      }

      const conversation = await db.getClient().conversation.create({
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

    } catch (error) {
      console.error('Error creando conversación:', error);

      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Datos inválidos',
          details: error.errors
        });
      }

      res.status(500).json({ error: 'Error creando conversación' });
    }
  }
);

// GET /api/chat/conversation/:id - Obtener historial de conversación
router.get('/conversation/:id',
  tenantCors,
  async (req: Request, res: Response) => {
    try {
      const conversationId = req.params.id;

      if (!conversationId) {
        return res.status(400).json({ error: 'ID de conversación requerido' });
      }

      const conversation = await db.getClient().conversation.findUnique({
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

    } catch (error) {
      console.error('Error obteniendo conversación:', error);
      res.status(500).json({ error: 'Error obteniendo conversación' });
    }
  }
);

// PUT /api/chat/conversation/:id/close - Cerrar conversación
router.put('/conversation/:id/close',
  tenantCors,
  async (req: Request, res: Response) => {
    try {
      const conversationId = req.params.id;
      const { rating, feedback } = req.body;

      const conversation = await db.getClient().conversation.update({
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

    } catch (error) {
      console.error('Error cerrando conversación:', error);
      res.status(500).json({ error: 'Error cerrando conversación' });
    }
  }
);

// POST /api/chat/feedback - Enviar feedback sobre una respuesta
router.post('/feedback',
  tenantCors,
  async (req: Request, res: Response) => {
    try {
      const { messageId, rating, feedback } = req.body;

      if (!messageId) {
        return res.status(400).json({ error: 'ID de mensaje requerido' });
      }

      // Log del feedback para análisis
      console.log(`Feedback recibido - Mensaje: ${messageId}, Rating: ${rating}, Comentario: ${feedback}`);

      res.json({
        success: true,
        message: 'Feedback recibido exitosamente'
      });

    } catch (error) {
      console.error('Error guardando feedback:', error);
      res.status(500).json({ error: 'Error guardando feedback' });
    }
  }
);

// GET /api/chat/widget/:widgetId/config - Obtener configuración del widget
router.get('/widget/:widgetId/config',
  tenantCors,
  validateWidgetAccess,
  async (req: Request, res: Response) => {
    try {
      const widget = await db.getClient().widget.findUnique({
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

    } catch (error) {
      console.error('Error obteniendo configuración del widget:', error);
      res.status(500).json({ error: 'Error obteniendo configuración' });
    }
  }
);

// POST /api/chat/transfer-to-human - Solicitar transferencia a agente humano
router.post('/transfer-to-human',
  tenantCors,
  async (req: Request, res: Response) => {
    try {
      const { conversationId, reason } = req.body;

      if (!conversationId) {
        return res.status(400).json({ error: 'ID de conversación requerido' });
      }

      // Actualizar el estado de la conversación
      const conversation = await db.getClient().conversation.update({
        where: { id: conversationId },
        data: {
          status: 'PENDING_TRANSFER'
        }
      });

      // Crear mensaje automático informando sobre la transferencia
      await db.getClient().message.create({
        data: {
          conversationId: conversation.id,
          content: 'Te estoy transfiriendo con un agente humano. Un momento por favor...',
          sender: 'BOT'
        }
      });

      // En el futuro, aquí se notificaría a los agentes disponibles
      res.json({
        success: true,
        message: 'Solicitud de transferencia enviada',
        estimatedWaitTime: '2-5 minutos'
      });

    } catch (error) {
      console.error('Error en transferencia:', error);
      res.status(500).json({ error: 'Error procesando transferencia' });
    }
  }
);

// GET /api/chat/health - Health check específico para el servicio de chat
router.get('/health', async (req: Request, res: Response) => {
  try {
    // Verificar conexión a base de datos
    const dbHealth = await db.healthCheck();
    
    // Verificar servicios de IA (test simple)
    let aiHealth = true;
    try {
      // Test básico - intentar generar una respuesta muy simple
      await aiService.generateResponse(
        'test',
        { systemPrompt: 'Responde solo "ok"' },
        'gemini-pro'
      );
    } catch (error) {
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

  } catch (error) {
    console.error('Error en health check:', error);
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

export default router;