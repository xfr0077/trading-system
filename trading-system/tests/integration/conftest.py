import asyncio
import subprocess
import time
import grpc
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'python-ai', 'src'))

from signal_client import SignalClient


# Windows compat: gRPC aio needs a selector event loop
if os.name == 'nt':
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


@pytest.fixture(scope='session')
def event_loop():
    """Override pytest-asyncio's default event loop to be session-scoped."""
    if os.name == 'nt':
        loop = asyncio.SelectorEventLoop()
    else:
        loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    yield loop
    loop.close()


@pytest.fixture(scope='session')
async def grpc_server():
    ts_engine_dir = os.path.join(os.path.dirname(__file__), '..', '..', 'ts-engine')
    env = {
        **os.environ,
        'GRVT_API_KEY': 'test-api-key-for-integration',
        'GRVT_ENV': 'testnet',
        'GRPC_PORT': '50052',
    }

    proc = subprocess.Popen(
        ['node', 'dist/index.js'],
        cwd=ts_engine_dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    for _ in range(30):
        try:
            channel = grpc.insecure_channel('localhost:50052')
            from proto import signal_pb2
            from proto import signal_pb2_grpc
            stub = signal_pb2_grpc.SignalServiceStub(channel)
            stub.HealthCheck(signal_pb2.HealthRequest(), timeout=2)
            channel.close()
            break
        except grpc.RpcError:
            await asyncio.sleep(0.5)
    else:
        proc.terminate()
        proc.wait()
        raise RuntimeError('TS Engine gRPC server failed to start within 15 seconds')

    yield 'localhost:50052'

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


@pytest.fixture
async def client(grpc_server):
    c = SignalClient(target=grpc_server)
    yield c
