import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { HttpResponse } from "./http-utils.js";
import { AdmissionStopFlights, handlePostRoute, type Admission } from "./post-routes.js";
import { PiRpcCommandError, type PiRpcProcess } from "./pi-rpc.js";
import type { PiV4Projection } from "./projection.js";

type CapturedResponse = { status: number; body: string };

function jsonRequest(body: unknown): IncomingMessage {
  const request = Readable.from([JSON.stringify(body)]);
  Object.assign(request, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  return request as IncomingMessage;
}

function stopRequest(): IncomingMessage {
  return jsonRequest({});
}

function promptRequest(message: string): IncomingMessage {
  return jsonRequest({ message });
}

function capturedResponse(): [HttpResponse, () => CapturedResponse] {
  const result: CapturedResponse = { status: 0, body: "" };
  const response = {
    writeHead(status: number) {
      result.status = status;
      return this;
    },
    setHeader() {
      return this;
    },
    end(body?: string | Buffer) {
      result.body += body?.toString() ?? "";
      return this;
    },
  };
  return [response as unknown as HttpResponse, () => result];
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("a delayed clear_queue ACK for settled A cannot erase B's stop flight", async () => {
  const flights = new AdmissionStopFlights();
  const admissionA: Admission = { accepted: true, stopRequested: false, terminal: false };
  const admissionB: Admission = { accepted: true, stopRequested: false, terminal: false };
  const clearQueueAckA = deferred<void>();
  const clearQueueAckB = deferred<void>();
  const startedA = deferred<void>();
  const startedB = deferred<void>();
  const thirdCurrentRead = deferred<void>();
  const runStopAdmissions: Admission[] = [];
  let current: Admission | null = admissionA;
  let currentReads = 0;
  const context = {
    ready: Promise.resolve(),
    child: {} as PiRpcProcess,
    getProjection: () => null,
    available: () => true,
    current: () => {
      currentReads += 1;
      if (currentReads === 3) thirdCurrentRead.resolve();
      return current;
    },
    reserve: () => admissionA,
    release: () => {},
    isStreaming: () => true,
    update: () => {},
    runStop: (active: Admission) => {
      runStopAdmissions.push(active);
      if (active === admissionA) {
        startedA.resolve();
        return clearQueueAckA.promise;
      }
      startedB.resolve();
      return clearQueueAckB.promise;
    },
    getStopFlight: (active: Admission) => flights.get(active),
    setStopFlight: (active: Admission, flight: Promise<boolean> | null) =>
      flights.set(active, flight),
    failClosed: () => assert.fail("successful fake clear_queue ACK must not fail closed"),
  };

  const requestStop = () => {
    const [response, result] = capturedResponse();
    return {
      completion: handlePostRoute(stopRequest(), response, "stop", context),
      result,
    };
  };

  const stopA = requestStop();
  await startedA.promise;

  // Pi settles A before its delayed clear_queue ACK; B is then admitted independently.
  admissionA.terminal = true;
  current = admissionB;
  const stopB = requestStop();
  await startedB.promise;

  clearQueueAckA.resolve();
  await stopA.completion;
  assert.deepEqual(JSON.parse(stopA.result().body), { stopped: true, pending: false });

  // A's finalizer must only delete A's flight, leaving B's in-flight stop reusable.
  const duplicateCurrentRead = thirdCurrentRead.promise;
  const duplicateStopB = requestStop();
  await duplicateCurrentRead;
  assert.deepEqual(runStopAdmissions, [admissionA, admissionB]);

  admissionB.terminal = true;
  current = null;
  clearQueueAckB.resolve();
  await Promise.all([stopB.completion, duplicateStopB.completion]);
  assert.equal(stopB.result().status, 200);
  assert.deepEqual(JSON.parse(stopB.result().body), { stopped: true, pending: false });
  assert.deepEqual(JSON.parse(duplicateStopB.result().body), { stopped: true, pending: false });
});

test("an uncertain prompt ACK fails closed before releasing admission", async () => {
  const ack = deferred<void>();
  const flights = new AdmissionStopFlights();
  const projection = { setRunState: () => {} } as unknown as PiV4Projection;
  let available = true;
  let current: Admission | null = null;
  let promptCalls = 0;
  let killRequested = false;
  const promptStarted = deferred<void>();
  const child = {
    request: () => {
      promptCalls += 1;
      promptStarted.resolve();
      return ack.promise;
    },
    kill: () => {
      killRequested = true;
    },
  } as unknown as PiRpcProcess;
  const context = {
    ready: Promise.resolve(),
    child,
    getProjection: () => projection,
    available: () => available,
    current: () => current,
    reserve: () => {
      current = { accepted: false, stopRequested: false, terminal: false };
      return current;
    },
    release: (active: Admission) => {
      if (current === active) current = null;
    },
    isStreaming: () => false,
    update: () => {},
    runStop: async () => {},
    getStopFlight: (active: Admission) => flights.get(active),
    setStopFlight: (active: Admission, flight: Promise<boolean> | null) =>
      flights.set(active, flight),
    failClosed: () => {
      available = false;
      if (current) current.terminal = true;
      current = null;
      child.kill();
    },
  };

  const firstResponse = capturedResponse();
  const firstCompletion = handlePostRoute(
    promptRequest("uncertain"),
    firstResponse[0],
    "prompt",
    context,
  );
  await promptStarted.promise;
  ack.reject(new PiRpcCommandError("ack timed out", false));
  await firstCompletion;

  assert.equal(firstResponse[1]().status, 503);
  assert.deepEqual(JSON.parse(firstResponse[1]().body), {
    error: "Pi RPC process is unavailable.",
  });
  assert.equal(killRequested, true);
  assert.equal(current, null);

  const secondResponse = capturedResponse();
  await handlePostRoute(
    promptRequest("must-not-enter-before-child-close"),
    secondResponse[0],
    "prompt",
    context,
  );
  assert.equal(secondResponse[1]().status, 503);
  assert.equal(promptCalls, 1, "the uncertain RPC child must not receive another admission");
});
