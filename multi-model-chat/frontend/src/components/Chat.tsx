import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  getModels,
  streamChat,
  type ChatMessage,
  type ChatRequestMessage,
  type MeResponse,
  type ModelInfo,
} from '../api';
import ModelSelector from './ModelSelector';

type Conversation = {
  id: string;
  title: string;
  model: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
};

type ChatProps = {
  me: MeResponse;
};

const storageKey = 'multi-model-chat.conversations';

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

const messageBubbleStyle = (role: ChatMessage['role']): CSSProperties => ({
  padding: '16px 18px',
  borderRadius: 18,
  maxWidth: '80%',
  alignSelf: role === 'user' ? 'flex-end' : 'flex-start',
  background: role === 'user' ? 'linear-gradient(135deg, #0ea5e9, #2563eb)' : '#111c35',
  border: role === 'user' ? 'none' : '1px solid rgba(148, 163, 184, 0.12)',
  whiteSpace: 'pre-wrap',
  lineHeight: 1.6,
  boxShadow: '0 16px 32px rgba(2, 6, 23, 0.24)',
});

function loadStoredConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as Conversation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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

export default function Chat({ me }: ChatProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState('');
  const [draft, setDraft] = useState('');
  const [loadingModels, setLoadingModels] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = loadStoredConversations();
    setConversations(stored);
    if (stored[0]) {
      setActiveId(stored[0].id);
      setSelectedModel(stored[0].model);
    }
  }, []);

  useEffect(() => {
    if (conversations.length > 0) {
      localStorage.setItem(storageKey, JSON.stringify(conversations));
    }
  }, [conversations]);

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

  useEffect(() => {
    if (!activeConversation && conversations[0]) {
      setActiveId(conversations[0].id);
      setSelectedModel(conversations[0].model);
    }
  }, [activeConversation, conversations]);

  function persistConversation(nextConversation: Conversation) {
    setConversations((current) => {
      const existing = current.find((conversation) => conversation.id === nextConversation.id);
      const rest = current.filter((conversation) => conversation.id !== nextConversation.id);
      const ordered = [nextConversation, ...rest].sort((left, right) => right.updatedAt - left.updatedAt);
      return existing ? ordered : [nextConversation, ...current].sort((left, right) => right.updatedAt - left.updatedAt);
    });
  }

  function createConversation(modelOverride?: string): Conversation {
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      title: 'New conversation',
      model: modelOverride || selectedModel || models[0]?.name || '',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setActiveId(conversation.id);
    setSelectedModel(conversation.model);
    persistConversation(conversation);
    return conversation;
  }

  function updateActiveConversation(transform: (conversation: Conversation) => Conversation) {
    if (!activeConversation) {
      return;
    }
    const nextConversation = transform(activeConversation);
    persistConversation(nextConversation);
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
    setSending(true);

    const conversation = activeConversation ?? createConversation(model);
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: prompt };
    const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: '', pending: true };
    const seededConversation: Conversation = {
      ...conversation,
      model,
      title: conversation.messages.length === 0 ? deriveTitle(prompt) : conversation.title,
      messages: [...conversation.messages, userMessage, assistantMessage],
      updatedAt: Date.now(),
    };
    persistConversation(seededConversation);
    setActiveId(seededConversation.id);

    const requestMessages: ChatRequestMessage[] = [...conversation.messages, userMessage].map((message) => ({
      role: message.role,
      content: message.content,
    }));

    try {
      await streamChat(model, requestMessages, {
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
        onFinal: (message, usage) => {
          setConversations((current) =>
            current.map((item) => {
              if (item.id !== seededConversation.id) {
                return item;
              }
              const nextMessages = [...item.messages];
              nextMessages[nextMessages.length - 1] = {
                ...nextMessages[nextMessages.length - 1],
                content: message.content,
                usage,
                pending: false,
              };
              return { ...item, model, messages: nextMessages, updatedAt: Date.now() };
            }),
          );
        },
      });
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
              onClick={() => {
                setActiveId(conversation.id);
                setSelectedModel(conversation.model);
              }}
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
              <div style={{ fontSize: 12, color: '#94a3b8' }}>{conversation.messages.length} messages</div>
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

        <section style={{ flex: 1, overflowY: 'auto', padding: '28px 28px 12px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {activeConversation?.messages.map((message) => (
              <div key={message.id} style={messageBubbleStyle(message.role)}>
                <div style={{ fontSize: 12, textTransform: 'uppercase', opacity: 0.7, marginBottom: 8 }}>
                  {message.role === 'user' ? me.name || 'You' : 'Assistant'}
                </div>
                <div>{message.content || (message.pending ? 'Thinking…' : '')}</div>
                {formatUsage(message) ? (
                  <div style={{ marginTop: 12, fontSize: 12, color: '#cbd5e1', opacity: 0.85 }}>{formatUsage(message)}</div>
                ) : null}
              </div>
            ))}

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
