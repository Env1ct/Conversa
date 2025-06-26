"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiService = exports.AIService = void 0;
const openai_1 = require("openai");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const generative_ai_1 = require("@google/generative-ai");
class AIService {
    constructor() {
        this.openai = new openai_1.OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
        this.anthropic = new sdk_1.default({
            apiKey: process.env.ANTHROPIC_API_KEY,
        });
        this.gemini = new generative_ai_1.GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    }
    async generateResponse(message, context, model = 'gpt-4') {
        const startTime = Date.now();
        try {
            let response;
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
        }
        catch (error) {
            console.error(`Error con modelo ${model}:`, error);
            if (model !== 'gpt-4') {
                console.log('Intentando fallback a GPT-4...');
                return this.generateResponse(message, context, 'gpt-4');
            }
            throw new Error('Error al generar respuesta con IA');
        }
    }
    async generateOpenAIResponse(message, context, model) {
        const messages = [];
        if (context.systemPrompt) {
            messages.push({
                role: 'system',
                content: this.buildSystemPrompt(context),
            });
        }
        if (context.conversationHistory) {
            context.conversationHistory.forEach(msg => {
                messages.push({
                    role: msg.role,
                    content: msg.content,
                });
            });
        }
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
            responseTime: 0,
            cost: this.calculateOpenAICost(usage?.total_tokens || 0, model),
        };
    }
    async generateClaudeResponse(message, context) {
        const systemPrompt = this.buildSystemPrompt(context);
        const messages = [];
        if (context.conversationHistory) {
            context.conversationHistory.forEach(msg => {
                messages.push({
                    role: msg.role === 'assistant' ? 'assistant' : 'user',
                    content: msg.content,
                });
            });
        }
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
    async generateGeminiResponse(message, context) {
        const model = this.gemini.getGenerativeModel({ model: 'gemini-pro' });
        const systemPrompt = this.buildSystemPrompt(context);
        let fullPrompt = systemPrompt + '\n\n';
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
            tokensUsed: 0,
            responseTime: 0,
            cost: 0,
        };
    }
    buildSystemPrompt(context) {
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
    calculateOpenAICost(tokens, model) {
        const rates = {
            'gpt-4': { input: 0.03, output: 0.06 },
            'gpt-4-turbo': { input: 0.01, output: 0.03 },
        };
        const rate = rates[model] || rates['gpt-4'];
        return ((tokens / 1000) * (rate.input + rate.output)) / 2;
    }
    calculateClaudeCost(tokens) {
        return ((tokens / 1000000) * (3 + 15)) / 2;
    }
    selectModelForTenant(plan, complexity = 'medium') {
        if (plan === 'enterprise') {
            return complexity === 'complex' ? 'claude-3.5-sonnet' : 'gpt-4-turbo';
        }
        else if (plan === 'business') {
            return complexity === 'simple' ? 'gemini-pro' : 'gpt-4';
        }
        else if (plan === 'professional') {
            return complexity === 'complex' ? 'gpt-4' : 'gemini-pro';
        }
        else {
            return 'gemini-pro';
        }
    }
    detectComplexity(message) {
        const length = message.length;
        const hasQuestions = (message.match(/\?/g) || []).length;
        const hasKeywords = /analiz|compar|evalua|explicar|detallar|complejo/.test(message.toLowerCase());
        if (length > 200 || hasQuestions > 2 || hasKeywords) {
            return 'complex';
        }
        else if (length > 50 || hasQuestions > 0) {
            return 'medium';
        }
        else {
            return 'simple';
        }
    }
}
exports.AIService = AIService;
exports.aiService = new AIService();
//# sourceMappingURL=ai.js.map