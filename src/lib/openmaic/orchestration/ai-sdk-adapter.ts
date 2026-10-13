import { withClassroomAiStream } from "@/lib/llm/classroom-capacity";
/**
 * AI SDK Adapter for LangGraph
 *
 * Provides LangChain-compatible interface for LLM calls.
 * Uses the unified callLLM / streamLLM layer which goes through
 * Vercel AI SDK, supporting all providers (OpenAI, Anthropic, Google, etc.).
 */

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { ChatResult } from '@langchain/core/outputs';
import { stepCountIs, type LanguageModel, type ToolSet } from 'ai';

import { callLLM, streamLLM } from '@openmaic/lib/ai/llm';
import type { ThinkingConfig } from '@openmaic/lib/types/provider';
import { createLogger } from '@openmaic/lib/logger';

const log = createLogger('AISdkAdapter');

/**
 * Stream chunk types for streaming generation
 */
export type StreamChunk =
  | { type: 'delta'; content: string }
  | {
      type: 'tool_calls';
      toolCalls: {
        id: string;
        index: number;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { type: 'done'; content: string };

/**
 * Adapter to use any AI SDK LanguageModel with LangGraph
 *
 * Accepts a LanguageModel instance (from getModel()) instead of raw
 * API credentials, enabling support for all providers.
 */
export class AISdkLangGraphAdapter extends BaseChatModel {
  private languageModel: LanguageModel;
  private thinking?: ThinkingConfig;

  constructor(languageModel: LanguageModel, thinking?: ThinkingConfig) {
    super({});
    this.languageModel = languageModel;
    this.thinking = thinking;
  }

  _llmType(): string {
    return 'ai-sdk';
  }

  _combineLLMOutput() {
    return {};
  }

  /**
   * Convert LangChain messages to AI SDK message format
   */
  private convertMessages(
    messages: BaseMessage[],
  ): { role: 'system' | 'user' | 'assistant'; content: string }[] {
    return messages.map((msg) => {
      if (msg instanceof HumanMessage) {
        return { role: 'user' as const, content: msg.content as string };
      } else if (msg instanceof AIMessage) {
        return { role: 'assistant' as const, content: msg.content as string };
      } else if (msg instanceof SystemMessage) {
        return { role: 'system' as const, content: msg.content as string };
      } else {
        return { role: 'user' as const, content: msg.content as string };
      }
    });
  }

  async _generate(
    messages: BaseMessage[],
    options?: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const aiMessages = this.convertMessages(messages);

    try {
      const result = await callLLM(
        {
          model: this.languageModel,
          messages: aiMessages,
          abortSignal: options?.signal,
        },
        'chat-adapter',
        undefined,
        this.thinking,
      );

      const content = result.text || '';

      log.info('[AI SDK Adapter] Response:', {
        textLength: content.length,
      });

      // Create AI message
      const aiMessage = new AIMessage({ content });

      return {
        generations: [
          {
            text: content,
            message: aiMessage,
          },
        ],
        llmOutput: {},
      };
    } catch (error) {
      log.error('[AI SDK Adapter Error]', error);
      throw error;
    }
  }

  /**
   * Stream generate with text deltas
   *
   * Yields chunks of text as they arrive, then yields done with full content.
   * Uses streamLLM which goes through Vercel AI SDK's streamText.
   */
  async *streamGenerate(
    messages: BaseMessage[],
    options?: { tools?: ToolSet; signal?: AbortSignal },
  ): AsyncGenerator<StreamChunk> {
    yield* withClassroomAiStream(signal => this.streamGenerateWithCapacity(messages, { ...options, signal }), options?.signal);
  }

  private async *streamGenerateWithCapacity(
    messages: BaseMessage[], options?: { tools?: ToolSet; signal?: AbortSignal },
  ): AsyncGenerator<StreamChunk> {
    const aiMessages = this.convertMessages(messages);

    const hasTools = Boolean(options?.tools && Object.keys(options.tools).length > 0);
    const result = streamLLM(
      {
        model: this.languageModel,
        messages: aiMessages,
        abortSignal: options?.signal,
        ...(hasTools
          ? {
              tools: options!.tools,
              toolChoice: 'auto' as const,
              stopWhen: stepCountIs(8),
            }
          : {}),
      },
      'chat-adapter-stream',
      this.thinking,
    );

    let fullContent = '';

    if (hasTools) {
      for await (const rawPart of result.fullStream as AsyncIterable<Record<string, unknown>>) {
        const partType = rawPart.type;
        if (partType === 'text-delta') {
          const content =
            (rawPart.text as string | undefined) ??
            (rawPart.textDelta as string | undefined) ??
            '';
          if (content) {
            fullContent += content;
            yield { type: 'delta', content };
          }
        } else if (partType === 'tool-call') {
          const toolCallId = String(rawPart.toolCallId ?? `tool-${Date.now()}`);
          const toolName = String(rawPart.toolName ?? '');
          if (!toolName) continue;
          yield {
            type: 'tool_calls',
            toolCalls: [
              {
                id: toolCallId,
                index: 0,
                type: 'function',
                function: {
                  name: toolName,
                  arguments: JSON.stringify(rawPart.input ?? {}),
                },
              },
            ],
          };
        } else if (partType === 'error') {
          const error = rawPart.error;
          throw error instanceof Error ? error : new Error(String(error ?? 'LLM stream error'));
        }
      }

      yield { type: 'done', content: fullContent };
      return;
    }

    for await (const chunk of result.textStream) {
      if (chunk) {
        fullContent += chunk;
        yield { type: 'delta', content: chunk };
      }
    }

    // Yield done with full content
    yield { type: 'done', content: fullContent };
  }
}
