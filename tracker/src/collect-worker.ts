// Parsing and git inspection are synchronous; keep them off the protocol event loop.
import { parentPort, workerData } from "node:worker_threads";
import { collect } from "./collect";

parentPort!.postMessage(await collect(workerData, line => console.error(line)));
