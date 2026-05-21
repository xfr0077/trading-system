import sys, json, asyncio
from lighter import SignerClient, TransactionApi, OrderApi, AccountApi, ApiClient, Configuration

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

    tx = TransactionApi(api)
    order_api = OrderApi(api)

    # Try to cancel the order from the previous test (order_index from event_info)
    order_index = 46443371137613665
    print(f"1. Attempting to cancel order_index={order_index}...")

    n = await tx.next_nonce(ACC, KEY)
    nonce = n.to_dict().get("nonce", 0) or 1
    print(f"   nonce={nonce}")

    tx2, info2, h2, e2 = sc.sign_cancel_order(
        market_index=163, order_index=order_index,
        nonce=nonce, api_key_index=KEY,
    )
    if e2:
        print(f"   Cancel sign error: {e2}")
    else:
        send2 = await tx.send_tx(tx_type=int(tx2), tx_info=info2, _headers={"Authorization": tok})
        d2 = send2.to_dict()
        print(f"   Cancel result: {json.dumps(d2, default=str)[:500]}")
        code = d2.get("code", 0)
        if code == 200:
            print("   ✅ CANCEL TX SUBMITTED")
        else:
            print(f"   Cancel returned code={code}")

    # Now let's check a recent order that IS active
    print(f"\n2. Current BTC/CHIP positions from account endpoint...")
    acct = await AccountApi(api).account(by="index", value=str(ACC), _headers={"Authorization": tok})
    acct_dict = acct.to_dict()
    print(f"   {json.dumps(acct_dict, default=str)[:1000]}")

    # Check recent fills to see if any orders went through
    print(f"\n3. Recent trades...")
    trades = await order_api.recent_trades(163, _headers={"Authorization": tok})
    trades_dict = trades.to_dict()
    print(f"   {json.dumps(trades_dict, default=str)[:500]}")

    await api.close(); await sc.close()

asyncio.run(main())
