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

### With LangSmith

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.smith.langchain.com/otel"
export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=${LANGCHAIN_API_KEY}"
export OTEL_SERVICE_NAME="opencode"
export OTEL_RESOURCE_ATTRIBUTES="session.id=my-session-$(date +%s)"

# Run from source (recommended - built binary has bundling issues)
cd packages/opencode
bun run src/bootstrap.ts run "Your prompt here"
```

### With Other OTLP Backends

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
export OTEL_SERVICE_NAME="opencode"

bun run src/bootstrap.ts run "Your prompt here"
```

## Key Features

- **AI Tab**: Properly populates inputs/outputs in LangSmith
- **TOOLS Tab**: Shows tool definitions and calls
- **Thread Grouping**: Groups traces by session via `langsmith.thread.id`
- **Content Parsing**: Handles `[{type:"text", text:"..."}]` arrays
- **JSON Pretty-Printing**: Configurable via `OTEL_PRETTY_OUTPUT`
- **Debug Mode**: Set `OTEL_DEBUG_ATTRS=true` to log attributes

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint (required) | - |
| `OTEL_EXPORTER_OTLP_HEADERS` | Auth headers | - |
| `OTEL_SERVICE_NAME` | Service name | `opencode` |
| `OTEL_RESOURCE_ATTRIBUTES` | Resource attrs | - |
| `OTEL_LOG_LEVEL` | Logging level | - |
| `OTEL_PRETTY_OUTPUT` | Pretty JSON | `true` |
| `OTEL_DEBUG_ATTRS` | Debug logging | `false` |

## Architecture

```
index.ts
    └── bootstrap.ts (init tracing FIRST)
            ├── tracing/index.ts (OTEL + LangSmith transformer)
            └── cli.ts (root span wrapper)
                    └── llm.ts (AI SDK telemetry)
```

## Known Issues

- Built binary has OTEL constructor bundling issues - use `bun run src/bootstrap.ts` directly
- Some LangSmith TOOLS tab fields may still be empty - attribute mapping ongoing

## Credits

- Original [OpenCode](https://github.com/sst/opencode) by SST
- OTEL integration by [@aanestesia](https://github.com/aanestesia)
