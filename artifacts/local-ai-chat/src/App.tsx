import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Archive, ArrowUp, Check, ChevronDown, CircleHelp, Code2, Copy, Lightbulb, Menu, PanelLeft, Plus, Search, Settings, ShieldCheck, Sparkles, Trash2, X, Zap } from 'lucide-react';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import NotFound from '@/pages/not-found';

type Mode = 'Focus' | 'Create' | 'Code';
type Role = 'user' | 'assistant';
type Message = { id: string; role: Role; content: string; createdAt: number };
type Conversation = { id: string; title: string; mode: Mode; messages: Message[]; updatedAt: number };

const queryClient = new QueryClient();
const STORAGE_KEY = 'nova-local-conversations-v1';
const MODE_META: Record<Mode, { description: string; icon: typeof Sparkles; tint: string }> = {
  Focus: { description: 'Clear thinking, fewer distractions', icon: Lightbulb, tint: 'hsl(38 90% 56%)' },
  Create: { description: 'Turn rough ideas into shape', icon: Sparkles, tint: 'hsl(12 61% 67%)' },
  Code: { description: 'Reason through technical work', icon: Code2, tint: 'hsl(165 30% 42%)' },
};

function makeId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function starterConversation(): Conversation {
  return { id: makeId(), title: 'Untitled session', mode: 'Focus', messages: [], updatedAt: Date.now() };
}

function readConversations(): Conversation[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return [starterConversation()];
    const parsed = JSON.parse(saved) as Conversation[];
    return Array.isArray(parsed) && parsed.length ? parsed : [starterConversation()];
  } catch {
    return [starterConversation()];
  }
}

function localAnswer(mode: Mode, prompt: string) {
  const clean = prompt.trim().replace(/\s+/g, ' ');
  if (mode === 'Create') {
    return `Let's give that idea a useful shape.\n\n**A clear starting point**\n${clean}\n\nTry this next: write the smallest version that could be true by the end of today. Keep the rough edges visible; we can refine once the direction has earned its place.`;
  }
  if (mode === 'Code') {
    return `I’ll reason through this locally, without sending your code anywhere.\n\n**First pass**\n${clean}\n\nA good next move is to isolate one expected input and one expected output, then test the smallest path between them. If you share the relevant snippet, I can help trace the edge cases and propose a focused change.`;
  }
  return `Here’s a quieter way to look at it.\n\n**What seems central**\n${clean}\n\nSeparate the signal from the pressure around it. Name the decision you actually need to make, then list the one piece of information that would change your mind. That usually gives the next step somewhere solid to land.`;
}

function relativeTime(timestamp: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function AppShell() {
  const [conversations, setConversations] = useState<Conversation[]>(readConversations);
  const [activeId, setActiveId] = useState(() => conversations[0]?.id ?? '');
  const [mode, setMode] = useState<Mode>(() => conversations[0]?.mode ?? 'Focus');
  const [draft, setDraft] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedId, setCopiedId] = useState('');
  const [showModeMenu, setShowModeMenu] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId) ?? conversations[0],
    [activeId, conversations],
  );
  const messages = activeConversation?.messages ?? [];
  const filteredConversations = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    return conversations.filter((conversation) => conversation.title.toLowerCase().includes(query));
  }, [conversations, searchQuery]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  }, [conversations]);

  useEffect(() => {
    if (activeConversation && activeConversation.mode !== mode) setMode(activeConversation.mode);
  }, [activeConversation, mode]);

  useEffect(() => {
    if (!isThinking) return;
    const timer = window.setTimeout(() => setIsThinking(false), 950);
    return () => window.clearTimeout(timer);
  }, [isThinking]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        createConversation();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  function updateConversation(id: string, update: (conversation: Conversation) => Conversation) {
    setConversations((current) => current.map((conversation) => conversation.id === id ? update(conversation) : conversation));
  }

  function createConversation() {
    const conversation = starterConversation();
    setConversations((current) => [conversation, ...current]);
    setActiveId(conversation.id);
    setMode('Focus');
    setDraft('');
    setIsSidebarOpen(false);
    window.setTimeout(() => textareaRef.current?.focus(), 80);
  }

  function selectConversation(id: string) {
    setActiveId(id);
    const selected = conversations.find((conversation) => conversation.id === id);
    if (selected) setMode(selected.mode);
    setIsSidebarOpen(false);
    setDraft('');
  }

  function deleteConversation(id: string) {
    const next = conversations.filter((conversation) => conversation.id !== id);
    if (!next.length) {
      const replacement = starterConversation();
      setConversations([replacement]);
      setActiveId(replacement.id);
      setMode('Focus');
      return;
    }
    if (id === activeId) {
      setActiveId(next[0].id);
      setMode(next[0].mode);
    }
    setConversations(next);
  }

  function changeMode(nextMode: Mode) {
    setMode(nextMode);
    if (activeConversation) updateConversation(activeConversation.id, (conversation) => ({ ...conversation, mode: nextMode, updatedAt: Date.now() }));
    setShowModeMenu(false);
  }

  function sendMessage() {
    const prompt = draft.trim();
    if (!prompt || isThinking || !activeConversation) return;
    const userMessage: Message = { id: makeId(), role: 'user', content: prompt, createdAt: Date.now() };
    const title = activeConversation.messages.length ? activeConversation.title : prompt.length > 34 ? `${prompt.slice(0, 34)}…` : prompt;
    updateConversation(activeConversation.id, (conversation) => ({
      ...conversation,
      title,
      mode,
      updatedAt: Date.now(),
      messages: [...conversation.messages, userMessage],
    }));
    setDraft('');
    setIsThinking(true);
    window.setTimeout(() => {
      const assistantMessage: Message = { id: makeId(), role: 'assistant', content: localAnswer(mode, prompt), createdAt: Date.now() };
      updateConversation(activeConversation.id, (conversation) => ({
        ...conversation,
        updatedAt: Date.now(),
        messages: [...conversation.messages, assistantMessage],
      }));
      setIsThinking(false);
    }, 980);
  }

  function handleDraftKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  function copyMessage(message: Message) {
    void navigator.clipboard?.writeText(message.content);
    setCopiedId(message.id);
    window.setTimeout(() => setCopiedId(''), 1500);
  }

  return (
    <div className="nova-shell nova-noise flex min-h-[100dvh] overflow-hidden text-foreground">
      {isSidebarOpen && <button type="button" aria-label="Close navigation" data-testid="button-close-sidebar" className="fixed inset-0 z-30 bg-[hsl(202_30%_16%/.34)] md:hidden" onClick={() => setIsSidebarOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[286px] flex-col bg-[hsl(var(--sidebar))] text-[hsl(var(--sidebar-foreground))] transition-transform duration-300 md:static md:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`} data-testid="sidebar-navigation">
        <div className="flex items-center justify-between px-6 pb-5 pt-7">
          <button type="button" className="flex items-center gap-3 text-left" data-testid="button-home-brand" onClick={() => selectConversation(conversations[0]?.id ?? '')}>
            <span className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-[hsl(var(--sidebar-primary))] text-[hsl(var(--sidebar-primary-foreground))] shadow-[0_5px_18px_hsl(38_90%_70%/.18)]"><Sparkles size={18} strokeWidth={2.2} /></span>
            <span><span className="block text-[17px] font-extrabold tracking-[-.03em]">NOVA</span><span className="nova-mono block text-[9px] uppercase tracking-[.2em] text-[hsl(var(--sidebar-foreground)/.52)]">local intelligence</span></span>
          </button>
          <button type="button" className="rounded-md p-1.5 text-[hsl(var(--sidebar-foreground)/.58)] hover:bg-[hsl(var(--sidebar-accent))] hover:text-[hsl(var(--sidebar-foreground))] md:hidden" data-testid="button-mobile-close" onClick={() => setIsSidebarOpen(false)}><X size={18} /></button>
        </div>

        <div className="px-4">
          <button type="button" data-testid="button-new-chat" onClick={createConversation} className="flex w-full items-center justify-between rounded-lg bg-[hsl(var(--sidebar-primary))] px-4 py-3 text-sm font-bold text-[hsl(var(--sidebar-primary-foreground))] shadow-[0_8px_20px_hsl(38_90%_70%/.12)] transition-transform hover:-translate-y-0.5 active:translate-y-0">
            <span className="flex items-center gap-2.5"><Plus size={17} strokeWidth={2.5} /> New thought</span><span className="nova-mono text-[10px] opacity-60">⌘ N</span>
          </button>
        </div>

        <div className="mt-7 px-4">
          <div className="mb-2 flex items-center justify-between px-2">
            <span className="nova-mono text-[9px] uppercase tracking-[.18em] text-[hsl(var(--sidebar-foreground)/.42)]">Your archive</span>
            <span className="nova-mono text-[10px] text-[hsl(var(--sidebar-foreground)/.35)]">{conversations.length}</span>
          </div>
          <label className="flex items-center gap-2 rounded-md border border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-accent)/.35)] px-2.5 py-2 text-[hsl(var(--sidebar-foreground)/.5)]">
            <Search size={14} />
            <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Find a thought" data-testid="input-search-conversations" className="min-w-0 flex-1 bg-transparent text-xs text-[hsl(var(--sidebar-foreground))] outline-none placeholder:text-[hsl(var(--sidebar-foreground)/.38)]" />
          </label>
        </div>
        <div className="nova-scrollbar flex-1 overflow-y-auto px-3 py-3">
          {filteredConversations.length ? filteredConversations.map((conversation) => (
            <div key={conversation.id} className={`group mb-1 flex items-center gap-1 rounded-lg transition-colors ${conversation.id === activeId ? 'bg-[hsl(var(--sidebar-accent))]' : 'hover:bg-[hsl(var(--sidebar-accent)/.62)]'}`}>
              <button type="button" data-testid={`button-conversation-${conversation.id}`} onClick={() => selectConversation(conversation.id)} className="min-w-0 flex-1 px-3 py-3 text-left">
                <span className={`mb-1 block truncate text-[12px] font-semibold ${conversation.id === activeId ? 'text-[hsl(var(--sidebar-foreground))]' : 'text-[hsl(var(--sidebar-foreground)/.75)]'}`}>{conversation.title}</span>
                <span className="nova-mono block text-[9px] text-[hsl(var(--sidebar-foreground)/.38)]">{relativeTime(conversation.updatedAt)} <span className="mx-1">·</span> {conversation.messages.length} {conversation.messages.length === 1 ? 'note' : 'notes'}</span>
              </button>
              <button type="button" aria-label={`Delete ${conversation.title}`} data-testid={`button-delete-conversation-${conversation.id}`} onClick={() => deleteConversation(conversation.id)} className="mr-1 rounded-md p-2 text-[hsl(var(--sidebar-foreground)/.28)] opacity-0 transition-opacity hover:bg-[hsl(var(--destructive)/.18)] hover:text-[hsl(var(--accent))] group-hover:opacity-100"><Trash2 size={14} /></button>
            </div>
          )) : <p className="px-3 py-8 text-center text-xs text-[hsl(var(--sidebar-foreground)/.45)]">No thoughts match that search.</p>}
        </div>

        <div className="border-t border-[hsl(var(--sidebar-border))] p-4">
          <div className="mb-3 flex items-center gap-2 px-1"><span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--sidebar-primary))] shadow-[0_0_0_4px_hsl(var(--sidebar-primary)/.12)]" /><span className="nova-mono text-[9px] uppercase tracking-[.16em] text-[hsl(var(--sidebar-foreground)/.5)]">Private by default</span></div>
          <button type="button" data-testid="button-open-settings" onClick={() => setIsSettingsOpen(true)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-sm text-[hsl(var(--sidebar-foreground)/.7)] transition-colors hover:bg-[hsl(var(--sidebar-accent))] hover:text-[hsl(var(--sidebar-foreground))]"><Settings size={16} /><span>Settings & privacy</span></button>
          <div className="mt-3 flex items-center gap-2 px-2 text-[10px] text-[hsl(var(--sidebar-foreground)/.32)]"><Archive size={13} /><span>Stored in this browser only</span></div>
        </div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-[76px] shrink-0 items-center justify-between border-b border-[hsl(var(--border)/.76)] px-5 sm:px-8 lg:px-12">
          <div className="flex items-center gap-3">
            <button type="button" aria-label="Open navigation" data-testid="button-open-sidebar" className="rounded-lg p-2 text-muted-foreground hover:bg-[hsl(var(--muted))] md:hidden" onClick={() => setIsSidebarOpen(true)}><Menu size={20} /></button>
            <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex"><span className="nova-mono text-[10px] uppercase tracking-[.16em]">Workspace</span><span className="text-border">/</span><span className="font-semibold text-foreground">{activeConversation?.title ?? 'New thought'}</span></div>
            <span className="nova-mono text-[10px] uppercase tracking-[.14em] text-muted-foreground sm:hidden">NOVA / {mode}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <button type="button" data-testid="button-mode-selector" onClick={() => setShowModeMenu((open) => !open)} className="flex items-center gap-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card)/.72)] px-3 py-2 text-xs font-bold shadow-[0_2px_5px_hsl(202_30%_16%/.03)] transition-colors hover:border-[hsl(var(--accent)/.7)]">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: MODE_META[mode].tint }} /><span>{mode} mode</span><ChevronDown size={14} className={`text-muted-foreground transition-transform ${showModeMenu ? 'rotate-180' : ''}`} />
              </button>
              {showModeMenu && <div className="nova-pop absolute right-0 top-11 z-20 w-[235px] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--popover))] p-1.5 shadow-[var(--shadow-lg)]" data-testid="menu-mode-selector">
                {(Object.keys(MODE_META) as Mode[]).map((option) => {
                  const Icon = MODE_META[option].icon;
                  return <button type="button" key={option} data-testid={`button-mode-${option.toLowerCase()}`} onClick={() => changeMode(option)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-[hsl(var(--muted))] ${option === mode ? 'bg-[hsl(var(--muted))]' : ''}`}><span className="flex h-7 w-7 items-center justify-center rounded-md bg-[hsl(var(--muted))]" style={{ color: MODE_META[option].tint }}><Icon size={15} /></span><span className="flex-1"><span className="block text-xs font-bold">{option}</span><span className="block text-[10px] text-muted-foreground">{MODE_META[option].description}</span></span>{option === mode && <Check size={15} className="text-[hsl(var(--accent))]" />}</button>;
                })}
              </div>}
            </div>
            <button type="button" aria-label="Open settings" data-testid="button-header-settings" onClick={() => setIsSettingsOpen(true)} className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-[hsl(var(--muted))] hover:text-foreground"><Settings size={18} /></button>
          </div>
        </header>

        <section className="nova-scrollbar flex-1 overflow-y-auto">
          <div className={`mx-auto flex w-full max-w-[900px] flex-col px-5 pb-36 pt-10 sm:px-10 lg:pt-14 ${messages.length ? '' : 'min-h-full'}`}>
            {messages.length === 0 && !isThinking ? <EmptyState mode={mode} onPrompt={(prompt) => { setDraft(prompt); window.setTimeout(() => textareaRef.current?.focus(), 50); }} /> : <div className="space-y-9">
              <div className="nova-rise flex items-center gap-3"><div className="h-px flex-1 bg-[hsl(var(--border))]" /><span className="nova-mono text-[9px] uppercase tracking-[.17em] text-muted-foreground">Today · local session</span><div className="h-px flex-1 bg-[hsl(var(--border))]" /></div>
              {messages.map((message, index) => <MessageBlock key={message.id} message={message} index={index} copied={copiedId === message.id} onCopy={() => copyMessage(message)} />)}
              {isThinking && <ThinkingState mode={mode} />}
            </div>}
          </div>
        </section>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-[hsl(var(--background))] via-[hsl(var(--background)/.92)] to-transparent px-5 pb-5 pt-14 sm:px-10">
          <div className="pointer-events-auto mx-auto w-full max-w-[900px]">
            <div className="group relative rounded-2xl border border-[hsl(var(--input))] bg-[hsl(var(--card)/.94)] p-2 shadow-[0_10px_35px_hsl(202_30%_16%/.08)] backdrop-blur-md transition-colors focus-within:border-[hsl(var(--accent)/.7)] focus-within:shadow-[0_12px_40px_hsl(202_30%_16%/.12)]">
              <textarea ref={textareaRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleDraftKeyDown} disabled={isThinking} data-testid="input-message-composer" placeholder={isThinking ? 'NOVA is thinking locally…' : `Ask NOVA anything in ${mode} mode…`} rows={2} className="nova-scrollbar min-h-[58px] w-full resize-none bg-transparent px-3 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground/70 disabled:opacity-60" />
              <div className="flex items-center justify-between px-2 pb-1 pt-2">
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground"><span className="nova-mono rounded border border-[hsl(var(--border))] px-1.5 py-0.5">LOCAL</span><span className="hidden sm:inline">Nothing leaves this device</span></div>
                <div className="flex items-center gap-2"><span className="nova-mono hidden text-[9px] text-muted-foreground/70 sm:inline">Shift + Enter for new line</span><button type="button" disabled={!draft.trim() || isThinking} data-testid="button-send-message" onClick={sendMessage} className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] transition-all hover:-translate-y-0.5 hover:bg-[hsl(var(--accent))] disabled:cursor-not-allowed disabled:opacity-30"><ArrowUp size={17} strokeWidth={2.5} /></button></div>
              </div>
            </div>
            <p className="mt-2 text-center text-[10px] text-muted-foreground/70"><ShieldCheck size={12} className="mr-1 inline-block align-[-2px]" /> Your conversation is saved locally in this browser.</p>
          </div>
        </div>
      </main>

      {isSettingsOpen && <SettingsPanel onClose={() => setIsSettingsOpen(false)} onClear={() => { localStorage.removeItem(STORAGE_KEY); const fresh = starterConversation(); setConversations([fresh]); setActiveId(fresh.id); setMode('Focus'); setIsSettingsOpen(false); }} />}
    </div>
  );
}

function EmptyState({ mode, onPrompt }: { mode: Mode; onPrompt: (prompt: string) => void }) {
  const suggestions = mode === 'Code'
    ? ['Help me think through a bug', 'Explain a concept simply', 'Review an approach I’m considering']
    : mode === 'Create'
      ? ['Shape a rough idea with me', 'Find a sharper opening line', 'Help me get unstuck']
      : ['Help me untangle a decision', 'Make a plan for a full day', 'Give me a second perspective'];
  const ModeIcon = MODE_META[mode].icon;
  return <div className="flex flex-1 flex-col items-center justify-center py-10 text-center sm:py-20">
    <div className="nova-rise mb-7 flex h-[72px] w-[72px] items-center justify-center rounded-[24px] border border-[hsl(var(--border))] bg-[hsl(var(--card)/.8)] shadow-[0_12px_30px_hsl(202_30%_16%/.06)]" style={{ animationDelay: '80ms' }}><ModeIcon size={28} style={{ color: MODE_META[mode].tint }} strokeWidth={1.5} /></div>
    <p className="nova-mono nova-rise mb-4 text-[10px] uppercase tracking-[.22em] text-muted-foreground" style={{ animationDelay: '140ms' }}>A quiet place to begin</p>
    <h1 className="nova-serif nova-rise max-w-[620px] text-[clamp(2.4rem,6vw,4.65rem)] leading-[.92] tracking-[-.045em] text-foreground" style={{ animationDelay: '200ms' }}>What’s on your mind?</h1>
    <p className="nova-rise mt-5 max-w-[430px] text-sm leading-6 text-muted-foreground" style={{ animationDelay: '260ms' }}>NOVA is a private thinking partner. Start with a question, a feeling, or a half-formed idea.</p>
    <div className="nova-rise mt-9 flex max-w-[610px] flex-wrap justify-center gap-2" style={{ animationDelay: '340ms' }}>
      {suggestions.map((suggestion) => <button type="button" key={suggestion} data-testid={`button-suggestion-${suggestion.slice(0, 8).replace(/\s/g, '-').toLowerCase()}`} onClick={() => onPrompt(suggestion)} className="rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--card)/.65)] px-3.5 py-2 text-xs text-muted-foreground transition-all hover:-translate-y-0.5 hover:border-[hsl(var(--accent)/.65)] hover:bg-[hsl(var(--card))] hover:text-foreground">{suggestion}</button>)}
    </div>
  </div>;
}

function MessageBlock({ message, index, copied, onCopy }: { message: Message; index: number; copied: boolean; onCopy: () => void }) {
  const isUser = message.role === 'user';
  return <article className={`nova-rise flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}`} style={{ animationDelay: `${Math.min(index * 70, 280)}ms` }} data-testid={`message-${message.role}-${message.id}`}>
    {!isUser && <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"><Sparkles size={15} /></div>}
    <div className={`max-w-[82%] sm:max-w-[70%] ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
      <div className={`rounded-2xl px-4 py-3.5 text-sm leading-6 ${isUser ? 'rounded-br-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'rounded-bl-md border border-[hsl(var(--border))] bg-[hsl(var(--card)/.72)] text-foreground shadow-[0_3px_14px_hsl(202_30%_16%/.035)]'}`}>
        {message.content.split('\n').map((line, lineIndex) => <p key={`${message.id}-${lineIndex}`} className={line.startsWith('**') ? 'mb-1 font-bold last:mb-0' : line === '' ? 'h-2' : ''}>{line.replace(/\*\*/g, '')}</p>)}
      </div>
      <div className={`mt-1.5 flex items-center gap-2 px-1 text-[10px] text-muted-foreground ${isUser ? 'flex-row-reverse' : ''}`}>
        <span className="nova-mono">{isUser ? 'You' : 'NOVA'} <span className="mx-1 opacity-50">·</span> {new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
        {!isUser && <button type="button" data-testid={`button-copy-message-${message.id}`} onClick={onCopy} className="inline-flex items-center gap-1 hover:text-foreground">{copied ? <Check size={11} /> : <Copy size={11} />} {copied ? 'Copied' : 'Copy'}</button>}
      </div>
    </div>
  </article>;
}

function ThinkingState({ mode }: { mode: Mode }) {
  return <div className="nova-rise flex gap-3" data-testid="status-thinking"><div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"><Sparkles size={15} /></div><div className="rounded-2xl rounded-bl-md border border-[hsl(var(--border))] bg-[hsl(var(--card)/.72)] px-4 py-3.5"><div className="flex items-center gap-2 text-xs text-muted-foreground"><span>Thinking in {mode}</span><span className="flex gap-1"><i className="h-1 w-1 animate-pulse rounded-full bg-[hsl(var(--accent))]" /><i className="h-1 w-1 animate-pulse rounded-full bg-[hsl(var(--accent))] [animation-delay:120ms]" /><i className="h-1 w-1 animate-pulse rounded-full bg-[hsl(var(--accent))] [animation-delay:240ms]" /></span></div></div></div>;
}

function SettingsPanel({ onClose, onClear }: { onClose: () => void; onClear: () => void }) {
  return <div className="fixed inset-0 z-50 flex justify-end" data-testid="settings-panel">
    <button type="button" aria-label="Close settings overlay" data-testid="button-close-settings-overlay" className="absolute inset-0 bg-[hsl(202_30%_16%/.4)]" onClick={onClose} />
    <section className="nova-pop relative flex h-full w-full max-w-[430px] flex-col border-l border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-[var(--shadow-xl)]">
      <div className="flex items-start justify-between border-b border-[hsl(var(--border))] px-6 pb-5 pt-7"><div><p className="nova-mono mb-2 text-[9px] uppercase tracking-[.2em] text-muted-foreground">Workspace controls</p><h2 className="nova-serif text-3xl tracking-[-.035em]">Settings</h2></div><button type="button" aria-label="Close settings" data-testid="button-close-settings" onClick={onClose} className="rounded-lg p-2 text-muted-foreground hover:bg-[hsl(var(--muted))] hover:text-foreground"><X size={18} /></button></div>
      <div className="nova-scrollbar flex-1 overflow-y-auto p-6">
        <div className="nova-sheen rounded-2xl bg-[hsl(var(--primary))] p-5 text-[hsl(var(--primary-foreground))]"><div className="mb-5 flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[hsl(var(--secondary))]"><ShieldCheck size={21} /></div><div><p className="text-sm font-bold">Local-only privacy</p><p className="nova-mono mt-0.5 text-[9px] uppercase tracking-[.13em] opacity-60">Always on</p></div></div><p className="text-sm leading-6 text-[hsl(var(--primary-foreground)/.75)]">Your conversations are stored in this browser’s local storage. NOVA’s answer engine runs here in the app. Nothing is uploaded, profiled, or used to train an external service.</p></div>
        <div className="mt-8"><h3 className="mb-3 text-xs font-bold uppercase tracking-[.12em] text-muted-foreground">How it works</h3><div className="divide-y divide-[hsl(var(--border))] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card)/.55)]"><InfoRow icon={<Zap size={15} />} title="Local answer engine" detail="Fast, private responses without a network request." /><InfoRow icon={<PanelLeft size={15} />} title="Browser memory" detail="Saved conversations stay on this device." /><InfoRow icon={<CircleHelp size={15} />} title="You’re in control" detail="Clear everything at any time, with one click." /></div></div>
        <div className="mt-8"><h3 className="mb-3 text-xs font-bold uppercase tracking-[.12em] text-muted-foreground">Data controls</h3><button type="button" data-testid="button-clear-local-data" onClick={onClear} className="flex w-full items-center justify-between rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card)/.55)] px-4 py-3.5 text-left transition-colors hover:border-[hsl(var(--destructive)/.5)] hover:bg-[hsl(var(--destructive)/.06)]"><span><span className="block text-sm font-bold">Clear local conversations</span><span className="mt-1 block text-xs text-muted-foreground">Remove every saved thought from this browser.</span></span><Trash2 size={16} className="text-muted-foreground" /></button></div>
        <p className="nova-mono mt-10 text-[9px] leading-5 text-muted-foreground">NOVA / local intelligence<br />No account · No tracking · No external calls</p>
      </div>
    </section>
  </div>;
}

function InfoRow({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="flex items-start gap-3 px-4 py-3.5"><span className="mt-0.5 text-[hsl(var(--accent))]">{icon}</span><span><span className="block text-xs font-bold">{title}</span><span className="mt-1 block text-[11px] leading-5 text-muted-foreground">{detail}</span></span></div>;
}

function Router() {
  return <ErrorBoundary><Switch><Route path="/" component={AppShell} /><Route component={NotFound} /></Switch></ErrorBoundary>;
}

export default function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}