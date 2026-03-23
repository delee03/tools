# ag-ui-wss

[![npm](https://img.shields.io/npm/v/ag-ui-wss)](https://www.npmjs.com/package/ag-ui-wss)

CLI client for [AG-UI](https://docs.ag-ui.com) agents over STOMP/WebSocket. Sends a message to an agent via HTTP, then streams the response in real-time through a STOMP/WebSocket connection.

## Install

```bash
npm install -g ag-ui-wss
```

Or run directly with npx:

```bash
npx ag-ui-wss "Hello"
```

## Usage

```
ag-ui-wss [options] <message>

Options:
  -t, --thread <id>  Thread/conversation ID (default: new UUID)
  -h, --help         Display help
```

### Environment variables

| Variable           | Required | Description                                                     |
| ------------------ | -------- | --------------------------------------------------------------- |
| `AGENT_URL`        | Yes      | Base URL of the agent API                                       |
| `AGENT_ID`         | No       | Agent identifier (default: `orchestratorAgent`)                 |
| `WS_URL`           | Yes      | WebSocket URL (`wss://` or `ws://`)                             |
| `WS_TOPIC`         | Yes      | STOMP topic to subscribe to (must start with `/`)               |
| `IDLE_TIMEOUT`     | No       | Max ms without events before timeout (default: `30000`)         |
| `AGENT_HEADERS`    | No       | Extra HTTP headers for agent requests (`Key:Value,Key2:Value2`) |
| `WS_STOMP_HEADERS` | No       | STOMP connection/subscribe headers                              |
| `WS_HEADERS`       | No       | WebSocket connection headers                                    |

### Example

```bash
export AGENT_URL="https://example.com/agent"
export WS_URL="wss://example.com/ws"
export WS_TOPIC="/topic/user.abc123"

ag-ui-wss "Summarize the latest updates"
```

Continue a conversation by passing the thread ID:

```bash
ag-ui-wss --thread <thread-id> "Follow up question"
```

## How it works

1. Connects to the STOMP/WebSocket endpoint and subscribes to the configured topic
2. Sends the user message to the agent via HTTP POST
3. Streams AG-UI events from the WebSocket and prints them to stdout
4. Logs all raw events to a `<thread-id>.jsonl` file for debugging
