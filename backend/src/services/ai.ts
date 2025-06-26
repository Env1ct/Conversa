import { OpenAI } from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

export type AIModel = 'gpt-4' | 'gpt-4-turbo' | 'claude-3.5-sonnet' | 'gemini-pro';

export interface AIResponse {
  content: string;
  model: string;
  tokensUsed?: number;
  responseTime: number;
  cost?: number;
}

export interface ChatContext {
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPrompt?: string;
  companyInfo?: string;
  userInfo?: any;
}

export class AIService {
  private openai: OpenAI;
  private anthropic: Anthropic;
  private gemini: GoogleGenerativeAI;

  constructor() {
    // Inicializar clientes de IA
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    this.gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  }

  // Método principal para generar respuestas
  public async generateResponse(
    message: string,
    context: ChatContext,
    model: AIModel = 'gpt-4'
  ): Promise<AIResponse> {
    const startTime = Date.now();

    try {
      let response: AIResponse;

      switch (model) {
        case 'gpt-4':
        case 'gpt-4-turbo':
          response = await this.generateOpenAIResponse(message, context, model);
          break;
        case 'claude-3.5-sonnet':
          response = await this.generateClaudeResponse(message, context);
          break;
        case 'gemini-pro':
          response = await this.generateGeminiResponse(message, context);
          break;
        default:
          throw new Error(`Modelo no soportado: ${model}`);
      }

      response.responseTime = Date.now() - startTime;
      return response;

    } catch (error) {
      console.error(`Error con modelo ${model}:`, error);
      
      // Fallback a GPT-4 si el modelo principal falla
      if (model !== 'gpt-4') {
        console.log('Intentando fallback a GPT-4...');
        return this.generateResponse(message, context, 'gpt-4');
      }
      
      throw new Error('Error al generar respuesta con IA');
    }
  }

  // Implementación para OpenAI
  private async generateOpenAIResponse(
    message: string,
    context: ChatContext,
    model: 'gpt-4' | 'gpt-4-turbo'
  ): Promise<AIResponse> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    // Agregar prompt del sistema
    if (context.systemPrompt) {
      messages.push({
        role: 'system',
        content: this.buildSystemPrompt(context),
      });
    }

    // Agregar historial de conversación
    if (context.conversationHistory) {
      context.conversationHistory.forEach(msg => {
        messages.push({
          role: msg.role,
          content: msg.content,
        });
      });
    }

    // Agregar mensaje actual
    messages.push({
      role: 'user',
      content: message,
    });

    const completion = await this.openai.chat.completions.create({
      model: model === 'gpt-4-turbo' ? 'gpt-4-1106-preview' : 'gpt-4',
      messages,
      max_tokens: 1000,
      temperature: 0.7,
      presence_penalty: 0.6,
      frequency_penalty: 0.3,
    });

    const usage = completion.usage;
    const content = completion.choices[0]?.message?.content || '';

    return {
      content,
      model,
      tokensUsed: usage?.total_tokens,
      responseTime: 0, // Se calculará en el método principal
      cost: this.calculateOpenAICost(usage?.total_tokens || 0, model),
    };
  }

  // Implementación para Claude
  private async generateClaudeResponse(
    message: string,
    context: ChatContext
  ): Promise<AIResponse> {
    const systemPrompt = this.buildSystemPrompt(context);

    // Construir mensajes para Claude
    const messages: any[] = [];

    // Agregar historial
    if (context.conversationHistory) {
      context.conversationHistory.forEach(msg => {
        messages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        });
      });
    }

    // Agregar mensaje actual
    messages.push({
      role: 'user',
      content: message,
    });

    const response = await this.anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    });

    const content = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;

    return {
      content,
      model: 'claude-3.5-sonnet',
      tokensUsed,
      responseTime: 0,
      cost: this.calculateClaudeCost(tokensUsed),
    };
  }

  // Implementación para Gemini
  private async generateGeminiResponse(
    message: string,
    context: ChatContext
  ): Promise<AIResponse> {
    const model = this.gemini.getGenerativeModel({ model: 'gemini-pro' });

    const systemPrompt = this.buildSystemPrompt(context);
    
    // Construir el prompt completo para Gemini
    let fullPrompt = systemPrompt + '\n\n';

    // Agregar historial si existe
    if (context.conversationHistory) {
      fullPrompt += 'Historial de conversación:\n';
      context.conversationHistory.forEach(msg => {
        fullPrompt += `${msg.role === 'user' ? 'Usuario' : 'Asistente'}: ${msg.content}\n`;
      });
      fullPrompt += '\n';
    }

    fullPrompt += `Usuario: ${message}\nAsistente:`;

    const result = await model.generateContent(fullPrompt);
    const response = await result.response;
    const content = response.text();

    return {
      content,
      model: 'gemini-pro',
      tokensUsed: 0, // Gemini no proporciona conteo de tokens en la respuesta
      responseTime: 0,
      cost: 0, // Gemini tiene un tier gratuito generoso
    };
  }

  // Construir prompt del sistema
  private buildSystemPrompt(context: ChatContext): string {
    let prompt = context.systemPrompt || 'Eres un asistente virtual útil y profesional.';

    if (context.companyInfo) {
      prompt += `\n\nInformación de la empresa: ${context.companyInfo}`;
    }

    if (context.userInfo) {
      prompt += `\n\nInformación del usuario: ${JSON.stringify(context.userInfo)}`;
    }

    prompt += `\n\nInstrucciones importantes:
- Mantén un tono profesional pero amigable
- Si no sabes algo, admítelo honestamente
- Proporciona respuestas útiles y específicas
- Si la consulta está fuera de tu área de conocimiento, sugiere contactar con un humano
- Mantén las respuestas concisas pero completas`;

    return prompt;
  }

  // Calcular costos estimados
  private calculateOpenAICost(tokens: number, model: string): number {
    const rates = {
      'gpt-4': { input: 0.03, output: 0.06 }, // por 1K tokens
      'gpt-4-turbo': { input: 0.01, output: 0.03 },
    };

    const rate = rates[model as keyof typeof rates] || rates['gpt-4'];
    // Estimación simple (asumiendo 50% input, 50% output)
    return ((tokens / 1000) * (rate.input + rate.output)) / 2;
  }

  private calculateClaudeCost(tokens: number): number {
    // Claude: $3 por 1M tokens input, $15 por 1M tokens output
    // Estimación simple (asumiendo 50% input, 50% output)
    return ((tokens / 1000000) * (3 + 15)) / 2;
  }

  // Seleccionar el mejor modelo basado en el plan del tenant
  public selectModelForTenant(plan: string, complexity: 'simple' | 'medium' | 'complex' = 'medium'): AIModel {
    if (plan === 'enterprise') {
      return complexity === 'complex' ? 'claude-3.5-sonnet' : 'gpt-4-turbo';
    } else if (plan === 'business') {
      return complexity === 'simple' ? 'gemini-pro' : 'gpt-4';
    } else if (plan === 'professional') {
      return complexity === 'complex' ? 'gpt-4' : 'gemini-pro';
    } else {
      return 'gemini-pro'; // Starter plan usa el modelo más económico
    }
  }

  // Detectar complejidad del mensaje
  public detectComplexity(message: string): 'simple' | 'medium' | 'complex' {
    const length = message.length;
    const hasQuestions = (message.match(/\?/g) || []).length;
    const hasKeywords = /analiz|compar|evalua|explicar|detallar|complejo/.test(message.toLowerCase());

    if (length > 200 || hasQuestions > 2 || hasKeywords) {
      return 'complex';
    } else if (length > 50 || hasQuestions > 0) {
      return 'medium';
    } else {
      return 'simple';
    }
  }
}

// Exportar instancia singleton
export const aiService = new AIService();