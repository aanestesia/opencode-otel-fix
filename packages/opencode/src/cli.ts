/**
 * OpenCode CLI
 *
 * This module contains the main CLI logic. It should be imported from
 * bootstrap.ts which handles tracing initialization.
 *
 * IMPORTANT: Do not import this file directly. Use bootstrap.ts instead
 * to ensure proper OpenTelemetry initialization.
 */

import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { Log } from "./util/log"
import { AuthCommand } from "./cli/cmd/auth"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { NamedError } from "@opencode-ai/util/error"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/tui/attach"
import { TuiThreadCommand } from "./cli/cmd/tui/thread"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { PingCommand } from "./cli/cmd/ping"
import { shutdownTracing, getTracer, getParentContextFromEnv } from "./tracing"
import { trace } from "@opentelemetry/api"
import { context, SpanStatusCode } from "@opentelemetry/api"

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

const cli = yargs(hideBin(process.argv))
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", Installation.VERSION)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .middleware(async (opts) => {
    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"

    Log.Default.info("opencode", {
      version: Installation.VERSION,
      args: process.argv.slice(2),
    })
  })
  .usage("\n" + UI.logo())
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(AuthCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(PingCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp("log")
    }
    if (err) throw err
    process.exitCode = 1
  })
  .strict()

// Create a root span that wraps the entire CLI execution
// This groups all AI SDK spans under one parent for clean trace visualization
const tracer = getTracer("opencode.cli")
const agentName = process.argv.find((arg, i) => process.argv[i - 1] === "--agent") || "default"

// Use explicit session id for metadata tagging; only set trace.session_id with a known tracer-session UUID
const sessionId =
  process.env.LANGSMITH_TRACE_SESSION_ID ||
  process.env.OTEL_RESOURCE_ATTRIBUTES?.match(/session\.id=([^,]+)/)?.[1]
const traceSessionUuid = process.env.LANGSMITH_TRACE_SESSION_UUID

const parentContext = getParentContextFromEnv()

// Phase 4: Read ARROW_* env vars for telemetry schema enrichment
// These provide context from the orchestrator for cross-session analysis
const arrowContext = {
  taskObjective: process.env.ARROW_TASK_OBJECTIVE || "",
  domain: process.env.ARROW_DOMAIN || "",
  subdomain: process.env.ARROW_SUBDOMAIN || "",
  subdomainId: process.env.ARROW_SUBDOMAIN_ID || "",
  sessionId: process.env.ARROW_SESSION_ID || "",
  topKUsed: process.env.ARROW_TOPK_USED || "",
  entryIdsProvided: process.env.ARROW_ENTRY_IDS_PROVIDED || "",
  tier: process.env.ARROW_TIER || "",
  matchScore: process.env.ARROW_MATCH_SCORE || "",
  schemaVersion: process.env.ARROW_TELEMETRY_SCHEMA_VERSION || "v1",
}

// Build ARROW span attributes (only include non-empty values)
const arrowAttributes: Record<string, string | number> = {}
if (arrowContext.taskObjective) {
  arrowAttributes["arrow.task.objective"] = arrowContext.taskObjective.slice(0, 200)
}
if (arrowContext.domain) {
  arrowAttributes["arrow.task.domain"] = arrowContext.domain
  arrowAttributes["langsmith.metadata.domain"] = arrowContext.domain
}
if (arrowContext.subdomain) {
  arrowAttributes["arrow.task.subdomain"] = arrowContext.subdomain
  arrowAttributes["langsmith.metadata.subdomain"] = arrowContext.subdomain
}
if (arrowContext.subdomainId) {
  arrowAttributes["arrow.task.subdomain_id"] = arrowContext.subdomainId
}
if (arrowContext.sessionId) {
  arrowAttributes["arrow.task.session_id"] = arrowContext.sessionId
}
if (arrowContext.topKUsed) {
  const topK = parseInt(arrowContext.topKUsed, 10)
  if (!isNaN(topK)) {
    arrowAttributes["arrow.retrieval.topK_used"] = topK
  }
}
if (arrowContext.entryIdsProvided) {
  // Store as JSON string for complex data
  arrowAttributes["arrow.retrieval.entry_ids_provided"] = arrowContext.entryIdsProvided
}
if (arrowContext.tier) {
  const tier = parseInt(arrowContext.tier, 10)
  if (!isNaN(tier)) {
    arrowAttributes["arrow.retrieval.tier"] = tier
  }
}
if (arrowContext.matchScore) {
  const score = parseFloat(arrowContext.matchScore)
  if (!isNaN(score)) {
    arrowAttributes["arrow.retrieval.match_score"] = score
  }
}
arrowAttributes["arrow.telemetry_schema_version"] = arrowContext.schemaVersion
arrowAttributes["langsmith.metadata.telemetry_schema_version"] = arrowContext.schemaVersion

// Allow override via OPENCODE_RUN_NAME env var for orchestrator integration
// Single root span (removed redundant cliSpan wrapper to flatten hierarchy)
const runName = process.env.OPENCODE_RUN_NAME || "opencode.run"
const rootSpan = tracer.startSpan(
  runName,
  {
    attributes: {
      "opencode.agent": agentName,
      "opencode.args": process.argv.slice(2).join(" "),
      "process.command_line": process.argv.join(" "),
      "langsmith.span.kind": "chain",
      "openinference.span.kind": "CHAIN",
      "langsmith.trace.name": runName,
      // LangSmith grouping: keep session_id in metadata only (avoid per-session projects)
      ...(sessionId ? { "langsmith.metadata.session_id": sessionId } : {}),
      // Phase 4: ARROW context attributes for telemetry schema
      ...arrowAttributes,
    },
  },
  parentContext,
)
const rootContext = trace.setSpan(parentContext, rootSpan)

// Run CLI within the root span context so all child spans are linked
try {
  await context.with(rootContext, async () => {
    await cli.parse()
  })
  rootSpan.setStatus({ code: SpanStatusCode.OK })
} catch (e) {
  rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) })
  let data: Record<string, any> = {}
  if (e instanceof NamedError) {
    const obj = e.toObject()
    Object.assign(data, {
      ...obj.data,
    })
  }

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    console.error(e instanceof Error ? e.message : String(e))
  }
  process.exitCode = 1
} finally {
  // End the root span
  rootSpan.end()

  // Flush OpenTelemetry spans before exiting
  // This is critical - without this, spans may be lost
  await shutdownTracing()
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  // Note: We only call process.exit() AFTER flushing telemetry
  process.exit()
}
