"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const database_1 = require("../services/database");
const router = (0, express_1.Router)();
router.use(auth_1.tenantCors);
router.get('/:id', async (req, res) => {
    try {
        const widgetId = req.params.id;
        if (!widgetId) {
            return res.status(400).json({ error: 'Widget ID requerido' });
        }
        const widget = await database_1.db.getClient().widget.findUnique({
            where: { id: widgetId },
            include: {
                chatbot: {
                    select: {
                        id: true,
                        name: true,
                        welcomeMessage: true,
                        isActive: true
                    }
                },
                tenant: {
                    select: {
                        id: true,
                        name: true,
                        plan: true,
                        isActive: true,
                        subscriptionStatus: true
                    }
                }
            }
        });
        if (!widget) {
            return res.status(404).json({ error: 'Widget no encontrado' });
        }
        if (!widget.isActive) {
            return res.status(403).json({ error: 'Widget desactivado' });
        }
        if (!widget.tenant.isActive) {
            return res.status(403).json({ error: 'Servicio temporalmente no disponible' });
        }
        if (widget.tenant.subscriptionStatus !== 'active' && widget.tenant.plan !== 'starter') {
            return res.status(402).json({ error: 'Servicio temporalmente no disponible' });
        }
        if (!widget.chatbot || !widget.chatbot.isActive) {
            return res.status(503).json({ error: 'Chatbot no disponible' });
        }
        res.json({
            success: true,
            widget: {
                id: widget.id,
                name: widget.name,
                config: widget.config,
                theme: widget.theme,
                chatbot: {
                    id: widget.chatbot.id,
                    name: widget.chatbot.name,
                    welcomeMessage: widget.chatbot.welcomeMessage
                },
                company: {
                    name: widget.tenant.name
                }
            }
        });
    }
    catch (error) {
        console.error('Error obteniendo widget:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
router.get('/:id/script', async (req, res) => {
    try {
        const widgetId = req.params.id;
        const widget = await database_1.db.getClient().widget.findUnique({
            where: { id: widgetId },
            include: {
                tenant: {
                    select: { isActive: true, subscriptionStatus: true, plan: true }
                }
            }
        });
        if (!widget || !widget.isActive || !widget.tenant.isActive) {
            return res.status(404).json({ error: 'Widget no encontrado' });
        }
        const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
        const script = `
<!-- Conversa.ai Widget Script -->
<script type="text/javascript">
(function() {
  // Configuración del widget
  window.ConversaAI = window.ConversaAI || {};
  window.ConversaAI.config = {
    widgetId: '${widgetId}',
    apiUrl: '${baseUrl}/api',
    version: '1.0.0'
  };

  // Verificar si ya está cargado
  if (window.ConversaAI.loaded) return;
  window.ConversaAI.loaded = true;

  // Crear contenedor del widget
  var widgetContainer = document.createElement('div');
  widgetContainer.id = 'conversa-ai-widget';
  widgetContainer.style.cssText = \`
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  \`;

  // Insertar en el DOM cuando esté listo
  function insertWidget() {
    if (document.body) {
      document.body.appendChild(widgetContainer);
      loadWidget();
    } else {
      setTimeout(insertWidget, 100);
    }
  }

  // Cargar el widget
  function loadWidget() {
    fetch(window.ConversaAI.config.apiUrl + '/widget/' + window.ConversaAI.config.widgetId)
      .then(response => response.json())
      .then(data => {
        if (data.success) {
          createWidget(data.widget);
        } else {
          console.error('Error cargando widget:', data.error);
        }
      })
      .catch(error => {
        console.error('Error conectando con Conversa.ai:', error);
      });
  }

  // Crear interfaz del widget
  function createWidget(widgetConfig) {
    var config = widgetConfig.config;
    var theme = widgetConfig.theme;
    
    // Botón flotante
    var chatButton = document.createElement('div');
    chatButton.style.cssText = \`
      width: 60px;
      height: 60px;
      background: \${theme.primaryColor || '#4F46E5'};
      border-radius: 50%;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
    \`;
    
    chatButton.innerHTML = \`
      <svg width="24" height="24" fill="white" viewBox="0 0 24 24">
        <path d="M12 2C6.48 2 2 6.48 2 12c0 1.54.36 3.04 1.05 4.39L2 22l5.61-1.05C9.96 21.64 11.46 22 13 22h7c1.1 0 2-.9 2-2V12c0-5.52-4.48-10-10-10z"/>
      </svg>
    \`;

    // Ventana de chat
    var chatWindow = document.createElement('div');
    chatWindow.style.cssText = \`
      position: absolute;
      bottom: 70px;
      right: 0;
      width: 350px;
      height: 500px;
      background: white;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.2);
      display: none;
      flex-direction: column;
      overflow: hidden;
    \`;

    // Header del chat
    var chatHeader = document.createElement('div');
    chatHeader.style.cssText = \`
      background: \${theme.primaryColor || '#4F46E5'};
      color: white;
      padding: 16px;
      font-weight: 600;
      display: flex;
      justify-content: space-between;
      align-items: center;
    \`;
    chatHeader.innerHTML = \`
      <span>\${widgetConfig.chatbot.name}</span>
      <button id="close-chat" style="background: none; border: none; color: white; font-size: 20px; cursor: pointer;">&times;</button>
    \`;

    // Área de mensajes
    var messagesArea = document.createElement('div');
    messagesArea.id = 'chat-messages';
    messagesArea.style.cssText = \`
      flex: 1;
      padding: 16px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
    \`;

    // Input area
    var inputArea = document.createElement('div');
    inputArea.style.cssText = \`
      padding: 16px;
      border-top: 1px solid #e5e7eb;
      display: flex;
      gap: 8px;
    \`;

    var messageInput = document.createElement('input');
    messageInput.type = 'text';
    messageInput.placeholder = config.placeholder || 'Escribe tu mensaje...';
    messageInput.style.cssText = \`
      flex: 1;
      padding: 12px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      outline: none;
      font-size: 14px;
    \`;

    var sendButton = document.createElement('button');
    sendButton.innerHTML = '➤';
    sendButton.style.cssText = \`
      background: \${theme.primaryColor || '#4F46E5'};
      color: white;
      border: none;
      border-radius: 8px;
      padding: 12px 16px;
      cursor: pointer;
      font-size: 16px;
    \`;

    // Ensamblar widget
    inputArea.appendChild(messageInput);
    inputArea.appendChild(sendButton);
    chatWindow.appendChild(chatHeader);
    chatWindow.appendChild(messagesArea);
    chatWindow.appendChild(inputArea);
    widgetContainer.appendChild(chatButton);
    widgetContainer.appendChild(chatWindow);

    // Variables de estado
    var isOpen = false;
    var conversationId = null;

    // Event listeners
    chatButton.addEventListener('click', function() {
      isOpen = !isOpen;
      chatWindow.style.display = isOpen ? 'flex' : 'none';
      if (isOpen && !conversationId) {
        startConversation();
      }
    });

    document.getElementById('close-chat').addEventListener('click', function() {
      isOpen = false;
      chatWindow.style.display = 'none';
    });

    sendButton.addEventListener('click', sendMessage);
    messageInput.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') sendMessage();
    });

    // Funciones de chat
    function startConversation() {
      addMessage('bot', widgetConfig.chatbot.welcomeMessage);
    }

    function sendMessage() {
      var message = messageInput.value.trim();
      if (!message) return;

      addMessage('user', message);
      messageInput.value = '';

      // Enviar a la API
      fetch(window.ConversaAI.config.apiUrl + '/chat/message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: message,
          widgetId: window.ConversaAI.config.widgetId,
          conversationId: conversationId,
          metadata: {
            url: window.location.href,
            userAgent: navigator.userAgent
          }
        })
      })
      .then(response => response.json())
      .then(data => {
        if (data.success) {
          conversationId = data.conversationId;
          addMessage('bot', data.message.content);
        } else {
          addMessage('bot', 'Lo siento, hubo un error. Por favor intenta de nuevo.');
        }
      })
      .catch(error => {
        console.error('Error:', error);
        addMessage('bot', 'Lo siento, no puedo responder en este momento.');
      });
    }

    function addMessage(sender, content) {
      var messageDiv = document.createElement('div');
      messageDiv.style.cssText = \`
        max-width: 80%;
        padding: 12px;
        border-radius: 12px;
        font-size: 14px;
        line-height: 1.4;
        \${sender === 'user' ? 
          \`background: \${theme.primaryColor || '#4F46E5'}; color: white; align-self: flex-end; margin-left: auto;\` :
          'background: #f3f4f6; color: #1f2937; align-self: flex-start;'
        }
      \`;
      messageDiv.textContent = content;
      messagesArea.appendChild(messageDiv);
      messagesArea.scrollTop = messagesArea.scrollHeight;
    }
  }

  // Iniciar cuando el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertWidget);
  } else {
    insertWidget();
  }
})();
</script>
<!-- Fin Conversa.ai Widget Script -->`;
        res.setHeader('Content-Type', 'application/javascript');
        res.send(script);
    }
    catch (error) {
        console.error('Error generando script:', error);
        res.status(500).send('// Error cargando widget de Conversa.ai');
    }
});
router.get('/js/widget.js', async (req, res) => {
    try {
        const widgetJS = `
// Conversa.ai Widget Library v1.0.0
(function(window) {
  'use strict';

  var ConversaAI = {
    version: '1.0.0',
    apiUrl: '${process.env.FRONTEND_URL || 'http://localhost:3001'}/api',
    
    init: function(options) {
      this.widgetId = options.widgetId;
      this.config = options.config || {};
      this.loadWidget();
    },

    loadWidget: function() {
      var self = this;
      fetch(this.apiUrl + '/widget/' + this.widgetId)
        .then(function(response) { return response.json(); })
        .then(function(data) {
          if (data.success) {
            self.createWidget(data.widget);
          }
        })
        .catch(function(error) {
          console.error('Conversa.ai error:', error);
        });
    },

    createWidget: function(widgetConfig) {
      // Implementación simplificada del widget
      console.log('Widget cargado:', widgetConfig.name);
    }
  };

  // Exponer globalmente
  window.ConversaAI = ConversaAI;

  // Auto-init si hay configuración en window
  if (window.conversaAI && window.conversaAI.widgetId) {
    ConversaAI.init(window.conversaAI);
  }

})(window);
`;
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.send(widgetJS);
    }
    catch (error) {
        console.error('Error sirviendo widget.js:', error);
        res.status(500).send('// Error cargando Conversa.ai');
    }
});
router.get('/:id/health', async (req, res) => {
    try {
        const widgetId = req.params.id;
        const widget = await database_1.db.getClient().widget.findUnique({
            where: { id: widgetId },
            include: {
                chatbot: { select: { isActive: true } },
                tenant: { select: { isActive: true, subscriptionStatus: true } }
            }
        });
        if (!widget) {
            return res.status(404).json({ status: 'not_found' });
        }
        const status = widget.isActive &&
            widget.chatbot?.isActive &&
            widget.tenant.isActive &&
            widget.tenant.subscriptionStatus === 'active' ? 'healthy' : 'degraded';
        res.json({
            status,
            timestamp: new Date().toISOString(),
            widget: {
                id: widget.id,
                active: widget.isActive,
                chatbotActive: widget.chatbot?.isActive,
                tenantActive: widget.tenant.isActive,
                subscriptionActive: widget.tenant.subscriptionStatus === 'active'
            }
        });
    }
    catch (error) {
        console.error('Error en health check del widget:', error);
        res.status(500).json({
            status: 'error',
            timestamp: new Date().toISOString(),
            error: 'Internal server error'
        });
    }
});
exports.default = router;
//# sourceMappingURL=widget.js.map