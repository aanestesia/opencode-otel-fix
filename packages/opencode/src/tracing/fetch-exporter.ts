/**
 * Fetch-based OTLP Trace Exporter for Bun Compatibility
 *
 * This exporter uses native fetch() instead of Node.js http modules,
 * making it compatible with Bun runtime which doesn't fully support
 * Node's http in subprocess environments.
 *
 * Uses OTLP/HTTP with JSON encoding (not protobuf) for simplicity.
 * LangSmith's /otel endpoint accepts both formats.
 */

import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import { diag } from "@opentelemetry/api"

// Define export result types inline (avoids @opentelemetry/core dependency)
export enum ExportResultCode {
  SUCCESS = 0,
  FAILED = 1,
}

export interface ExportResult {
  code: ExportResultCode
  error?: Error
}

export interface FetchOTLPExporterConfig {
  /** OTLP endpoint URL (e.g., "https://api.smith.langchain.com/otel/v1/traces") */
  url?: string
  /** Headers to send with requests (e.g., {"x-api-key": "..."}) */
  headers?: Record<string, string>
  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number
  /** Enable gzip compression (default: false - LangSmith handles uncompressed fine) */
  compression?: boolean
}


/**
 * Convert a ReadableSpan to OTLP JSON format.
 * Based on OTLP/HTTP JSON spec: https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding
 */
function spanToOtlpJson(span: ReadableSpan): object {
  const spanContext = span.spanContext()

  // Convert attributes to OTLP format
  // IMPORTANT: Per OTLP JSON protobuf encoding, int64 values MUST be strings
  // See: https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding
  const attributes = Object.entries(span.attributes).map(([key, value]) => {
    let attrValue: object
    if (typeof value === "string") {
      attrValue = { stringValue: value }
    } else if (typeof value === "number") {
      if (Number.isInteger(value)) {
        // intValue must be a STRING per protobuf-JSON encoding rules
        attrValue = { intValue: String(value) }
      } else {
        attrValue = { doubleValue: value }
      }
    } else if (typeof value === "boolean") {
      attrValue = { boolValue: value }
    } else if (Array.isArray(value)) {
      // Array values - also need string encoding for integers
      const arrayValue = value.map((v) => {
        if (typeof v === "string") return { stringValue: v }
        if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }
        if (typeof v === "boolean") return { boolValue: v }
        return { stringValue: String(v) }
      })
      attrValue = { arrayValue: { values: arrayValue } }
    } else {
      attrValue = { stringValue: String(value) }
    }
    return { key, value: attrValue }
  })

  // Convert events to OTLP format
  const events = span.events.map((event) => ({
    timeUnixNano: hrTimeToNanos(event.time),
    name: event.name,
    attributes: event.attributes
      ? Object.entries(event.attributes).map(([key, value]) => ({
          key,
          value: { stringValue: String(value) },
        }))
      : [],
  }))

  // Convert links to OTLP format
  const links = span.links.map((link) => ({
    traceId: link.context.traceId,
    spanId: link.context.spanId,
    attributes: link.attributes
      ? Object.entries(link.attributes).map(([key, value]) => ({
          key,
          value: { stringValue: String(value) },
        }))
      : [],
  }))

  // Build the span object
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    parentSpanId: span.parentSpanId || undefined,
    name: span.name,
    kind: span.kind,  // OTLP and SDK both use 0-indexed SpanKind enum
    startTimeUnixNano: hrTimeToNanos(span.startTime),
    endTimeUnixNano: hrTimeToNanos(span.endTime),
    attributes,
    events,
    links,
    status: {
      code: span.status.code,
      message: span.status.message,
    },
    // Include trace state if present
    ...(spanContext.traceState ? { traceState: spanContext.traceState.serialize() } : {}),
  }
}

/**
 * Convert HrTime [seconds, nanoseconds] to nanoseconds string.
 * OTLP JSON uses string for large integers to avoid precision loss.
 */
function hrTimeToNanos(hrTime: [number, number]): string {
  const [seconds, nanos] = hrTime
  // Use BigInt to avoid precision loss with large nanosecond values
  const totalNanos = BigInt(seconds) * BigInt(1_000_000_000) + BigInt(nanos)
  return totalNanos.toString()
}

/**
 * Group spans by resource and instrumentation scope for OTLP format.
 */
function spansToOtlpPayload(spans: ReadableSpan[]): object {
  // Group spans by resource
  const resourceSpansMap = new Map<string, { resource: object; scopeSpans: Map<string, object[]> }>()

  for (const span of spans) {
    const resource = span.resource
    const resourceKey = JSON.stringify(resource.attributes)

    if (!resourceSpansMap.has(resourceKey)) {
      resourceSpansMap.set(resourceKey, {
        resource: {
          attributes: Object.entries(resource.attributes).map(([key, value]) => ({
            key,
            value: { stringValue: String(value) },
          })),
        },
        scopeSpans: new Map(),
      })
    }

    const resourceEntry = resourceSpansMap.get(resourceKey)!
    const scopeKey = span.instrumentationLibrary.name + "@" + (span.instrumentationLibrary.version || "")

    if (!resourceEntry.scopeSpans.has(scopeKey)) {
      resourceEntry.scopeSpans.set(scopeKey, [])
    }

    resourceEntry.scopeSpans.get(scopeKey)!.push(spanToOtlpJson(span))
  }

  // Convert to OTLP structure
  const resourceSpans = Array.from(resourceSpansMap.values()).map((entry) => ({
    resource: entry.resource,
    scopeSpans: Array.from(entry.scopeSpans.entries()).map(([scopeKey, spans]) => {
      const [name, version] = scopeKey.split("@")
      return {
        scope: {
          name,
          version: version || undefined,
        },
        spans,
      }
    }),
  }))

  return { resourceSpans }
}

/**
 * Fetch-based OTLP Trace Exporter.
 *
 * Uses native fetch() for HTTP requests, making it compatible with Bun runtime.
 */
export class FetchOTLPTraceExporter implements SpanExporter {
  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number
  private readonly compression: boolean
  private isShutdown = false

  constructor(config: FetchOTLPExporterConfig = {}) {
    // Determine endpoint URL
    this.url =
      config.url ||
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
      (process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`
        : "http://localhost:4318/v1/traces")

    // Parse headers from config or environment
    this.headers = { ...config.headers }

    // Parse OTEL_EXPORTER_OTLP_HEADERS (format: "key1=value1,key2=value2")
    const envHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS
    if (envHeaders) {
      for (const pair of envHeaders.split(",")) {
        const [key, ...valueParts] = pair.split("=")
        if (key && valueParts.length > 0) {
          this.headers[key.trim()] = valueParts.join("=").trim()
        }
      }
    }

    // Always set content type for JSON
    this.headers["Content-Type"] = "application/json"

    this.timeoutMs = config.timeoutMs ?? 30000
    this.compression = config.compression ?? false

    diag.debug(`[FetchOTLPExporter] Initialized with URL: ${this.url}`)
    diag.debug(`[FetchOTLPExporter] Headers: ${Object.keys(this.headers).join(", ")}`)
  }

  /**
   * Export spans to the OTLP endpoint using fetch.
   */
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.isShutdown) {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error("Exporter is shutdown") })
      return
    }

    if (spans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS })
      return
    }

    this.sendSpans(spans)
      .then(() => {
        resultCallback({ code: ExportResultCode.SUCCESS })
      })
      .catch((error) => {
        diag.error(`[FetchOTLPExporter] Export failed: ${error.message}`)
        resultCallback({ code: ExportResultCode.FAILED, error })
      })
  }

  private async sendSpans(spans: ReadableSpan[]): Promise<void> {
    const payload = spansToOtlpPayload(spans)
    const body = JSON.stringify(payload)

    diag.debug(`[FetchOTLPExporter] Exporting ${spans.length} spans to ${this.url}`)

    // Create abort controller for timeout
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: this.headers,
        body,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      const responseText = await response.text().catch(() => "")
      if (process.env.OPENCODE_OTEL_LOG_RESPONSE === "1") {
        console.error(
          `[FetchOTLPExporter] response=${response.status} ${response.statusText} body=${responseText || "<empty>"}`
        )
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}. ${responseText}`)
      }

      diag.debug(`[FetchOTLPExporter] Successfully exported ${spans.length} spans`)
    } catch (error: any) {
      clearTimeout(timeoutId)

      if (error.name === "AbortError") {
        throw new Error(`Request timed out after ${this.timeoutMs}ms`)
      }
      throw error
    }
  }

  /**
   * Shutdown the exporter.
   */
  async shutdown(): Promise<void> {
    this.isShutdown = true
    diag.debug("[FetchOTLPExporter] Shutdown complete")
  }

  /**
   * Force flush - no-op for this exporter as we send immediately.
   */
  async forceFlush(): Promise<void> {
    // No buffering, nothing to flush
  }
}
