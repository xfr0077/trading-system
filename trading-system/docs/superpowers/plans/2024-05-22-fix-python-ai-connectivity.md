# Fix Plan: python-ai Connectivity & Signal Frequency

## Problem Summary

1. python-ai frequently shows offline in dashboard
2. Signal frequency too high (3s per inference)
3. Too many open/close signals (all rejected)

## Root Causes

| RC | Description | Severity |
|----|-------------|----------|
| RC1 | Heartbeat uses close/noop gRPC signal, rejected by `NO_POSITION_TO_CLOSE` + `SIGNAL_RATE_LIMITED` | 🔴 |
| RC2 | `send_signal()` uses sync gRPC stub inside asyncio event loop, blocking it | 🔴 |
| RC3 | Model inference runs every 3s tick, 10x more than needed | 🔴 |
| RC4 | Circuit breaker `is_healthy=False` has no auto-recovery (half-open) | 🔴 |
| RC5 | Dedup `action == last_action` makes signals completely silent during repeated actions | 🟡 |
| RC6 | TLS path lost if grpc.aio upgrade not mirrored; `/api/ping` auth not specified | 🟡 |
| RC7 | grpc.aio `__aexit__` missing `await channel.close()` | 🟡 |
| RC8 | Ping HTTP call has no timeout protection | 🟡 |

## Implementation Plan

```
P0 ─┬─ [RC2] Async gRPC (signal_client.py)
    ├─ [RC1][RC5] HTTP ping /api/ping (dashboard.ts + main.py)
    ├─ [RC4] Circuit breaker half-open (main.py)
    └─ [RC7] grpc.aio channel close in __aexit__
P1 ─┬─ [RC3] 30s inference interval (config.py + main.py)
    ├─ [RC8] ping timeout 3s (main.py)
    └─ [RC3] MAX_SIGNALS_PER_MINUTE 5→3 (signal-router.ts)
P2 ─┬─ [RC1] Remove heartbeat close signal (main.py)
    ├─ [RC6] /api/ping skip auth + remove _lastPythonAiPing from handleSignal (dashboard.ts, signal-router.ts)
    └─ [RC1] Cleanup handleSignal (signal-router.ts)
```

### File: `python-ai/src/signal_client.py` (P0)

```python
# Before: sync gRPC
self.channel = grpc.insecure_channel(target, options=options)
self.stub = signal_pb2_grpc.SignalServiceStub(self.channel)

def send_signal(...) -> SignalAck:
    ...
    response = self.stub.SendSignal(request, timeout=...)
    ...

# After: async gRPC via grpc.aio
self.channel = grpc.aio.insecure_channel(target, options=options)  # also secure_channel for TLS branch
self.stub = signal_pb2_grpc.SignalServiceStub(self.channel)  # grpc.aio stub

async def send_signal(...) -> SignalAck:
    ...
    response = await self.stub.SendSignal(request, timeout=...)
    ...

async def health_check(self) -> bool:
    """Async health check for circuit breaker half-open recovery (RC4)"""
    try:
        response = await self.stub.HealthCheck(signal_pb2.HealthRequest(), timeout=5)
        return response.healthy
    except Exception:
        return False

async def __aenter__(self):
    return self

async def __aexit__(self, exc_type, exc_val, exc_tb):
    await self.channel.close()  # RC7 fix
    return False
```

**Note**: `signal_pb2_grpc.SignalServiceStub` works with both sync and aio channels in grpcio. The stub methods return coroutines when using aio channel.

### File: `python-ai/src/main.py` (P0, P1, P2)

```python
async def ping_loop(session: aiohttp.ClientSession, url: str):
    """P0: Independent ping task - sends heartbeat to dashboard every 5s"""
    while True:
        try:
            await asyncio.wait_for(session.get(f"{url}/api/ping"), timeout=3)  # RC8
        except Exception:
            pass  # ping failures are non-critical
        await asyncio.sleep(5)

async def health_check_loop(grpc_client: SignalClient, health: HealthMonitor):
    """Running health monitoring + circuit breaker half-open recovery (RC4)"""
    while True:
        await asyncio.sleep(10)
        if not health.check_timeout():
            health.record_failure("Heartbeat timeout")
        if not health.is_healthy:
            # RC4: half-open - try recovery every 30s via gRPC health check
            try:
                ok = await grpc_client.health_check()  # async version, lightweight RPC
                if ok:
                    health.record_success()
                    logger.info("Circuit breaker RESET after recovery")
            except Exception:
                pass
        ...

async def main():
    ...
    last_inference_time = 0

    async with aiohttp.ClientSession() as http_session:
        ping_task = asyncio.create_task(ping_loop(http_session, "http://ts-engine:80"))
        health_task = asyncio.create_task(health_check_loop(...))

        async for data in reader.stream():
            # RECORD SUCCESS EVERY TICK (outside time gate - P1)
            health.record_success()

            buffer = price_buffer[data.symbol]
            buffer.append(data)
            if len(buffer) > config.feature_window:
                buffer.pop(0)

            # P1: Time-gate inference to every config.inference_interval_seconds
            now = time.time()
            if now - last_inference_time < config.inference_interval_seconds:
                continue
            last_inference_time = now

            if len(buffer) < config.feature_window:
                continue

            # inference
            features = engine.compute(buffer)
            action, confidence = inference.predict(features)

            if action is None:
                # P2: No heartbeat signal - just log
                logger.info(f"Confidence {confidence:.1f}% below threshold")
                continue

            # P2: Dedup still applies, but with 30s interval it's less frequent
            if action == last_action[data.symbol]:
                continue
            last_action[data.symbol] = action

            # P0: Async gRPC call
            try:
                ack = await client.send_signal(...)
                logger.info(f"Signal: {action} {data.symbol} (conf={confidence:.1f}%) accepted={ack.accepted}")
            except Exception as e:
                logger.error(f"Signal failed: {e}")
```

### File: `python-ai/src/config.py` (P1)

```python
class AIConfig:
    ...
    inference_interval_seconds: int = 30  # NEW
```

### File: `ts-engine/src/dashboard.ts` (P0, P2)

Add BEFORE the auth check block:
```typescript
// P0: Ping endpoint - no auth, no validation
if (method === 'GET' && path === '/api/ping') {
  router.ping();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, timestamp: Date.now() }));
  return;
}
```

### File: `ts-engine/src/signal-router.ts` (P0, P2)

```typescript
// NEW public method
ping(): void {
  this._lastPythonAiPing = Date.now();
}

// MODIFY: remove _lastPythonAiPing from handleSignal
async handleSignal(signal: SignalInput): Promise<{ accepted: boolean; reason: string }> {
  // P2: _lastPythonAiPing removed from here - ping() handles it
  const validationError = this.validateSignal(signal);
  ...

// MODIFY: MAX_SIGNALS_PER_MINUTE 5 -> 3 (P1)
private readonly MAX_SIGNALS_PER_MINUTE = 3;
```

## Auth Strategy for /api/ping (RC6)

`/api/ping` is placed BEFORE the auth check in dashboard.ts. Rationale:
- It only updates `_lastPythonAiPing` timestamp (no sensitive data exposed)
- It returns `{ ok: true, timestamp }` only
- It's called from within Docker network (ts-engine container)
- If external access is needed later, add `X-Internal-Secret` header check

Files: 5 files modified
Risk: Low
Review: Required before implementation
