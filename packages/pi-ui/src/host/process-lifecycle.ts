import { PiRpcProcess } from "./pi-rpc.js";

export async function closePiRpc(process: PiRpcProcess, graceMs: number): Promise<void> {
  process.endInput();
  const exited = await Promise.race([
    process.closedPromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
  ]);
  if (exited) return;
  process.kill();
  await process.closedPromise;
}
