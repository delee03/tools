#!/usr/bin/env node

import { appendFileSync } from "node:fs";

import { Client, IMessage } from "@stomp/stompjs";
import chalk from "chalk";
import { program } from "commander";
import { serializeError } from "serialize-error";
import { v7 as UUIDv7 } from "uuid";
import WebSocket from "ws";
import { z } from "zod";

Object.assign(globalThis, { WebSocket });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
const eventSchema = z.object({
  type: z.string(),
  delta: z.string().optional(),
  toolCallName: z.string().optional(),
  content: z.string().optional(),
  error: z.string().optional(),
});

const payloadSchema = z.object({
  events: z.array(z.unknown()).optional(),
  conversationId: z.string().optional(),
});

const messageSchema = z.object({
  additionalData: payloadSchema.optional(),
});

type Payload = z.infer<typeof payloadSchema>;

// ---------------------------------------------------------------------------
// Env schema & config
// ---------------------------------------------------------------------------
const headers = () =>
  z
    .string()
    .optional()
    .transform((raw) => {
      if (!raw) return {};
      const result: Record<string, string> = {};
      for (const pair of raw.split(",")) {
        const idx = pair.indexOf(":");
        if (idx > 0)
          result[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }
      return result;
    });

const envSchema = z.object({
  AGENT_URL: z.string().url(),
  AGENT_ID: z.string().default("orchestratorAgent"),
  WS_URL: z.string().startsWith("wss://").or(z.string().startsWith("ws://")),
  WS_TOPIC: z.string().startsWith("/"),
  IDLE_TIMEOUT: z.coerce.number().int().positive().default(120_000),
  AGENT_HEADERS: headers(),
  WS_STOMP_HEADERS: headers(),
  WS_HEADERS: headers(),
});

type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    for (const issue of result.error.issues) {
      console.error(chalk.red(`${issue.path.join(".")}: ${issue.message}`));
    }
    process.exit(1);
  }
  return result.data;
}

interface Config extends Env {
  threadId: string;
  logFile: string;
}

// ---------------------------------------------------------------------------
// JSONL log
// ---------------------------------------------------------------------------
function appendEvent(logFile: string, event: unknown): void {
  appendFileSync(logFile, JSON.stringify(event) + "\n");
}

// ---------------------------------------------------------------------------
// STOMP connection
// ---------------------------------------------------------------------------
function connectStomp(
  config: Config,
  onEvent: (messageBytes: number, payload: Payload) => void,
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client({
      webSocketFactory: () => {
        const hasWsHeaders = Object.keys(config.WS_HEADERS).length > 0;
        return new WebSocket(
          config.WS_URL,
          hasWsHeaders ? { headers: config.WS_HEADERS } : undefined,
        ) as unknown as globalThis.WebSocket;
      },
      connectHeaders: config.WS_STOMP_HEADERS,
      reconnectDelay: 0,
      debug: () => {},
    });

    client.onConnect = () => {
      client.subscribe(
        config.WS_TOPIC,
        (message: IMessage) => {
          const parsed = messageSchema.safeParse(JSON.parse(message.body));
          if (parsed.success && parsed.data.additionalData) {
            onEvent(message.body.length, parsed.data.additionalData);
          }
        },
        config.WS_STOMP_HEADERS,
      );
      resolve(client);
    };

    client.onStompError = (frame) => {
      reject(new Error(`STOMP error: ${frame.headers.message ?? "unknown"}`));
    };

    client.onWebSocketError = (event) => {
      const detail =
        event instanceof Error
          ? event.message
          : typeof event === "object" && event !== null && "message" in event
            ? String((event as { message: unknown }).message)
            : JSON.stringify(event);
      reject(new Error(`WebSocket error: ${detail}`));
    };

    client.activate();
  });
}

// ---------------------------------------------------------------------------
// HTTP send
// ---------------------------------------------------------------------------
async function sendMessage(config: Config, message: string): Promise<void> {
  const url = `${config.AGENT_URL}/${config.AGENT_ID}/run`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...config.AGENT_HEADERS,
    },
    body: JSON.stringify({
      threadId: config.threadId,
      runId: UUIDv7(),
      messages: [{ id: Date.now().toString(), role: "user", content: message }],
      tools: [],
      context: [],
      forwardedProps: {},
      state: {},
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Event processing
// ---------------------------------------------------------------------------
let processedEventCount = 0;
let startTime = 0;
let firstTextTime = 0;
let firstToolTime = 0;
let conversationBytes = 0;
let newBytes = 0;
let lastEventTime = 0;
const idlePeriods: { startMs: number; durationMs: number }[] = [];

function handleEvents(
  messageBytes: number,
  payload: Payload,
  config: Config,
): "running" | "finished" | "error" {
  if (payload.conversationId && payload.conversationId !== config.threadId) {
    return "running";
  }

  conversationBytes += messageBytes;

  const events = payload.events;
  if (!events || events.length === 0) {
    return "running";
  }

  const newEvents = events.slice(processedEventCount);
  processedEventCount = events.length;
  for (const e of newEvents) newBytes += JSON.stringify(e).length;

  let status: "running" | "finished" | "error" = "running";

  for (const raw of newEvents) {
    // Log the raw event before parsing
    appendEvent(config.logFile, raw);

    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) continue;
    const event = parsed.data;

    switch (event.type) {
      case "TEXT_MESSAGE_CONTENT":
        if (event.delta) {
          if (!firstTextTime) firstTextTime = performance.now();
          process.stdout.write(event.delta);
        }
        break;
      case "TOOL_CALL_START":
        if (!firstToolTime) firstToolTime = performance.now();
        if (event.toolCallName)
          process.stdout.write(chalk.dim(`\n[tool: ${event.toolCallName}] `));
        break;
      case "TOOL_CALL_RESULT":
        if (event.content) {
          const preview =
            event.content.length > 200
              ? event.content.slice(0, 200) + "..."
              : event.content;
          process.stdout.write(chalk.dim(`→ ${preview}\n`));
        }
        break;
      case "RUN_FINISHED":
        status = "finished";
        break;
      case "RUN_ERROR":
        if (event.error)
          process.stderr.write(chalk.red(`\nError: ${event.error}\n`));
        status = "error";
        break;
    }
  }

  return status;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
program
  .name("ag-ui-wss")
  .description(
    "Send a message to an AG-UI agent and stream the response via STOMP/WebSocket",
  )
  .argument("<message>", "Message to send")
  .option("-t, --thread <id>", "Thread/conversation ID (default: new UUID)")
  .action(async (message: string, opts: { thread?: string }) => {
    const env = loadEnv();
    const threadId = opts.thread ?? UUIDv7();
    const config: Config = {
      ...env,
      threadId,
      logFile: `${threadId}.jsonl`,
    };

    console.error(chalk.blue(`Thread: ${config.threadId}`));
    console.error(chalk.dim("Connecting..."));

    appendEvent(config.logFile, {
      type: "USER_MESSAGE",
      timestamp: Date.now(),
      content: message,
    });

    let stompClient: Client | undefined;

    try {
      processedEventCount = 0;

      const done = new Promise<void>((resolve, reject) => {
        const idleThreshold = config.IDLE_TIMEOUT * 0.25;
        const onIdle = () =>
          reject(
            new Error(
              `No events for ${config.IDLE_TIMEOUT / 1000}s, idle timeout`,
            ),
          );
        let idleTimer = setTimeout(onIdle, config.IDLE_TIMEOUT);
        const resetIdle = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(onIdle, config.IDLE_TIMEOUT);
          const now = performance.now();
          if (lastEventTime > 0) {
            const gap = now - lastEventTime;
            if (gap >= idleThreshold) {
              idlePeriods.push({
                startMs: lastEventTime - startTime,
                durationMs: gap,
              });
            }
          }
          lastEventTime = now;
        };

        connectStomp(config, (messageBytes, payload) => {
          resetIdle();
          const status = handleEvents(messageBytes, payload, config);
          if (status === "finished") {
            clearTimeout(idleTimer);
            process.stdout.write("\n");
            resolve();
          } else if (status === "error") {
            clearTimeout(idleTimer);
            reject(new Error("Agent run failed"));
          }
        })
          .then((client) => {
            stompClient = client;
            console.error(chalk.dim("Sending..."));
            console.error();
            startTime = performance.now();
            sendMessage(config, message).catch(reject);
          })
          .catch(reject);
      });

      await done;

      const totalMs = performance.now() - startTime;
      const ttfTextMs = firstTextTime ? firstTextTime - startTime : null;
      const ttfToolMs = firstToolTime ? firstToolTime - startTime : null;
      const fmt = (ms: number) =>
        ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
      const fmtKB = (b: number) => `${(b / 1024).toFixed(1)}KB`;
      const pct = (a: number, b: number) =>
        b > 0 ? `${((a / b) * 100).toFixed(0)}%` : "N/A";
      console.error(
        chalk.dim(
          [
            ttfToolMs != null ? `TTF-Tool: ${fmt(ttfToolMs)}` : null,
            ttfTextMs != null ? `TTF-Text: ${fmt(ttfTextMs)}` : null,
            `Total: ${fmt(totalMs)}`,
            conversationBytes > 0
              ? `Protocol efficiency: ${fmtKB(newBytes)}/${fmtKB(conversationBytes)} (${pct(newBytes, conversationBytes)})`
              : null,
          ]
            .filter(Boolean)
            .join("  |  "),
        ),
      );

      if (idlePeriods.length > 0) {
        console.error(
          chalk.yellow(
            `\nWarning: ${idlePeriods.length} idle period(s) exceeded ${fmt(config.IDLE_TIMEOUT * 0.25)} (25% of idle timeout):`,
          ),
        );
        for (const p of idlePeriods) {
          console.error(
            chalk.yellow(`  at ${fmt(p.startMs)}: silent for ${fmt(p.durationMs)}`),
          );
        }
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : JSON.stringify(serializeError(err));
      console.error(chalk.red(`\nError: ${message}`));
      process.exit(1);
    } finally {
      if (stompClient?.connected) void stompClient.deactivate();
    }
  });

program.parse();
