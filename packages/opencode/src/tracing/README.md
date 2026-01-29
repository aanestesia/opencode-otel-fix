# OpenCode OpenTelemetry Tracing Module

This module adds OpenTelemetry (OTEL) tracing support to OpenCode, enabling integration with observability platforms like **LangSmith**, **Langfuse**, and other OTLP-compatible backends.

## The Problem

The Vercel AI SDK has built-in telemetry support via `experimental_telemetry`, but:

1. **Attribute Namespace Mismatch**: AI SDK uses `ai.*` attributes, but LangSmith/OpenLLMetry expects `gen_ai.*` attributes
2. **Missing Input/Output Data**: LangSmith's AI and TOOLS tabs showed "No data" because the attribute names didn't match
3. **Scattered Traces**: Without a root span, traces appeared fragmented in the UI
4. **Initialization Order**: OTEL must be initialized BEFORE any AI SDK imports to capture all spans

## The Solution

### 1. Bootstrap Entry Point (`bootstrap.ts`)

Ensures tracing is initialized before any other imports:

```typescript
// Initialize tracing FIRST - before any other imports
import { initTracing, shutdownTracing } from "./tracing"

initTracing({ serviceName: "opencode" })

// Now dynamically import the main CLI
import("./cli")
```

### 2. LangSmith Attribute Processor (`tracing/index.ts`)

A custom `SpanProcessor` that transforms AI SDK attributes to LangSmith format:

| AI SDK Attribute | LangSmith Attribute |
|-----------------|---------------------|
| `ai.prompt.messages` | `gen_ai.prompt` |
| `ai.response.text` | `gen_ai.completion` |
| `ai.model.id` | `gen_ai.request.model` |
| `ai.model.provider` | `gen_ai.system` |
| `ai.usage.promptTokens` | `gen_ai.usage.prompt_tokens` |
| `ai.usage.completionTokens` | `gen_ai.usage.completion_tokens` |
| `ai.toolCall.name` | `gen_ai.tool.name` |
| `ai.toolCall.args` | `tool_arguments` |
| `ai.prompt.tools` | `tools` |

### 3. Enhanced Telemetry Config (`llm.ts`)

Enables full input/output recording:

```typescript
experimental_telemetry: {
  isEnabled: cfg.experimental?.openTelemetry,
  recordInputs: true,
  recordOutputs: true,
  functionId: `opencode.${input.agent.name}`,
  metadata: {
    sessionId: input.sessionID,
    agentName: input.agent.name,
    modelId: input.model.id,
    providerId: input.model.providerID,
  },
}
```

### 4. Root Span Wrapper (`cli.ts`)

Groups all AI SDK spans under a single parent:

```typescript
const rootSpan = tracer.startSpan("opencode.run", {
  attributes: {
    "opencode.agent": agentName,
    "opencode.args": process.argv.slice(2).join(" "),
    "langsmith.metadata.session_id": sessionId,
  },
})
```

## Configuration

Tracing is **opt-in** via environment variables:

| Variable | Description |
|----------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint URL (required to enable tracing) |
| `OTEL_EXPORTER_OTLP_HEADERS` | Headers (e.g., `x-api-key=...`) |
| `OTEL_SERVICE_NAME` | Service name (default: "opencode") |
| `OTEL_RESOURCE_ATTRIBUTES` | Resource attributes (e.g., `session.id=xxx`) |
| `OTEL_LOG_LEVEL` | Diagnostic logging: `debug`, `info`, `warn`, `error` |

## Usage with LangSmith

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.smith.langchain.com/otel"
export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=${LANGCHAIN_API_KEY}"
export OTEL_SERVICE_NAME="my-opencode-app"
export OTEL_RESOURCE_ATTRIBUTES="session.id=my-session-123"

opencode run "Your prompt here"
```

## Features

- **AI Tab Population**: Inputs/outputs properly displayed in LangSmith
- **TOOLS Tab Population**: Tool definitions and calls visible
- **Thread Grouping**: Uses `langsmith.metadata.session_id` + `gen_ai.conversation.id`
- **Content Parsing**: Handles `[{type:"text", text:"..."}]` content arrays
- **Graceful Shutdown**: Ensures spans are flushed before exit

## Dependencies Added

```json
{
  "@opentelemetry/api": "1.9.0",
  "@opentelemetry/exporter-trace-otlp-http": "0.57.0",
  "@opentelemetry/resources": "1.30.0",
  "@opentelemetry/sdk-trace-base": "1.30.0",
  "@opentelemetry/sdk-trace-node": "1.30.0",
  "@opentelemetry/semantic-conventions": "1.28.0"
}
```

## Files Modified/Added

| File | Change |
|------|--------|
| `src/tracing/index.ts` | **NEW** - OTEL module with LangSmith attribute transformer |
| `src/bootstrap.ts` | **NEW** - Entry point ensuring tracing init before imports |
| `src/cli.ts` | **NEW** - CLI logic with root span wrapper |
| `src/index.ts` | **MODIFIED** - Now imports bootstrap |
| `src/session/llm.ts` | **MODIFIED** - Enhanced telemetry config |
| `package.json` | **MODIFIED** - Added OTEL dependencies |

## Architecture

```
index.ts
    └── bootstrap.ts (initializes tracing FIRST)
            ├── tracing/index.ts (OTEL setup + LangSmith transformer)
            └── cli.ts (CLI logic with root span)
                    └── session/llm.ts (AI SDK with telemetry enabled)
```

## Known Limitations

- The built binary has bundling issues with OTEL constructors (use `bun run src/bootstrap.ts` for now)
- Some LangSmith fields (AI, TOOLS tabs) may still show empty for certain span types - investigation ongoing
