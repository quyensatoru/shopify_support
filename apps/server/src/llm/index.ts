import { ChatAnthropic } from '@langchain/anthropic';
import { getEnv } from '../env.js';

let _model: ChatAnthropic | undefined;
let _modelFast: ChatAnthropic | undefined;

export function getLlm(): ChatAnthropic {
    if (_model) return _model;
    _model = new ChatAnthropic({
        model: 'claude-sonnet-4-6',
        apiKey: getEnv().ANTHROPIC_API_KEY,
        temperature: 0.1,
        maxTokens: 4096,
    });
    return _model;
}

// Lighter model for distill / memory tasks
export function getLlmFast(): ChatAnthropic {
    if (_modelFast) return _modelFast;
    _modelFast = new ChatAnthropic({
        model: 'claude-haiku-4-5-20251001',
        apiKey: getEnv().ANTHROPIC_API_KEY,
        temperature: 0,
        maxTokens: 1024,
    });
    return _modelFast;
}
