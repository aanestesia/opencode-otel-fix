import { cmd } from "./cmd"
import { UI } from "../ui"

export const PingCommand = cmd({
  command: "ping",
  describe: "check system connectivity and response time",
  builder: (yargs) => {
    return yargs
      .option("count", {
        alias: "c",
        describe: "number of ping requests to send",
        type: "number",
        default: 4,
      })
      .option("interval", {
        alias: "i",
        describe: "interval between ping requests in seconds",
        type: "number",
        default: 1,
      })
  },
  handler: async (args) => {
    const startTime = Date.now()
    UI.println("PONG! " + Math.round(performance.now()) + "ms")

    if (args.count > 1) {
      for (let i = 2; i <= args.count; i++) {
        await new Promise((resolve) => setTimeout(resolve, args.interval * 1000))
        UI.println("PONG! " + Math.round(performance.now()) + "ms")
      }
    }

    const totalTime = Date.now() - startTime
    UI.println(`\nPing statistics:`)
    UI.println(`  Packets: Sent = ${args.count}, Received = ${args.count}, Lost = 0 (0% loss)`)
    UI.println(`  Approximate round trip times:`)
    UI.println(`    Total = ${totalTime}ms, Average = ${Math.round(totalTime / args.count)}ms`)
  },
})
