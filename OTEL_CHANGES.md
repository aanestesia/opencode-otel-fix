# OpenCode OTEL Fix - LangSmith Integration

This fork adds **OpenTelemetry tracing** support to OpenCode with proper **LangSmith** integration.

## Why This Fork?

OpenCode uses the Vercel AI SDK which has built-in telemetry, but:

1. **Attribute Mismatch**: AI SDK uses `ai.*` namespace, LangSmith expects `gen_ai.*` (OpenLLMetry format)
2. **Empty Data**: LangSmith's AI and TOOLS tabs showed "No data"
3. **Fragmented Traces**: Without a root span, traces were scattered
4. **Init Order**: OTEL must init BEFORE AI SDK imports to capture all spans

## Changes Made

### New Files

| File | Purpose |
|------|---------|
| `packages/opencode/src/tracing/index.ts` | OTEL module with LangSmith attribute transformer |
| `packages/opencode/src/tracing/README.md` | Detailed documentation |
| `packages/opencode/src/bootstrap.ts` | Entry point ensuring tracing init first |
| `packages/opencode/src/cli.ts` | CLI logic extracted with root span wrapper |

### Modified Files

| File | Change |
|------|--------|
| `packages/opencode/src/index.ts` | Now imports bootstrap |
| `packages/opencode/src/session/llm.ts` | Enhanced telemetry config with `recordInputs`/`recordOutputs` |
| `packages/opencode/package.json` | Added OTEL dependencies |

### Dependencies Added

```json
"@opentelemetry/api": "1.9.0",
"@opentelemetry/exporter-trace-otlp-http": "0.57.0",
"@opentelemetry/resources": "1.30.0",
"@opentelemetry/sdk-trace-base": "1.30.0",
"@opentelemetry/sdk-trace-node": "1.30.0",
"@opentelemetry/semantic-conventions": "1.28.0"
```

## Quick Start

### With LangSmith (Collector-First, Recommended)

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="http://localhost:4318/v1/traces"
export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=${LANGSMITH_API_KEY},Langsmith-Project=arrow-orchestrator-dev"
export OTEL_SERVICE_NAME="opencode"
export OTEL_RESOURCE_ATTRIBUTES="service.name=opencode"

# Run from the built binary
OPENCODE_BIN=/path/to/opencode
$OPENCODE_BIN run "Your prompt here"
```

### With Other OTLP Backends

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="http://localhost:4318/v1/traces"
export OTEL_SERVICE_NAME="opencode"

bun run src/bootstrap.ts run "Your prompt here"
```

## Key Features

- **AI Tab**: Properly populates inputs/outputs in LangSmith
- **TOOLS Tab**: Shows tool definitions and calls
- **Thread Grouping**: Groups traces by session via `langsmith.trace.session_id`
- **Content Parsing**: Handles `[{type:"text", text:"..."}]` arrays

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | OTLP traces endpoint (required) | - |
| `OTEL_EXPORTER_OTLP_HEADERS` | Auth headers | - |
| `OTEL_SERVICE_NAME` | Service name | `opencode` |
| `OTEL_RESOURCE_ATTRIBUTES` | Resource attrs | - |
| `OTEL_LOG_LEVEL` | Logging level | - |

## Architecture

```
index.ts
    └── bootstrap.ts (init tracing FIRST)
            ├── tracing/index.ts (OTEL + LangSmith transformer)
            └── cli.ts (root span wrapper)
                    └── llm.ts (AI SDK telemetry)
```

## Known Issues

- Direct OpenCode → LangSmith export (JSON OTLP) is less reliable than collector-first.
  Use the local OTEL collector and protobuf export for stability.
- Some LangSmith TOOLS tab fields may still be empty - attribute mapping ongoing

## Credits

- Original [OpenCode](https://github.com/sst/opencode) by SST
- OTEL integration by [@aanestesia](https://github.com/aanestesia)
