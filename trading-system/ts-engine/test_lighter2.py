"""
Lighter Mainnet 连接测试 - 简化版
"""
import json
import sys
import requests

BASE_URL = "https://mainnet.zklighter.elliot.ai"
WALLET = "0xF380e481B121E0d5fC0D06d7370f6CFC81A195F5"
PRIV_KEY = "717501be92f2c0f5ddf2f5b3a9d8962c1170119822aebc0d8f25b798d61ab068b7d9682eb30e885d"
API_KEY_INDEX = 7

TIMEOUT = 10


def test_public_apis():
    """测试公开 API"""
    print("=" * 60)
    print("Lighter Mainnet 连接测试")
    print("=" * 60)

    # 1. 系统配置
    print("\n[1] GET /api/v1/system/config")
    try:
        r = requests.get(f"{BASE_URL}/api/v1/system/config", timeout=TIMEOUT)
        print(f"    HTTP {r.status_code}: {r.text[:300]}")
    except Exception as e:
        print(f"    Error: {e}")

    # 2. 市场配置
    print("\n[2] GET /api/v1/markets/config")
    try:
        r = requests.get(f"{BASE_URL}/api/v1/markets/config", timeout=TIMEOUT)
        print(f"    HTTP {r.status_code}: {r.text[:500]}")
    except Exception as e:
        print(f"    Error: {e}")

    # 3. 查询账号
    print("\n[3] GET /api/v1/accounts?l1_address=...")
    try:
        r = requests.get(
            f"{BASE_URL}/api/v1/accounts",
            params={"l1_address": WALLET},
            timeout=TIMEOUT,
        )
        print(f"    HTTP {r.status_code}: {r.text[:500]}")
    except Exception as e:
        print(f"    Error: {e}")

    # 4. Next nonce (不需要 auth？)
    print(f"\n[4] GET /api/v1/nextNonce?api_key_index={API_KEY_INDEX}")
    try:
        r = requests.get(
            f"{BASE_URL}/api/v1/nextNonce",
            params={"api_key_index": API_KEY_INDEX},
            timeout=TIMEOUT,
        )
        print(f"    HTTP {r.status_code}: {r.text[:300]}")
    except Exception as e:
        print(f"    Error: {e}")

    # 5. 查询 orderbooks (可能公开)
    print("\n[5] GET /api/v1/orderbooks")
    try:
        r = requests.get(f"{BASE_URL}/api/v1/orderbooks", timeout=TIMEOUT)
        print(f"    HTTP {r.status_code}: {r.text[:500]}")
    except Exception as e:
        print(f"    Error: {e}")


def test_signer(account_index):
    """测试 SignerClient"""
    print(f"\n--- SignerClient test (account_index={account_index}) ---")
    try:
        # Import inside to avoid blocking on first import
        import asyncio
        from lighter import SignerClient

        async def run():
            client = SignerClient(
                url=BASE_URL,
                account_index=account_index,
                api_private_keys={API_KEY_INDEX: PRIV_KEY},
            )
            err = client.check_client()
            print(f"    check_client: {err}")

            if not err:
                auth, auth_err = client.create_auth_token_with_expiry(600)
                if auth_err:
                    print(f"    auth 失败: {auth_err}")
                else:
                    print(f"    auth token: {str(auth)[:60]}...")

                    # 用 auth token 查询账号
                    print(f"\n[6] GET /api/v1/accounts (with auth)...")
                    try:
                        r = requests.get(
                            f"{BASE_URL}/api/v1/accounts",
                            params={"l1_address": WALLET},
                            headers={"Authorization": str(auth)},
                            timeout=TIMEOUT,
                        )
                        print(f"    HTTP {r.status_code}: {r.text[:600]}")
                    except Exception as e:
                        print(f"    Error: {e}")

                    # 查询挂单
                    print(f"\n[7] GET /api/v1/orders (with auth)...")
                    try:
                        r = requests.get(
                            f"{BASE_URL}/api/v1/orders",
                            params={"account_index": account_index},
                            headers={"Authorization": str(auth)},
                            timeout=TIMEOUT,
                        )
                        print(f"    HTTP {r.status_code}: {r.text[:600]}")
                    except Exception as e:
                        print(f"    Error: {e}")

            client.close()

        asyncio.run(run())
    except Exception as e:
        print(f"    ✗ SignerClient 错误: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    test_public_apis()

    # 尝试不同的 account_index
    for idx in [0, 361816, 56168]:
        test_signer(idx)

    print("\n" + "=" * 60)
    print("测试完成")
    print("=" * 60)
