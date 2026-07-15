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

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  usage?: TokenUsage;
  pending?: boolean;
};

export type ChatRequestMessage = Pick<ChatMessage, 'role' | 'content'>;

export type UsageRow = {
  user: string;
  model: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export type UsageResponse = {
  rows: UsageRow[];
  message?: string | null;
};

type StreamHandlers = {
  onMeta?: (payload: unknown) => void;
  onDelta?: (delta: string) => void;
  onFinal?: (message: ChatMessage, usage: TokenUsage) => void;
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

export async function streamChat(
  model: string,
  messages: ChatRequestMessage[],
  handlers: StreamHandlers,
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify({ model, messages }),
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

      const payload = JSON.parse(dataLines.join('\n')) as {
        type: 'meta' | 'delta' | 'final';
        delta?: string;
        message?: { role: 'assistant'; content: string };
        usage?: TokenUsage;
      };

      if (payload.type === 'meta') {
        handlers.onMeta?.(payload);
      }

      if (payload.type === 'delta' && payload.delta !== undefined) {
        handlers.onDelta?.(payload.delta);
      }

      if (payload.type === 'final' && payload.message && payload.usage) {
        handlers.onFinal?.(
          {
            id: crypto.randomUUID(),
            role: payload.message.role,
            content: payload.message.content,
            usage: payload.usage,
          },
          payload.usage,
        );
      }
    }

    if (done) {
      break;
    }
  }
}
