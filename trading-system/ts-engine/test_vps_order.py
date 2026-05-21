import sys, json, asyncio
from lighter import SignerClient, OrderApi, AccountApi, ApiClient, Configuration

ACC = 725539; KEY = 7
PK = "717501be92f2c0f5ddf2f5b3a9d8962c1170119822aebc0d8f25b798d61ab068b7d9682eb30e885d"
URL = "https://mainnet.zklighter.elliot.ai"

async def main():
    sc = SignerClient(url=URL, account_index=ACC, api_private_keys={KEY: PK})
    if sc.check_client(): print("FAIL: check_client"); return

    auth, err = sc.create_auth_token_with_expiry(600)
    if err: print(f"FAIL: auth {err}"); return
    tok = str(auth)

    # Get current nonce
    n = await sc.tx_api.next_nonce(ACC, KEY)
    nonce = n.to_dict().get("nonce", 0) or 1
    print(f"Nonce: {nonce}")

    # Get best price
    best = await sc.get_best_price(163, is_ask=0)  # BUY = get ask price
    print(f"Best ask (raw): {best} = {best/100000:.5f} USDC")

    # Use create_market_order (SDK high-level method)
    cid = int(__import__("time").time() * 1000) % 10000000000
    print(f"\n=== MARKET BUY 10 CHIP via create_market_order ===")
    
    result = await sc.create_market_order(
        market_index=163,
        client_order_index=cid,
        base_amount=100,  # 10.0 CHIP
        avg_execution_price=best,
        is_ask=0,  # BUY
        reduce_only=False,
        nonce=nonce,
        api_key_index=KEY,
    )
    
    if result[2]:  # error
        print(f"ERROR: {result[2]}")
    else:
        create_order, resp, _ = result
        print(f"Order submitted! type={type(create_order).__name__}")
        print(f"Resp: {json.dumps(resp.to_dict(), default=str)[:300]}")

        # Wait and check
        await asyncio.sleep(10)
        tx_hash = resp.to_dict().get("tx_hash", "")
        if tx_hash:
            info = await sc.tx_api.tx(by="hash", value=tx_hash, _headers={"Authorization": tok})
            t = info.to_dict()
            ei = json.loads(t.get("event_info", "{}"))
            to = ei.get("to", {})
            st = to.get('st')
            status_names = {0:'InProgress',1:'Pending',2:'ActiveLimit',3:'Filled',4:'Canceled',
                            9:'TooMuchSlippage',10:'NotEnoughLiquidity'}
            print(f"\nResult: st={st} ({status_names.get(st,'Unknown')}), rs={to.get('rs')}")

        # Check positions
        acct = await sc.account_api.account(by="index", value=str(ACC), _headers={"Authorization": tok})
        print(f"\nCHIP positions:")
        for pos in acct.to_dict().get("accounts", [{}])[0].get("positions", []):
            if "CHIP" in str(pos.get("symbol", "")):
                print(f"  {pos.get('symbol')}: {pos.get('position')} @ {pos.get('avg_entry_price')}")

    await sc.close()

asyncio.run(main())
