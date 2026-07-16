export type MeResponse = {
  email: string;
  name: string;
  isAdmin: boolean;
};

export type ModelInfo = {
  name: string;
  label: string;
};

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

// LLM-as-judge scores (MLflow eval). Each is 0..1; omitted when eval is disabled.
export type EvalScores = {
  relevance?: number;
  safety?: number;
  groundedness?: number;
};

// Surfaced when an AI Gateway guardrail acts on a request/response.
export type GuardrailInfo = {
  blocked: boolean;
  action?: 'blocked' | 'masked';
  reason?: string;
};

// Surfaced when AI Gateway fallback served the reply from a different model.
export type FallbackInfo = {
  used: boolean;
  requested_model: string;
  served_model: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  usage?: TokenUsage;
  scores?: EvalScores;
  trace_id?: string;
  guardrail?: GuardrailInfo;
  pending?: boolean;
};

export type ChatRequestMessage = Pick<ChatMessage, 'role' | 'content'>;

// Server-backed conversation DTOs (Lakebase persistence). Timestamps are epoch ms.
export type ConversationSummary = {
  id: string;
  title: string;
  model: string;
  updated_at: number;
  message_count: number;
};

export type Conversation = {
  id: string;
  title: string;
  model: string;
  created_at: number;
  updated_at: number;
  messages: ChatMessage[];
};

export type UsageRow = {
  user: string;
  model: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  total_dbus: number;
  estimated_cost: number;
};

export type EvalSummary = {
  avg_relevance: number;
  avg_safety: number;
  avg_groundedness: number;
  sample_count: number;
};

export type UsageResponse = {
  rows: UsageRow[];
  message?: string | null;
  dbu_price: number;
  governed_by_gateway: boolean;
  eval_summary?: EvalSummary | null;
};

export type StreamMeta = {
  conversationId?: string;
  governed?: boolean;
  fallback?: FallbackInfo;
};

export type StreamFinal = {
  message: ChatMessage;
  usage: TokenUsage;
  conversationId?: string;
  guardrail?: GuardrailInfo;
  scores?: EvalScores;
  traceId?: string;
};

type StreamHandlers = {
  onMeta?: (meta: StreamMeta) => void;
  onDelta?: (delta: string) => void;
  onFinal?: (final: StreamFinal) => void;
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function getMe(): Promise<MeResponse> {
  return fetchJson<MeResponse>('/api/me');
}

export async function getModels(): Promise<ModelInfo[]> {
  const response = await fetchJson<{ models: ModelInfo[] }>('/api/models');
  return response.models;
}

export async function getUsage(days: number): Promise<UsageResponse> {
  return fetchJson<UsageResponse>(`/api/admin/usage?days=${days}`);
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const response = await fetchJson<{ conversations: ConversationSummary[] }>('/api/conversations');
  return response.conversations ?? [];
}

export async function getConversation(id: string): Promise<Conversation> {
  return fetchJson<Conversation>(`/api/conversations/${encodeURIComponent(id)}`);
}

type SsePayload = {
  type: 'meta' | 'delta' | 'final';
  delta?: string;
  message?: { role: 'assistant'; content: string };
  usage?: TokenUsage;
  conversation_id?: string;
  governed?: boolean;
  fallback?: FallbackInfo;
  guardrail?: GuardrailInfo;
  scores?: EvalScores;
  trace_id?: string;
};

export async function streamChat(
  model: string,
  messages: ChatRequestMessage[],
  handlers: StreamHandlers,
  conversationId?: string | null,
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify({ model, messages, conversation_id: conversationId ?? null }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Chat request failed: ${response.status}`);
  }

  if (!response.body) {
    throw new Error('The server did not return a stream.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    const segments = buffer.split(/\r?\n\r?\n/);
    buffer = segments.pop() ?? '';

    for (const segment of segments) {
      const dataLines = segment
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.replace(/^data:\s*/, ''));

      if (!dataLines.length) {
        continue;
      }

      const payload = JSON.parse(dataLines.join('\n')) as SsePayload;

      if (payload.type === 'meta') {
        handlers.onMeta?.({
          conversationId: payload.conversation_id,
          governed: payload.governed,
          fallback: payload.fallback,
        });
      }

      if (payload.type === 'delta' && payload.delta !== undefined) {
        handlers.onDelta?.(payload.delta);
      }

      if (payload.type === 'final' && payload.message) {
        const usage: TokenUsage = payload.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
        handlers.onFinal?.({
          message: {
            id: crypto.randomUUID(),
            role: payload.message.role,
            content: payload.message.content,
            usage,
            scores: payload.scores,
            trace_id: payload.trace_id,
            guardrail: payload.guardrail,
          },
          usage,
          conversationId: payload.conversation_id,
          guardrail: payload.guardrail,
          scores: payload.scores,
          traceId: payload.trace_id,
        });
      }
    }

    if (done) {
      break;
    }
  }
}
