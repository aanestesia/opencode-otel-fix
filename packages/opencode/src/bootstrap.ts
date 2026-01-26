/**
 * OpenCode Bootstrap Entry Point
 *
 * This file MUST be the entry point for the CLI. It initializes OpenTelemetry
 * tracing BEFORE importing any other modules that might create spans.
 *
 * The import order is critical:
 * 1. Initialize tracing (this file)
 * 2. Import the main CLI (./cli.ts)
 *
 * This ensures the TracerProvider is registered before the AI SDK or any
 * other instrumented code runs.
 */

// Initialize tracing FIRST - before any other imports
import { initTracing, shutdownTracing } from "./tracing"

// Initialize tracing immediately at module load time
// This MUST happen before the dynamic import below
initTracing({
  serviceName: "opencode",
})

// Set up signal handlers for graceful shutdown
// These ensure spans are flushed before the process exits
let isShuttingDown = false

async function gracefulShutdown(signal: string, exitCode: number) {
  if (isShuttingDown) {
    return
  }
  isShuttingDown = true

  // Flush and shutdown tracing
  await shutdownTracing()

  process.exit(exitCode)
}

process.on("SIGINT", () => gracefulShutdown("SIGINT", 130))
process.on("SIGTERM", () => gracefulShutdown("SIGTERM", 143))

// Now dynamically import the main CLI
// This ensures all CLI imports happen AFTER tracing is initialized
import("./cli").catch(async (error) => {
  // On import error, still try to flush traces
  console.error("Failed to load CLI:", error)
  await shutdownTracing()
  process.exit(1)
})
