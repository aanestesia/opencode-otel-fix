/**
 * OpenCode CLI Entry Point
 *
 * This file imports the bootstrap module which:
 * 1. Initializes OpenTelemetry tracing FIRST
 * 2. Then imports and runs the CLI
 *
 * This ensures the TracerProvider is registered before any spans are created.
 */

import "./bootstrap"
