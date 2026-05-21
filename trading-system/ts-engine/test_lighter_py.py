import asyncio
import json
import os
import sys

BASE_URL = 'https://mainnet.zklighter.elliot.ai'
WALLET = '0xF380e481B121E0d5fC0D06d7370f6CFC81A195F5'
PRIV_KEY = os.environ.get('LIGHTER_API_PRIVATE_KEY', '')
API_KEY_INDEX = int(os.environ.get('LIGHTER_API_KEY_INDEX', '7'))

async def main():
    print("=== Lighter Python SDK Test ===\n")

    from lighter import AccountApi, ApiClient, Configuration, SignerClient

    config = Configuration(host=BASE_URL)
    api_client = ApiClient(config)
    account_api = AccountApi(api_client)

    # Step 1: Get account by L1 address
    print("1. Getting account by L1 address...")
    try:
        result = await account_api.get_account_by_l1_address(WALLET)
        d = result.to_dict()
        print(f"   Response: {json.dumps(d, indent=2)[:800]}")
        if "account_index" in d:
            print(f"\n   => Account index: {d['account_index']}")
    except Exception as e:
        print(f"   Error: {e}")

    # Step 2: Try SignerClient
    print("\n2. Creating SignerClient...")
    try:
        client = SignerClient(
            url=BASE_URL,
            account_index=0,  # Will try with 0 first
            api_private_keys={API_KEY_INDEX: PRIV_KEY},
        )
        err = client.check_client()
        print(f"   check_client: {err}")
    except Exception as e:
        print(f"   Error: {e}")

    # Step 3: Try getting markets (public endpoint)
    print("\n3. Getting markets config...")
    try:
        from lighter import InfoApi
        info_api = InfoApi(api_client)
        result = await info_api.get_markets_config()
        d = result.to_dict()
        markets = d.get("markets", [])
        print(f"   Markets count: {len(markets)}")
        for m in markets[:5]:
            print(f"   - {m.get('name', '?')} (index: {m.get('market_index', '?')})")
    except Exception as e:
        print(f"   Error: {e}")

    await api_client.close()

asyncio.run(main())
