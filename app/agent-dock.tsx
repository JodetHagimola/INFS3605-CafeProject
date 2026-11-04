"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { agentMessageSchema, type AgentMessage, type AgentMessagePart } from "@/lib/agent/chat-schema";
import type { ApprovalItem } from "@/lib/agent/approval-schema";
import { LoadingButton, Skeleton } from "./ui/feedback";
import styles from "./agent-dock.module.css";

type VoiceRecognitionResult = {
  isFinal: boolean;
  0: { transcript: string };
};

type VoiceRecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<VoiceRecognitionResult>;
};

type VoiceRecognitionErrorEvent = { error: string };

type VoiceRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: VoiceRecognitionEvent) => void) | null;
  onerror: ((event: VoiceRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type VoiceWindow = Window & {
  SpeechRecognition?: new () => VoiceRecognition;
  webkitSpeechRecognition?: new () => VoiceRecognition;
};

type Thread = { id: string; title: string };
type DisplayMessage = AgentMessage | {
  id: string;
  role: "owner" | "agent";
  content: string;
  parts: AgentMessagePart[];
  createdAt: string;
};

const threadResponseSchema = z.object({
  thread: z.object({ id: z.string().uuid(), title: z.string() }).strict(),
  messages: z.array(agentMessageSchema),
}).strict();

function toolStatus(name: string): string {
  const labels: Record<string, string> = {
    get_inventory: "Checking stock",
    get_recipes: "Reviewing recipes",
    get_sales_summary: "Looking at sales history",
    forecast_demand: "Forecasting demand",
    calculate_shortfalls: "Calculating shortfalls",
    compare_supplier_prices: "Comparing suppliers",
    check_deliveries: "Checking deliveries",
    save_draft_order: "Saving a draft",
    request_human_approval: "Preparing an approval",
    log_wastage: "Recording wastage",
    record_delivery: "Recording a delivery",
  };
  return labels[name] ?? "Working";
}

function responseError(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return "error" in value && typeof value.error === "string" ? value.error : null;
}

export function AgentDock() {
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [tool, setTool] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sending, setSending] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [actionBusy, setActionBusy] = useState("");
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("Voice assistant is off.");
  const loaded = useRef(false);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const recognition = useRef<VoiceRecognition | null>(null);
  const recognitionRunning = useRef(false);
  const voiceEnabledRef = useRef(false);
  const voiceMode = useRef<"off" | "wake" | "command" | "response">("off");
  const greetingFinished = useRef(false);
  const submitMessageRef = useRef<(text: string) => Promise<void>>(async () => {});
  const hasOwnerAction = messages.some((message) =>
    message.parts.some((part) => part.type === "approval_card" && part.item.status === "pending_approval"));

  function startVoiceRecognition() {
    if (!voiceEnabledRef.current || !recognition.current || recognitionRunning.current) return;
    try {
      recognition.current.start();
      recognitionRunning.current = true;
      setVoiceStatus(voiceMode.current === "wake"
        ? "Listening for “Brewly”."
        : "Listening for your question.");
    } catch (startError) {
      voiceEnabledRef.current = false;
      voiceMode.current = "off";
      setVoiceEnabled(false);
      setVoiceStatus("Voice assistant is off.");
      setError(startError instanceof Error
        ? `Voice recognition couldn't start: ${startError.message}`
        : "Voice recognition couldn't start.");
    }
  }

  function speak(text: string, onComplete: () => void) {
    if (!("speechSynthesis" in window) || !window.SpeechSynthesisUtterance) {
      onComplete();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = onComplete;
    utterance.onerror = () => {
      setError("The voice response couldn't be played. You can still read it in the chat.");
      onComplete();
    };
    window.speechSynthesis.speak(utterance);
  }

  function stopVoice() {
    voiceEnabledRef.current = false;
    voiceMode.current = "off";
    recognition.current?.abort();
    recognition.current = null;
    recognitionRunning.current = false;
    window.speechSynthesis?.cancel();
    setVoiceEnabled(false);
    setVoiceStatus("Voice assistant is off.");
  }

  function toggleVoice() {
    if (voiceEnabledRef.current) {
      stopVoice();
      return;
    }

    const voiceWindow = window as VoiceWindow;
    const Recognition = voiceWindow.SpeechRecognition ?? voiceWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setError("Voice recognition isn't supported in this browser. Try a browser with Web Speech API support.");
      return;
    }

    setError("");
    const instance = new Recognition();
    instance.continuous = true;
    instance.interimResults = false;
    instance.lang = "en-AU";
    instance.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result.isFinal) continue;
        const transcript = result[0].transcript.trim();
        if (voiceMode.current === "wake" && /\bbrewly\b/i.test(transcript)) {
          voiceMode.current = "command";
          greetingFinished.current = false;
          setOpen(true);
          setVoiceStatus("Brewly is ready. Ask your question after the greeting.");
          instance.stop();
          speak("Hi, how can I help you today?", () => {
            greetingFinished.current = true;
            if (voiceEnabledRef.current && voiceMode.current === "command") startVoiceRecognition();
          });
          return;
        }
        if (voiceMode.current === "command" && transcript) {
          voiceMode.current = "response";
          greetingFinished.current = false;
          setVoiceStatus("Sending your request to Brewly.");
          setInput(transcript);
          instance.stop();
          void submitMessageRef.current(transcript);
          return;
        }
      }
    };
    instance.onerror = (event) => {
      if (event.error === "aborted" || event.error === "no-speech") return;
      const descriptions: Record<string, string> = {
        "audio-capture": "No microphone was found.",
        "not-allowed": "Microphone access was denied. Allow microphone access to use voice chat.",
        "service-not-allowed": "The browser blocked voice recognition.",
      };
      setError(descriptions[event.error] ?? `Voice recognition failed (${event.error}).`);
      stopVoice();
    };
    instance.onend = () => {
      recognitionRunning.current = false;
      if (voiceEnabledRef.current
        && (voiceMode.current === "wake" || (voiceMode.current === "command" && greetingFinished.current))) {
        startVoiceRecognition();
      }
    };

    recognition.current = instance;
    voiceEnabledRef.current = true;
    voiceMode.current = "wake";
    setVoiceEnabled(true);
    startVoiceRecognition();
  }

  useEffect(() => () => {
    voiceEnabledRef.current = false;
    recognition.current?.abort();
    window.speechSynthesis?.cancel();
  }, []);

  useEffect(() => {
    if (!open || loaded.current) return;
    loaded.current = true;
    setLoadingHistory(true);
    setError("");
    void fetch("/api/agent/chat")
      .then(async (response) => {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new Error("Chat history returned an invalid response.");
        }
        if (!response.ok) throw new Error(responseError(payload) ?? "Chat history could not be loaded.");
        const parsed = threadResponseSchema.safeParse(payload);
        if (!parsed.success) throw new Error("Chat history returned an invalid response.");
        setThread(parsed.data.thread);
        setMessages(parsed.data.messages);
      })
      .catch((loadError: unknown) => {
        loaded.current = false;
        setError(loadError instanceof Error ? loadError.message : "Chat history could not be loaded.");
      })
      .finally(() => setLoadingHistory(false));
  }, [open]);

  useEffect(() => {
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    messagesEnd.current?.scrollIntoView({ behavior, block: "end" });
  }, [messages, open]);

  async function newConversation() {
    if (creatingConversation || sending) return;
    setCreatingConversation(true);
    setError("");
    try {
      const response = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "new" }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(payload) ?? "A new conversation could not be started.");
      const parsed = threadResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error("The new conversation response was invalid.");
      setThread(parsed.data.thread);
      setMessages([]);
    } catch (newError) {
      setError(newError instanceof Error ? newError.message : "A new conversation could not be started.");
    } finally {
      setCreatingConversation(false);
    }
  }

  async function submitMessage(text: string) {
    const request = text.trim();
    if (!request) return;
    if (!thread || sending || creatingConversation) {
      setError("The chat isn't ready yet. Please try your voice request again.");
      if (voiceMode.current === "response") {
        voiceMode.current = "wake";
        setVoiceStatus("Listening for “Brewly”.");
        startVoiceRecognition();
      }
      return;
    }

    setSending(true);
    setTool("");
    setError("");
    setInput("");
    const ownerId = `owner-${Date.now()}`;
    const agentId = `agent-${Date.now()}`;
    let responseText = "";
    setMessages((current) => [
      ...current,
      {
        id: ownerId,
        role: "owner",
        content: request,
        parts: [{ type: "text", text: request }],
        createdAt: new Date().toISOString(),
      },
      {
        id: agentId,
        role: "agent",
        content: "",
        parts: [{ type: "text", text: "" }],
        createdAt: new Date().toISOString(),
      },
    ]);

    try {
      const response = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "message",
          threadId: thread.id,
          text: request,
          route: window.location.pathname,
          visibleItemId: document.querySelector<HTMLElement>("[data-visible-item-id]")?.dataset.visibleItemId,
        }),
      });
      if (!response.ok) {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new Error("The agent could not start a response.");
        }
        throw new Error(responseError(payload) ?? "The agent could not start a response.");
      }
      if (!response.body) throw new Error("The agent response stream was unavailable.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamedText = "";
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event: unknown = JSON.parse(line);
          if (typeof event !== "object" || event === null || !("type" in event)) continue;
          if (event.type === "text" && "text" in event && typeof event.text === "string") {
            streamedText += event.text;
            responseText = streamedText;
            setMessages((current) => current.map((message) => message.id === agentId
              ? { ...message, content: streamedText, parts: [{ type: "text", text: streamedText }] }
              : message));
          } else if (event.type === "tool" && "name" in event && typeof event.name === "string") {
            setTool(toolStatus(event.name));
          } else if (event.type === "complete" && "message" in event) {
            const parsed = agentMessageSchema.safeParse(event.message);
            if (!parsed.success) throw new Error("The agent returned an invalid chat message.");
            setMessages((current) => current.map((message) => message.id === agentId ? parsed.data : message));
          } else if (event.type === "error" && "message" in event && typeof event.message === "string") {
            throw new Error(event.message);
          }
        }
        if (done) break;
      }
      setThread((current) => current ? { ...current, title: current.title === "New conversation" ? request.slice(0, 60) : current.title } : current);
      if (voiceMode.current === "response" && voiceEnabledRef.current) {
        setVoiceStatus("Brewly is replying.");
        speak(responseText || "I couldn't prepare a spoken reply.", () => {
          if (voiceEnabledRef.current) {
            voiceMode.current = "wake";
            setVoiceStatus("Listening for “Brewly”.");
            startVoiceRecognition();
          }
        });
      }
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "The agent could not complete this message.");
      setMessages((current) => current.filter((message) => message.id !== agentId));
      if (voiceMode.current === "response" && voiceEnabledRef.current) {
        voiceMode.current = "wake";
        setVoiceStatus("Listening for “Brewly”.");
        startVoiceRecognition();
      }
    } finally {
      setSending(false);
      setTool("");
    }
  }

  submitMessageRef.current = submitMessage;

  function sendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitMessage(input);
  }

  async function decide(item: ApprovalItem, decision: "approved" | "rejected") {
    setActionBusy(`${item.id}:${decision}`);
    setError("");
    try {
      const response = await fetch("/api/agent/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "decide",
          id: item.id,
          decision,
          reviewerNote: "Decision made in the agent chat.",
        }),
      });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(result) ?? "The decision could not be saved.");
      setMessages((current) => current.map((message) => ({
        ...message,
        parts: message.parts.map((part) => part.type === "approval_card" && part.item.id === item.id
          ? {
            ...part,
            item: {
              ...part.item,
              status: decision,
              reviewedAt: new Date().toISOString(),
              reviewerNote: "Decision made in the agent chat.",
            },
          }
          : part          ),
      })));
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "The decision could not be saved.");
    } finally {
      setActionBusy("");
    }
  }

  function renderPart(message: DisplayMessage, part: AgentMessagePart, index: number) {
    if (part.type === "text") {
      return part.text
        ? <p className={styles.messageText} key={`${message.id}-${index}`}>{part.text}</p>
        : null;
    }
    if (part.type === "approval_card") {
      return (
        <section className={styles.inlineCard} key={`${message.id}-${index}`}>
          <p className={styles.cardEyebrow}>
            {part.item.status === "pending_approval" ? "Needs your approval" : "Approval history"}
          </p>
          <h3>{part.item.summary}</h3>
          <p>{part.item.action.replaceAll("_", " ")}</p>
          {part.item.status === "pending_approval" ? (
            <div className={styles.cardActions}>
                <LoadingButton type="button" busy={actionBusy === `${part.item.id}:approved`} disabled={actionBusy.startsWith(`${part.item.id}:`) && actionBusy !== `${part.item.id}:approved`} busyLabel="Approving..." onClick={() => void decide(part.item, "approved")}>
                  Approve
                </LoadingButton>
                <LoadingButton type="button" className={styles.reject} busy={actionBusy === `${part.item.id}:rejected`} disabled={actionBusy.startsWith(`${part.item.id}:`) && actionBusy !== `${part.item.id}:rejected`} busyLabel="Rejecting..." onClick={() => void decide(part.item, "rejected")}>
                  Reject
                </LoadingButton>
              <Link href="/?review=1">Edit</Link>
            </div>
          ) : <p className={styles.cardStatus}>Decision recorded: {part.item.status}.</p>}
        </section>
      );
    }
    if (part.type === "draft_order") {
      return (
        <section className={styles.inlineCard} key={`${message.id}-${index}`}>
          <p className={styles.cardEyebrow}>Draft order · {part.draft.forecastDate}</p>
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>Ingredient</th><th>Draft quantity</th><th>Supplier</th></tr></thead>
              <tbody>{part.draft.lines.map((line) => (
                <tr key={line.ingredientId}>
                  <td>{line.ingredient}</td>
                  <td>{line.recommendedOrderQuantity} {line.unit}</td>
                  <td>{line.recommendedSupplier.supplier}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className={styles.cardStatus}>This is a draft only; nothing was ordered or sent.</p>
        </section>
      );
    }
    return (
      <section className={styles.inlineCard} key={`${message.id}-${index}`}>
        <p className={styles.cardEyebrow}>Stock</p>
        <div className={styles.tableWrap}>
          <table>
            <thead><tr><th>Ingredient</th><th>Quantity</th><th>Status</th></tr></thead>
            <tbody>{part.items.map((item) => (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td>{item.quantity === null ? "Unknown" : `${item.quantity} ${item.unit}`}</td>
                <td>{item.status}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
    );
  }

  return (
    <>
      <section
        id="agent-chat-panel"
        className={`${styles.panel}${open ? ` ${styles.panelOpen}` : ""}`}
        aria-label="Brewlytics agent chat"
        aria-hidden={!open}
        inert={!open}
      >
          <header className={styles.header}>
            <div>
              <p className={styles.brand}>BREWLYTICS</p>
              <h2>Ask your agent</h2>
            </div>
            <div className={styles.headerActions}>
              <button type="button" aria-pressed={voiceEnabled} onClick={toggleVoice}>
                {voiceEnabled ? "Turn voice off" : "Enable voice"}
              </button>
              <LoadingButton type="button" busy={creatingConversation} busyLabel="Starting..." disabled={sending} onClick={() => void newConversation()}>
                New conversation
              </LoadingButton>
              <button type="button" className={styles.close} aria-label="Collapse chat" onClick={() => setOpen(false)}>×</button>
            </div>
          </header>
          <p className={styles.voiceStatus} role="status" aria-live="polite">{voiceStatus}</p>
          <div className={styles.messages} aria-live="polite" aria-busy={sending || loadingHistory}>
            {loadingHistory
              ? <div className={styles.historyLoading} role="status">
                <span className="sr-only">Loading your conversation...</span>
                <Skeleton className="skeleton-row" />
                <Skeleton className="skeleton-row" />
              </div>
              : messages.length === 0
                ? <p className={styles.muted}>Ask about stock, recipes, deliveries, or what to prepare next.</p>
                : messages.map((message) => (
                  <article className={message.role === "owner" ? styles.ownerMessage : styles.agentMessage} key={message.id}>
                    <p className={styles.speaker}>{message.role === "owner" ? "You" : "Brewlytics"}</p>
                    {message.parts.map((part, index) => renderPart(message, part, index))}
                  </article>
                ))}
            {sending && <p className={`inline-status ${styles.working}`} role="status" aria-live="polite">
              <span className="typing-dots" aria-hidden="true"><span /><span /><span /></span>
              {tool ? `${tool}...` : "Thinking through your request..."}
            </p>}
            <div ref={messagesEnd} />
          </div>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <form className={styles.composer} onSubmit={sendMessage}>
            <label className="sr-only" htmlFor="agent-dock-message">Message Brewlytics</label>
            <textarea
              id="agent-dock-message"
              maxLength={1000}
              rows={2}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="What should I know?"
              disabled={sending || creatingConversation || loadingHistory || !thread}
            />
            <LoadingButton className="primary-button" type="submit" busy={sending} busyLabel="Working..." disabled={creatingConversation || loadingHistory || !thread || !input.trim()}>
              Send
            </LoadingButton>
          </form>
      </section>
      {!open && (
        <button
          type="button"
          className={styles.launcher}
          aria-expanded={open}
          aria-controls="agent-chat-panel"
          aria-label="Open Brewlytics chat"
          onClick={() => setOpen(true)}
        >
          <span aria-hidden="true">B</span>
          {hasOwnerAction && <span className={styles.badge} aria-label="The agent has something for you" />}
        </button>
      )}
    </>
  );
}
