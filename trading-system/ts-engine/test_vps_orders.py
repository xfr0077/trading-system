import sys, json, asyncio
from lighter import SignerClient, ApiClient, Configuration

ACC = 725539; KEY = 7
PK = "717501be92f2c0f5ddf2f5b3a9d8962c1170119822aebc0d8f25b798d61ab068b7d9682eb30e885d"
URL = "https://mainnet.zklighter.elliot.ai"

async def main():
    api = ApiClient(Configuration(host=URL))
    sc = SignerClient(url=URL, account_index=ACC, api_private_keys={KEY: PK})
    if sc.check_client(): print("FAIL: check_client"); return

    auth, err = sc.create_auth_token_with_expiry(600)
    if err: print(f"FAIL: auth {err}"); return
    tok = str(auth)

    # Query account via raw API to see pending_orders
    headers = {"Authorization": tok, "Content-Type": "application/json"}

    # Direct REST calls using ApiClient
    print("=== Account Query ===")
    resp = await api.call_api(
        "GET", f"{URL}/api/v1/account/index/{ACC}",
        _headers=headers, _preload_content=False
    )
    body = await resp.data.read()
    acct = json.loads(body.decode())
    print(f"pending_order_count={acct.get('accounts', [{}])[0].get('pending_order_count', 'N/A')}")
    print(f"total_order_count={acct.get('accounts', [{}])[0].get('total_order_count', 'N/A')}")
    print(f"status={acct.get('accounts', [{}])[0].get('status', 'N/A')}")

    # Query recent orders via a different approach
    print("\n=== Raw Active Orders Query ===")
    raw = await api.call_api(
        "GET", f"{URL}/api/v1/order/active/{ACC}",
        _headers=headers, _preload_content=False
    )
    body2 = await raw.data.read()
    print(f"Active orders by account: {body2.decode()[:500]}")

    # Try with market_id query param
    print("\n=== Active Orders with market_id ===")
    raw3 = await api.call_api(
        "GET", f"{URL}/api/v1/order/active/{ACC}?market_id=163",
        _headers=headers, _preload_content=False
    )
    body3 = await raw3.data.read()
    print(f"Active orders with market: {body3.decode()[:500]}")

    # Try get all orders for account (not just active)
    print("\n=== All Orders ===")
    raw4 = await api.call_api(
        "GET", f"{URL}/api/v1/order/all/{ACC}",
        _headers=headers, _preload_content=False
    )
    body4 = await raw4.data.read()
    print(f"All orders: {body4.decode()[:500]}")

    # Try orders by market
    print("\n=== Orders by Market ===")
    raw5 = await api.call_api(
        "GET", f"{URL}/api/v1/order/{ACC}?market_id=163",
        _headers=headers, _preload_content=False
    )
    body5 = await raw5.data.read()
    print(f"Orders (account+market): {body5.decode()[:500]}")

    await api.close()
    await sc.close()

asyncio.run(main())
