import { useState, useRef, useEffect } from 'react';
import { useLocation } from 'wouter';
import { ChevronLeft, Send, Loader2, Bot, User, CheckCircle } from 'lucide-react';
import { needsApi } from '@/lib/api';
import type { IntakeResponse } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { AppShell } from '@/components/layout/AppShell';

interface Message {
  role:    'user' | 'assistant';
  content: string;
}

const SESSION_ID = crypto.randomUUID();

export default function IntakeChat() {
  const [, navigate] = useLocation();
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content: "Hi! I'm here to help connect you with the right support. Just tell me in your own words what you need help with, and I'll guide you from there.",
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [needId, setNeedId] = useState<string | null>(null);
  const [turn, setTurn] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || loading || done) return;

    setMessages((m) => [...m, { role: 'user', content: text }]);
    setInput('');
    setLoading(true);

    try {
      const res: IntakeResponse = await needsApi.intake(SESSION_ID, text);
      setMessages((m) => [...m, { role: 'assistant', content: res.reply }]);
      setTurn(res.turn);
      if (res.isComplete) {
        setDone(true);
        if (res.needId) setNeedId(res.needId);
      }
    } catch {
      setMessages((m) => [...m, {
        role: 'assistant',
        content: "Sorry, I had trouble with that. Please try again or use the form to post your need directly.",
      }]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  return (
    <AppShell hideNav>
      <div className="flex flex-col h-full bg-background">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 pt-12 pb-3 border-b border-border">
          <button
            type="button"
            onClick={() => navigate('/post-need')}
            className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-muted"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2.5 flex-1">
            <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center">
              <Bot className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="font-semibold text-sm">BridgeUp AI</p>
              <p className="text-xs text-green-600 font-medium flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                Online
              </p>
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => navigate('/post-need')} className="text-xs">
            Use form instead
          </Button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.map((msg, i) => (
            <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
              <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center ${msg.role === 'assistant' ? 'bg-primary/10' : 'bg-muted'}`}>
                {msg.role === 'assistant' ? (
                  <Bot className="w-4 h-4 text-primary" />
                ) : (
                  <User className="w-4 h-4 text-muted-foreground" />
                )}
              </div>
              <div
                className={`max-w-[80%] px-4 py-3 rounded-2xl text-sm leading-relaxed ${
                  msg.role === 'assistant'
                    ? 'bg-muted text-foreground rounded-tl-sm'
                    : 'bg-primary text-primary-foreground rounded-tr-sm'
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                <Bot className="w-4 h-4 text-primary" />
              </div>
              <div className="bg-muted rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          )}

          {done && needId && (
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle className="w-4 h-4 text-green-600" />
              </div>
              <div className="bg-green-50 border border-green-200 rounded-2xl rounded-tl-sm px-4 py-3 flex-1">
                <p className="text-sm font-medium text-green-800 mb-2">Request submitted!</p>
                <p className="text-xs text-green-700 mb-3">We&apos;re now searching for verified helpers near you.</p>
                <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white" onClick={() => navigate(`/needs/${needId}`)}>
                  Track your request →
                </Button>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        {!done && (
          <div className="px-4 pb-8 pt-3 border-t border-border">
            <div className="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
                placeholder="Type your message… (Enter to send)"
                disabled={loading}
                className="flex-1 px-4 py-3 rounded-2xl border border-border bg-card resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                maxLength={1000}
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={!input.trim() || loading}
                className="w-11 h-11 rounded-full bg-primary text-white flex items-center justify-center flex-shrink-0 disabled:opacity-40 transition-opacity"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </button>
            </div>
            <p className="text-xs text-muted-foreground text-center mt-2">
              Turn {turn + 1} of 3 · Your info is private and never shared
            </p>
          </div>
        )}
      </div>
    </AppShell>
  );
}
