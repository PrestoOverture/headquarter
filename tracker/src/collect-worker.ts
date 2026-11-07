// Parsing and git inspection are synchronous; keep them off the protocol event loop.
import { parentPort, workerData } from "node:worker_threads";
import { collect } from "./collect";

const { options, delayMs = 0 } = workerData;
parentPort!.postMessage({ type: "progress", progress: { plugin: "准备", parsed: 0, reused: 0, elapsedSeconds: 0 } });
// Injectable delay keeps the bounded-wait protocol test independent of machine speed.
if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
const data = await collect(options, line => console.error(line), progress => parentPort!.postMessage({ type: "progress", progress }));
parentPort!.postMessage({ type: "complete", data });
