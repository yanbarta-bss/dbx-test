import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  getConversation,
  getModels,
  listConversations,
  streamChat,
  type ChatMessage,
  type ChatRequestMessage,
  type FallbackInfo,
  type MeResponse,
  type ModelInfo,
} from '../api';
import ModelSelector from './ModelSelector';

// Local working shape. `id` is a stable per-session React key; `serverId` is the Lakebase
// conversation id (present once the server has persisted at least one turn). We never remap
// `id` mid-stream — the streaming closures match on it.
type Conversation = {
  id: string;
  serverId?: string;
  title: string;
  model: string;
  messages: ChatMessage[];
  loaded: boolean;
  updatedAt: number;
};

type ChatProps = {
  me: MeResponse;
};

const shellStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '280px minmax(0, 1fr)',
  minHeight: '100vh',
};

const sidebarStyle: CSSProperties = {
  borderRight: '1px solid rgba(148, 163, 184, 0.12)',
  background: 'rgba(15, 23, 42, 0.86)',
  backdropFilter: 'blur(18px)',
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
};

const messageBubbleStyle = (role: ChatMessage['role'], blocked = false): CSSProperties => ({
  padding: '16px 18px',
  borderRadius: 18,
  maxWidth: '80%',
  alignSelf: role === 'user' ? 'flex-end' : 'flex-start',
  background: blocked
    ? 'rgba(120, 53, 15, 0.35)'
    : role === 'user'
    ? 'linear-gradient(135deg, #0ea5e9, #2563eb)'
    : '#111c35',
  border: blocked
    ? '1px solid rgba(252, 211, 77, 0.4)'
    : role === 'user'
    ? 'none'
    : '1px solid rgba(148, 163, 184, 0.12)',
  whiteSpace: 'pre-wrap',
  lineHeight: 1.6,
  boxShadow: '0 16px 32px rgba(2, 6, 23, 0.24)',
});

function deriveTitle(content: string): string {
  const cleaned = content.trim().replace(/\s+/g, ' ');
  return cleaned.length > 42 ? `${cleaned.slice(0, 42)}…` : cleaned || 'New conversation';
}

function formatUsage(message: ChatMessage): string | null {
  if (!message.usage) {
    return null;
  }
  const { input_tokens, output_tokens, total_tokens } = message.usage;
  return `${input_tokens} in • ${output_tokens} out • ${total_tokens} total tokens`;
}

function formatScores(message: ChatMessage): string | null {
  if (!message.scores) {
    return null;
  }
  const parts: string[] = [];
  const { relevance, safety, groundedness } = message.scores;
  if (relevance !== undefined) parts.push(`rel ${relevance.toFixed(2)}`);
  if (safety !== undefined) parts.push(`safe ${safety.toFixed(2)}`);
  if (groundedness !== undefined) parts.push(`grnd ${groundedness.toFixed(2)}`);
  return parts.length ? `judge: ${parts.join(' • ')}` : null;
}

export default function Chat({ me }: ChatProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState('');
  const [draft, setDraft] = useState('');
  const [loadingModels, setLoadingModels] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallback, setFallback] = useState<FallbackInfo | null>(null);

  // Load server-backed history (Lakebase). Empty when persistence is disabled.
  useEffect(() => {
    listConversations()
      .then((summaries) => {
        const mapped: Conversation[] = summaries.map((summary) => ({
          id: summary.id,
          serverId: summary.id,
          title: summary.title,
          model: summary.model,
          messages: [],
          loaded: false,
          updatedAt: summary.updated_at,
        }));
        setConversations(mapped);
      })
      .catch(() => {
        // Persistence unavailable — start with a clean in-memory session.
      });
  }, []);

  useEffect(() => {
    getModels()
      .then((availableModels) => {
        setModels(availableModels);
        if (!selectedModel && availableModels[0]) {
          setSelectedModel(availableModels[0].name);
        }
      })
      .catch((requestError) => {
        setError(requestError instanceof Error ? requestError.message : 'Failed to load serving endpoints.');
      })
      .finally(() => setLoadingModels(false));
  }, [selectedModel]);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId) ?? null,
    [activeId, conversations],
  );

  function upsertConversation(next: Conversation) {
    setConversations((current) => {
      const rest = current.filter((conversation) => conversation.id !== next.id);
      return [next, ...rest].sort((left, right) => right.updatedAt - left.updatedAt);
    });
  }

  function createConversation(modelOverride?: string): Conversation {
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      title: 'New conversation',
      model: modelOverride || selectedModel || models[0]?.name || '',
      messages: [],
      loaded: true,
      updatedAt: Date.now(),
    };
    setActiveId(conversation.id);
    setSelectedModel(conversation.model);
    upsertConversation(conversation);
    return conversation;
  }

  async function selectConversation(conversation: Conversation) {
    setActiveId(conversation.id);
    setSelectedModel(conversation.model);
    setFallback(null);
    if (conversation.loaded || !conversation.serverId) {
      return;
    }
    try {
      const full = await getConversation(conversation.serverId);
      setConversations((current) =>
        current.map((item) =>
          item.id === conversation.id
            ? { ...item, messages: full.messages, title: full.title, model: full.model, loaded: true }
            : item,
        ),
      );
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load conversation.');
    }
  }

  async function handleSend() {
    const prompt = draft.trim();
    if (!prompt || sending) {
      return;
    }

    const model = selectedModel || models[0]?.name;
    if (!model) {
      setError('No serving endpoint is available for chat.');
      return;
    }

    setDraft('');
    setError(null);
    setFallback(null);
    setSending(true);

    const conversation = activeConversation ?? createConversation(model);
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: prompt };
    const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: '', pending: true };
    const seededConversation: Conversation = {
      ...conversation,
      model,
      title: conversation.messages.length === 0 ? deriveTitle(prompt) : conversation.title,
      messages: [...conversation.messages, userMessage, assistantMessage],
      loaded: true,
      updatedAt: Date.now(),
    };
    upsertConversation(seededConversation);
    setActiveId(seededConversation.id);

    const requestMessages: ChatRequestMessage[] = [...conversation.messages, userMessage].map((message) => ({
      role: message.role,
      content: message.content,
    }));

    function setServerId(conversationId?: string) {
      if (!conversationId) {
        return;
      }
      setConversations((current) =>
        current.map((item) => (item.id === seededConversation.id ? { ...item, serverId: conversationId } : item)),
      );
    }

    try {
      await streamChat(
        model,
        requestMessages,
        {
          onMeta: (meta) => {
            setServerId(meta.conversationId);
            if (meta.fallback?.used) {
              setFallback(meta.fallback);
            }
          },
          onDelta: (delta) => {
            setConversations((current) =>
              current.map((item) => {
                if (item.id !== seededConversation.id) {
                  return item;
                }
                const nextMessages = [...item.messages];
                const lastMessage = nextMessages[nextMessages.length - 1];
                if (!lastMessage || lastMessage.role !== 'assistant') {
                  return item;
                }
                nextMessages[nextMessages.length - 1] = {
                  ...lastMessage,
                  content: `${lastMessage.content}${delta}`,
                  pending: true,
                };
                return { ...item, model, messages: nextMessages, updatedAt: Date.now() };
              }),
            );
          },
          onFinal: (final) => {
            setServerId(final.conversationId);
            setConversations((current) =>
              current.map((item) => {
                if (item.id !== seededConversation.id) {
                  return item;
                }
                const nextMessages = [...item.messages];
                nextMessages[nextMessages.length - 1] = {
                  ...nextMessages[nextMessages.length - 1],
                  content: final.message.content,
                  usage: final.usage,
                  scores: final.scores,
                  trace_id: final.traceId,
                  guardrail: final.guardrail,
                  pending: false,
                };
                return { ...item, model, messages: nextMessages, updatedAt: Date.now() };
              }),
            );
          },
        },
        conversation.serverId ?? null,
      );
    } catch (requestError) {
      const detail = requestError instanceof Error ? requestError.message : 'The chat request failed.';
      setError(detail);
      setConversations((current) =>
        current.map((item) => {
          if (item.id !== seededConversation.id) {
            return item;
          }
          const nextMessages = item.messages.slice(0, -1);
          return {
            ...item,
            messages: [
              ...nextMessages,
              {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: `Request failed. ${detail}`,
              },
            ],
            updatedAt: Date.now(),
          };
        }),
      );
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }

  return (
    <div style={shellStyle}>
      <aside style={sidebarStyle}>
        <div>
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#38bdf8' }}>Databricks App</div>
          <div style={{ fontSize: 24, fontWeight: 700, marginTop: 8 }}>Multi-model chat</div>
          <div style={{ marginTop: 8, color: '#94a3b8', lineHeight: 1.5 }}>
            Signed in as {me.name} {me.email ? `(${me.email})` : ''}
          </div>
        </div>

        <button
          onClick={() => createConversation(selectedModel || models[0]?.name)}
          style={{
            border: 'none',
            background: 'linear-gradient(135deg, #38bdf8, #2563eb)',
            color: '#eff6ff',
            borderRadius: 14,
            padding: '12px 14px',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          New conversation
        </button>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', minHeight: 0, paddingRight: 6 }}>
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              onClick={() => void selectConversation(conversation)}
              style={{
                textAlign: 'left',
                border: activeId === conversation.id ? '1px solid rgba(56, 189, 248, 0.5)' : '1px solid transparent',
                background: activeId === conversation.id ? 'rgba(37, 99, 235, 0.2)' : 'rgba(15, 23, 42, 0.7)',
                borderRadius: 14,
                padding: '12px 14px',
                cursor: 'pointer',
                color: '#e2e8f0',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{conversation.title}</div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                {conversation.loaded ? `${conversation.messages.length} messages` : 'Saved · click to open'}
              </div>
            </button>
          ))}
          {conversations.length === 0 ? <div style={{ color: '#94a3b8' }}>Start a conversation to see chat history here.</div> : null}
        </div>

        {me.isAdmin ? (
          <Link
            to="/admin"
            style={{
              marginTop: 'auto',
              color: '#bae6fd',
              textDecoration: 'none',
              background: 'rgba(56, 189, 248, 0.08)',
              border: '1px solid rgba(56, 189, 248, 0.18)',
              borderRadius: 12,
              padding: '12px 14px',
              display: 'inline-flex',
            }}
          >
            Open admin dashboard
          </Link>
        ) : null}
      </aside>

      <main style={panelStyle}>
        <header
          style={{
            padding: '24px 28px',
            borderBottom: '1px solid rgba(148, 163, 184, 0.12)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>Ask your workspace models</div>
            <div style={{ marginTop: 6, color: '#94a3b8' }}>
              Responses are proxied through Databricks Model Serving endpoints and streamed over SSE.
            </div>
          </div>
          <ModelSelector models={models} value={selectedModel} disabled={loadingModels || sending} onChange={setSelectedModel} />
        </header>

        {fallback ? (
          <div
            style={{
              margin: '16px 28px 0',
              background: 'rgba(30, 58, 138, 0.35)',
              border: '1px solid rgba(96, 165, 250, 0.4)',
              color: '#bfdbfe',
              borderRadius: 14,
              padding: '10px 14px',
              fontSize: 14,
            }}
          >
            ↺ Served by <strong>{fallback.served_model}</strong> via AI Gateway fallback (requested{' '}
            <strong>{fallback.requested_model}</strong>).
          </div>
        ) : null}

        <section style={{ flex: 1, overflowY: 'auto', padding: '28px 28px 12px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {activeConversation?.messages.map((message) => {
              const blocked = message.guardrail?.blocked ?? false;
              return (
                <div key={message.id} style={messageBubbleStyle(message.role, blocked)}>
                  <div style={{ fontSize: 12, textTransform: 'uppercase', opacity: 0.7, marginBottom: 8 }}>
                    {message.role === 'user' ? me.name || 'You' : 'Assistant'}
                    {blocked ? (
                      <span style={{ marginLeft: 8, color: '#fcd34d' }}>· Blocked by AI Gateway guardrail</span>
                    ) : null}
                  </div>
                  <div>{message.content || (message.pending ? 'Thinking…' : '')}</div>
                  {blocked && message.guardrail?.reason ? (
                    <div style={{ marginTop: 10, fontSize: 12, color: '#fde68a', opacity: 0.85 }}>{message.guardrail.reason}</div>
                  ) : null}
                  {!blocked && formatUsage(message) ? (
                    <div style={{ marginTop: 12, fontSize: 12, color: '#cbd5e1', opacity: 0.85 }}>{formatUsage(message)}</div>
                  ) : null}
                  {!blocked && formatScores(message) ? (
                    <div style={{ marginTop: 4, fontSize: 12, color: '#a5b4fc', opacity: 0.9 }}>
                      {formatScores(message)}
                      {message.trace_id ? (
                        <span style={{ marginLeft: 8, color: '#64748b', fontFamily: 'monospace' }}>{message.trace_id}</span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}

            {!activeConversation || activeConversation.messages.length === 0 ? (
              <div style={{ ...messageBubbleStyle('assistant'), maxWidth: 720 }}>
                <div style={{ fontSize: 12, textTransform: 'uppercase', opacity: 0.7, marginBottom: 8 }}>Assistant</div>
                <div>Choose a model, ask a question, and the app will stream the response here.</div>
              </div>
            ) : null}
          </div>
        </section>

        <footer style={{ padding: '20px 28px 28px' }}>
          {error ? (
            <div
              style={{
                marginBottom: 14,
                background: 'rgba(127, 29, 29, 0.35)',
                border: '1px solid rgba(248, 113, 113, 0.3)',
                color: '#fecaca',
                borderRadius: 14,
                padding: '12px 14px',
              }}
            >
              {error}
            </div>
          ) : null}
          <div
            style={{
              borderRadius: 22,
              border: '1px solid rgba(148, 163, 184, 0.18)',
              background: 'rgba(15, 23, 42, 0.82)',
              padding: 14,
              boxShadow: '0 16px 32px rgba(2, 6, 23, 0.2)',
            }}
          >
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about your data, code, or models..."
              rows={4}
              style={{
                width: '100%',
                resize: 'none',
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: '#e2e8f0',
                fontSize: 15,
                fontFamily: 'inherit',
                lineHeight: 1.6,
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <div style={{ color: '#94a3b8', fontSize: 13 }}>
                {selectedModel ? `Using ${models.find((model) => model.name === selectedModel)?.label ?? selectedModel}` : 'Select a model'}
              </div>
              <button
                onClick={() => void handleSend()}
                disabled={sending || !draft.trim() || !selectedModel}
                style={{
                  border: 'none',
                  cursor: sending ? 'wait' : 'pointer',
                  borderRadius: 14,
                  padding: '12px 18px',
                  fontWeight: 700,
                  background: sending ? '#334155' : 'linear-gradient(135deg, #38bdf8, #2563eb)',
                  color: '#eff6ff',
                }}
              >
                {sending ? 'Streaming…' : 'Send'}
              </button>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
