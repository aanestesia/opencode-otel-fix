/**
 * OpenTelemetry Tracing Module
 *
 * This module initializes OpenTelemetry tracing for OpenCode.
 * It MUST be initialized before any other imports that might create spans
 * (e.g., the AI SDK).
 *
 * Tracing is opt-in via environment variables:
 * - OTEL_EXPORTER_OTLP_ENDPOINT: The OTLP endpoint URL
 * - OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: Alternative traces-specific endpoint
 * - OTEL_SERVICE_NAME: Service name (defaults to "opencode")
 * - OTEL_EXPORTER_OTLP_HEADERS: Headers for the exporter (e.g., "x-api-key=...")
 * - OTEL_EXPORTER_OTLP_PROTOCOL: Protocol (defaults to "http/protobuf")
 * - OTEL_LOG_LEVEL: Set to "debug" for diagnostic logging
 * - OTEL_PRETTY_OUTPUT: Pretty-print JSON outputs (default: "true", set to "false" for minified)
 * - OTEL_DEBUG_ATTRS: Set to "true" to log span attributes to stderr for debugging
 */

import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  trace,
  propagation,
  context as otelContext,
  type Context,
} from "@opentelemetry/api"
// NOTE: We use a custom fetch-based exporter instead of OTLPTraceExporter
// because the Node.js http-based exporter doesn't work in Bun subprocess environments
// import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { FetchOTLPTraceExporter } from "./fetch-exporter"
import { Resource } from "@opentelemetry/resources"
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanProcessor,
  type ReadableSpan,
  type Span,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"

/**
 * Attribute mapping from Vercel AI SDK format to LangSmith/OpenLLMetry format.
 * LangSmith expects gen_ai.* attributes, but AI SDK uses ai.* attributes.
 */
const AI_SDK_TO_LANGSMITH_ATTRS: Record<string, string> = {
  // Input/Output mappings
  "ai.prompt.messages": "gen_ai.prompt",
  "ai.response.text": "gen_ai.completion",

  // Model info
  "ai.model.id": "gen_ai.request.model",
  "ai.model.provider": "gen_ai.system",

  // Token usage
  "ai.usage.promptTokens": "gen_ai.usage.prompt_tokens",
  "ai.usage.completionTokens": "gen_ai.usage.completion_tokens",

  // Settings
  "ai.settings.maxTokens": "gen_ai.request.max_tokens",
  "ai.settings.temperature": "gen_ai.request.temperature",
  "ai.settings.topP": "gen_ai.request.top_p",
  "ai.settings.topK": "gen_ai.request.top_k",
  "ai.settings.frequencyPenalty": "gen_ai.request.frequency_penalty",
  "ai.settings.presencePenalty": "gen_ai.request.presence_penalty",

  // Finish reason
  "ai.response.finishReason": "gen_ai.response.finish_reasons",

  // Tool call attributes (for ai.toolCall spans)
  "ai.toolCall.name": "gen_ai.tool.name",
  "ai.toolCall.args": "tool_arguments",
  "ai.toolCall.id": "tool_call_id",
  "ai.toolCall.result": "tool_result",

  // Tool definitions (for LLM spans)
  "ai.prompt.tools": "tools",
  "ai.prompt.toolChoice": "tool_choice",
}

/**
 * SpanProcessor that transforms Vercel AI SDK attributes to LangSmith-compatible format.
 * This wraps another processor and transforms attributes before forwarding.
 */
class LangSmithAttributeProcessor implements SpanProcessor {
  constructor(private readonly delegate: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    this.delegate.onStart(span, parentContext)
  }

  onEnd(span: ReadableSpan): void {
    // Transform AI SDK attributes to LangSmith format
    const transformedSpan = this.transformAttributes(span)
    this.delegate.onEnd(transformedSpan)
  }

  async shutdown(): Promise<void> {
    return this.delegate.shutdown()
  }

  async forceFlush(): Promise<void> {
    return this.delegate.forceFlush()
  }

  private transformAttributes(span: ReadableSpan): ReadableSpan {
    const originalAttrs = span.attributes
    const newAttrs: Record<string, any> = { ...originalAttrs }

    // Debug: Log all AI SDK attributes for investigation
    if (process.env.OTEL_DEBUG_ATTRS === "true" && span.name.startsWith("ai.")) {
      const aiAttrs = Object.entries(originalAttrs)
        .filter(([k]) => k.startsWith("ai.") || k.startsWith("gen_ai."))
        .map(([k, v]) => `${k}=${typeof v === "string" && v.length > 100 ? v.slice(0, 100) + "..." : v}`)
      console.error(`[OTEL DEBUG] Span: ${span.name}`)
      console.error(`[OTEL DEBUG] AI Attributes: ${aiAttrs.length > 0 ? aiAttrs.join(", ") : "NONE"}`)
      console.error(`[OTEL DEBUG] All keys: ${Object.keys(originalAttrs).join(", ")}`)
    }

    // Map AI SDK attributes to LangSmith format
    for (const [aiKey, langsmithKey] of Object.entries(AI_SDK_TO_LANGSMITH_ATTRS)) {
      if (originalAttrs[aiKey] !== undefined) {
        newAttrs[langsmithKey] = originalAttrs[aiKey]
      }
    }

    // Also add input.value/output.value for broader compatibility
    // Try multiple possible attribute names for inputs
    const inputValue =
      originalAttrs["ai.prompt.messages"] ||
      originalAttrs["ai.prompt"] ||
      originalAttrs["ai.request.messages"]
    if (inputValue) {
      newAttrs["input.value"] = inputValue
      newAttrs["gen_ai.prompt"] = inputValue

      // Parse messages and emit individual attributes for LangSmith compatibility
      try {
        const parsed = typeof inputValue === "string" ? JSON.parse(inputValue) : inputValue
        const messages = Array.isArray(parsed) ? parsed : parsed?.messages
        if (Array.isArray(messages)) {
          messages.forEach((msg: { role?: string; content?: string | Array<{ type: string; text?: string }> }, i: number) => {
            if (msg.role) newAttrs[`gen_ai.prompt.${i}.role`] = msg.role
            if (msg.content) {
              // Handle content that can be string or array of content parts
              let content: string
              if (typeof msg.content === "string") {
                content = msg.content
              } else if (Array.isArray(msg.content)) {
                // Extract text from content parts array: [{type:"text", text:"..."}, ...]
                content = msg.content
                  .filter((part) => part.type === "text" && part.text)
                  .map((part) => part.text)
                  .join("\n")
              } else {
                content = JSON.stringify(msg.content)
              }
              // Truncate very long content to avoid OTEL limits
              newAttrs[`gen_ai.prompt.${i}.content`] = content.length > 10000 ? content.slice(0, 10000) + "..." : content
            }
          })
        }
      } catch {
        // If parsing fails, keep the raw value
      }
    }

    // Try multiple possible attribute names for outputs
    const outputValue =
      originalAttrs["ai.response.text"] ||
      originalAttrs["ai.response"] ||
      originalAttrs["ai.result.text"]

    // Check for finish reason - useful for debugging empty responses
    const finishReason = originalAttrs["ai.response.finishReason"]
    if (finishReason) {
      newAttrs["gen_ai.response.finish_reasons"] = Array.isArray(finishReason)
        ? finishReason
        : [finishReason]
    }

    if (outputValue) {
      // Pretty-print JSON outputs for readability (configurable via OTEL_PRETTY_OUTPUT)
      // Default: true (pretty), set to "false" for minified
      const prettyOutput = process.env.OTEL_PRETTY_OUTPUT !== "false"
      let formattedOutput = outputValue
      if (typeof outputValue === "string" && prettyOutput) {
        try {
          const parsed = JSON.parse(outputValue)
          formattedOutput = JSON.stringify(parsed, null, 2)
        } catch {
          // Not JSON, keep as-is
        }
      }
      newAttrs["output.value"] = formattedOutput
      newAttrs["gen_ai.completion"] = formattedOutput
      // Also emit as completion.0 for LangSmith
      newAttrs["gen_ai.completion.0.role"] = "assistant"
      newAttrs["gen_ai.completion.0.content"] = formattedOutput
    } else if (span.name.startsWith("ai.") && span.name !== "ai.toolCall") {
      // For LLM spans without output, check if there were tool calls in the response
      // Tool-only responses (no text output) are valid - the model chose to call tools instead
      const toolCallsValue = originalAttrs["ai.response.toolCalls"]
      if (toolCallsValue) {
        // Model responded with tool calls - this is a valid response, not an error
        newAttrs["output.value"] = "[Model responded with tool calls]"
        newAttrs["gen_ai.completion.0.role"] = "assistant"
        newAttrs["gen_ai.completion.0.content"] = "[Tool calls - see tool_calls attributes]"
      } else if (finishReason) {
        // No output and no tool calls - indicate why based on finish reason
        newAttrs["output.value"] = `[No text output - finish_reason: ${finishReason}]`
      }
      // If no output, no tool calls, and no finish reason, leave output.value unset
      // This indicates the span ended without capturing any response data
    }

    // Set span kind for LangSmith (helps with visualization)
    // Tool call spans get "tool" kind, LLM spans get "llm" kind
    // Also set gen_ai.operation.name for OTEL semantic conventions
    // Set openinference.span.kind (CAPITAL case) for LangSmith run_type mapping
    if (span.name === "ai.toolCall") {
      newAttrs["langsmith.span.kind"] = "tool"
      newAttrs["openinference.span.kind"] = "TOOL"  // Capital for LangSmith run_type mapping
      newAttrs["gen_ai.operation.name"] = "tool_call"
    } else if (span.name.startsWith("ai.")) {
      newAttrs["langsmith.span.kind"] = "llm"
      newAttrs["openinference.span.kind"] = "LLM"  // Capital for LangSmith run_type mapping
      newAttrs["gen_ai.operation.name"] = "chat"
    }

    // Parse tool calls from response for LangSmith TOOLS tab
    // AI SDK format: JSON string of array with { toolCallId, toolName, input }
    const toolCallsValue = originalAttrs["ai.response.toolCalls"]
    if (toolCallsValue) {
      try {
        const toolCalls = typeof toolCallsValue === "string" ? JSON.parse(toolCallsValue) : toolCallsValue
        if (Array.isArray(toolCalls)) {
          toolCalls.forEach((tc: { toolCallId?: string; toolName?: string; input?: unknown; args?: unknown }, i: number) => {
            if (tc.toolCallId) newAttrs[`tool_calls.${i}.id`] = tc.toolCallId
            if (tc.toolName) newAttrs[`tool_calls.${i}.function.name`] = tc.toolName
            // AI SDK uses "input", but support "args" as fallback for compatibility
            const toolArgs = tc.input ?? tc.args
            if (toolArgs) {
              newAttrs[`tool_calls.${i}.function.arguments`] =
                typeof toolArgs === "string" ? toolArgs : JSON.stringify(toolArgs)
            }
          })
          // Also store as gen_ai format for broader compatibility
          newAttrs["gen_ai.completion.tool_calls"] = typeof toolCallsValue === "string" ? toolCallsValue : JSON.stringify(toolCallsValue)
        }
      } catch (e) {
        // If parsing fails, keep the raw value and log for debugging
        if (process.env.OTEL_DEBUG_ATTRS === "true") {
          console.error(`[OTEL DEBUG] Failed to parse toolCalls: ${e}`)
        }
        newAttrs["gen_ai.completion.tool_calls"] = typeof toolCallsValue === "string" ? toolCallsValue : JSON.stringify(toolCallsValue)
      }
    }

    // Parse tool definitions for LangSmith TOOLS tab
    // AI SDK sends ai.prompt.tools as an array of JSON strings (each tool is individually stringified)
    const toolsValue = originalAttrs["ai.prompt.tools"]
    if (toolsValue) {
      try {
        let tools: Array<{ type?: string; name?: string; description?: string; inputSchema?: unknown }>

        if (Array.isArray(toolsValue)) {
          // AI SDK format: array of JSON strings, parse each one
          tools = toolsValue.map((t) => (typeof t === "string" ? JSON.parse(t) : t))
        } else if (typeof toolsValue === "string") {
          // Fallback: try parsing as a JSON array
          const parsed = JSON.parse(toolsValue)
          tools = Array.isArray(parsed) ? parsed : [parsed]
        } else if (typeof toolsValue === "object") {
          // Single tool object
          tools = [toolsValue as { type?: string; name?: string; description?: string; inputSchema?: unknown }]
        } else {
          // Unexpected type (number, boolean) - skip processing
          tools = []
        }

        // Debug: log parsed tools
        if (process.env.OTEL_DEBUG_ATTRS === "true") {
          console.error(`[OTEL DEBUG] Parsed ${tools.length} tools`)
          tools.forEach((t, i) => {
            console.error(`[OTEL DEBUG] Tool ${i}: name=${t.name}, desc=${t.description?.slice(0, 50)}..., hasSchema=${!!t.inputSchema}`)
          })
        }

        // Format tools as OpenAI-style function definitions for LangSmith
        const formattedTools = tools.map((t) => ({
          type: "function",
          function: {
            name: t.name || "",
            description: t.description || "",
            parameters: t.inputSchema || {},
          },
        }))
        newAttrs["tools"] = JSON.stringify(formattedTools)
      } catch (e) {
        // If parsing fails, keep the raw value and log for debugging
        if (process.env.OTEL_DEBUG_ATTRS === "true") {
          console.error(`[OTEL DEBUG] Failed to parse tools: ${e}`)
          console.error(`[OTEL DEBUG] toolsValue type: ${typeof toolsValue}, isArray: ${Array.isArray(toolsValue)}`)
        }
        newAttrs["tools"] = typeof toolsValue === "string" ? toolsValue : JSON.stringify(toolsValue)
      }
    }

    // For tool call spans, set input/output from args/result
    if (span.name === "ai.toolCall") {
      const toolArgs = originalAttrs["ai.toolCall.args"]
      const toolResult = originalAttrs["ai.toolCall.result"]
      const toolName = originalAttrs["ai.toolCall.name"]

      if (toolArgs) {
        const prettyOutput = process.env.OTEL_PRETTY_OUTPUT !== "false"
        let formattedArgs = toolArgs
        if (typeof toolArgs === "string" && prettyOutput) {
          try {
            formattedArgs = JSON.stringify(JSON.parse(toolArgs), null, 2)
          } catch {
            // Not JSON, keep as-is
          }
        }
        newAttrs["input.value"] = formattedArgs
      }

      if (toolResult) {
        const prettyOutput = process.env.OTEL_PRETTY_OUTPUT !== "false"
        let formattedResult = toolResult
        if (typeof toolResult === "string" && prettyOutput) {
          try {
            formattedResult = JSON.stringify(JSON.parse(toolResult), null, 2)
          } catch {
            // Not JSON, keep as-is
          }
        }
        newAttrs["output.value"] = formattedResult
      }

      if (toolName) {
        newAttrs["name"] = toolName
      }
    }

    // Set thread ID for LangSmith grouping (uses session.id from OTEL_RESOURCE_ATTRIBUTES)
    const threadId = getSessionIdFromEnv()
    if (threadId) {
      newAttrs["langsmith.thread.id"] = threadId
    }

    // Return a proxy that uses transformed attributes
    return new Proxy(span, {
      get(target, prop) {
        if (prop === "attributes") {
          return newAttrs
        }
        return (target as any)[prop]
      },
    })
  }
}

let provider: NodeTracerProvider | null = null
let initialized = false

/**
 * Parse session.id from OTEL_RESOURCE_ATTRIBUTES for LangSmith thread grouping.
 * Format: "session.id=xxx,agent.name=yyy,..."
 */
function getSessionIdFromEnv(): string | undefined {
  const attrs = process.env.OTEL_RESOURCE_ATTRIBUTES
  if (!attrs) return undefined

  const match = attrs.match(/session\.id=([^,]+)/)
  return match?.[1]
}

/**
 * Extract parent context from TRACEPARENT environment variable.
 * This enables OpenCode spans to be children of orchestrator spans.
 *
 * Uses W3C Trace Context standard for propagation:
 * - TRACEPARENT: Contains trace-id, parent-id, and trace-flags
 * - TRACESTATE: Optional vendor-specific trace data
 *
 * @returns The extracted context, or the current active context if no TRACEPARENT is set
 */
export function getParentContextFromEnv(): Context {
  const traceparent = process.env.TRACEPARENT
  const tracestate = process.env.TRACESTATE

  if (!traceparent) {
    return otelContext.active()
  }

  // Debug: Log trace context if debugging is enabled
  if (process.env.OTEL_DEBUG_ATTRS === "true") {
    console.error(`[OTEL DEBUG] TRACEPARENT: ${traceparent}`)
    if (tracestate) {
      console.error(`[OTEL DEBUG] TRACESTATE: ${tracestate}`)
    }
  }

  // Create carrier with trace context headers (lowercase as per W3C spec)
  const carrier: Record<string, string> = { traceparent }
  if (tracestate) {
    carrier.tracestate = tracestate
  }

  // Extract context using W3C Trace Context propagator
  return propagation.extract(otelContext.active(), carrier)
}

/**
 * Check if OTEL is enabled via environment variables.
 * We require an explicit endpoint to be set - this keeps OTEL opt-in.
 */
function isOtelEnabledByEnv(): boolean {
  return Boolean(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  )
}

export interface TracingOptions {
  serviceName?: string
  serviceVersion?: string
  /** Use SimpleSpanProcessor instead of BatchSpanProcessor (useful for debugging) */
  debug?: boolean
}

/**
 * Initialize OpenTelemetry tracing.
 *
 * This function MUST be called before any code that might create spans.
 * It is safe to call multiple times - subsequent calls are no-ops.
 *
 * Tracing is only enabled if OTEL_EXPORTER_OTLP_ENDPOINT or
 * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set.
 */
export function initTracing(opts?: TracingOptions): void {
  if (initialized) {
    return
  }
  initialized = true

  // Enable diagnostic logging if requested
  const logLevel = process.env.OTEL_LOG_LEVEL?.toLowerCase()
  if (logLevel === "debug") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG)
  } else if (logLevel === "verbose") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.VERBOSE)
  } else if (logLevel === "info") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO)
  } else if (logLevel === "warn") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN)
  } else if (logLevel === "error") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR)
  }

  // If no endpoint is configured, do nothing (keeps OTEL opt-in)
  if (!isOtelEnabledByEnv()) {
    diag.debug("OpenTelemetry tracing not enabled: no OTLP endpoint configured")
    return
  }

  const serviceName = opts?.serviceName || process.env.OTEL_SERVICE_NAME || "opencode"
  const serviceVersion = opts?.serviceVersion || process.env.npm_package_version

  diag.info(`Initializing OpenTelemetry tracing for service: ${serviceName}`)

  // Determine deployment environment
  const environment = process.env.DEPLOYMENT_ENVIRONMENT ||
                      process.env.NODE_ENV ||
                      "development"

  // Create resource with service information
  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    ...(serviceVersion ? { [ATTR_SERVICE_VERSION]: serviceVersion } : {}),
    "deployment.environment": environment,
  })

  // Create the OTLP exporter using our custom fetch-based implementation
  // This works with Bun runtime (unlike @opentelemetry/exporter-trace-otlp-http
  // which uses Node.js http modules that timeout in Bun subprocesses)
  //
  // The exporter reads these env vars:
  // - OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT
  // - OTEL_EXPORTER_OTLP_HEADERS
  const exporter = new FetchOTLPTraceExporter({
    timeoutMs: 30000,
  })

  // Create the tracer provider
  provider = new NodeTracerProvider({
    resource,
  })

  // Use BatchSpanProcessor for production (batches spans for efficiency)
  // Use SimpleSpanProcessor for:
  //   - Debug mode (immediate export for troubleshooting)
  //   - Subprocess runs (orchestrator spawns) to avoid 5s delay on short-lived processes
  const isSubprocess = Boolean(process.env.OTEL_RESOURCE_ATTRIBUTES?.includes("session.id="))
  const useSimpleProcessor = opts?.debug || process.env.OTEL_LOG_LEVEL === "debug" || isSubprocess

  const baseProcessor = useSimpleProcessor
    ? new SimpleSpanProcessor(exporter)
    : new BatchSpanProcessor(exporter, {
        // Export spans every 5 seconds or when batch is full
        scheduledDelayMillis: 5000,
        // Max batch size
        maxExportBatchSize: 512,
        // Max queue size
        maxQueueSize: 2048,
      })

  if (isSubprocess) {
    console.error("[OTEL] Using SimpleSpanProcessor for subprocess (immediate export)")
  }

  // Wrap with LangSmith attribute transformer for compatibility
  const spanProcessor = new LangSmithAttributeProcessor(baseProcessor)

  provider.addSpanProcessor(spanProcessor)

  // Register as the global tracer provider
  // This makes spans created by the AI SDK (and any other OTEL-instrumented code)
  // actually get exported
  provider.register()

  diag.info("OpenTelemetry tracing initialized successfully")
}

/**
 * Gracefully shut down the tracer provider.
 *
 * This flushes any pending spans to the exporter before the process exits.
 * MUST be called before process.exit() or spans may be lost.
 *
 * @param timeoutMs Maximum time to wait for shutdown (default: 5000ms)
 */
export async function shutdownTracing(timeoutMs = 5000): Promise<void> {
  if (!provider) {
    return
  }

  diag.info("Shutting down OpenTelemetry tracing...")

  try {
    // Race between shutdown and timeout to avoid hanging the CLI
    await Promise.race([
      provider.shutdown(),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])
    diag.info("OpenTelemetry tracing shut down successfully")
  } catch (error) {
    // Log but don't throw - we don't want shutdown errors to crash the CLI
    diag.error("Error shutting down OpenTelemetry tracing", error)
  } finally {
    provider = null
  }
}

/**
 * Force flush any pending spans without shutting down.
 * Useful for ensuring spans are exported at specific points.
 *
 * @param timeoutMs Maximum time to wait for flush (default: 5000ms)
 */
export async function flushTracing(timeoutMs = 5000): Promise<void> {
  if (!provider) {
    return
  }

  try {
    await Promise.race([
      provider.forceFlush(),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  } catch (error) {
    diag.error("Error flushing OpenTelemetry spans", error)
  }
}

/**
 * Check if tracing has been initialized.
 */
export function isTracingInitialized(): boolean {
  return initialized
}

/**
 * Check if tracing is active (initialized AND has a provider).
 */
export function isTracingActive(): boolean {
  return initialized && provider !== null
}

/**
 * Get a tracer instance for creating custom spans.
 * Returns a no-op tracer if tracing is not active.
 */
export function getTracer(name: string, version?: string) {
  return trace.getTracer(name, version)
}
