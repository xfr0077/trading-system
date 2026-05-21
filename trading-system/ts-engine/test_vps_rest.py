import sys, json, asyncio
from lighter import SignerClient, AccountApi, ApiClient, Configuration

URL = "https://mainnet.zklighter.elliot.ai"
ACC = 725539; KEY = 7
PK = "717501be92f2c0f5ddf2f5b3a9d8962c1170119822aebc0d8f25b798d61ab068b7d9682eb30e885d"

async def main():
    api = ApiClient(Configuration(host=URL))
    sc = SignerClient(url=URL, account_index=ACC, api_private_keys={KEY: PK})
    if sc.check_client(): print("FAIL: check_client"); return
    auth, err = sc.create_auth_token_with_expiry(600)
    if err: print(f"FAIL: auth {err}"); return
    tok = str(auth)

    acct_api = AccountApi(api)
    acct = await acct_api.account(by="index", value=str(ACC), _headers={"Authorization": tok})
    acct_dict = acct.to_dict()
    acc_data = acct_dict.get("accounts", [{}])[0]

    # Print all positions
    print("=== ALL POSITIONS ===")
    for pos in acc_data.get("positions", []):
        pos_size = float(pos.get("position", 0))
        if abs(pos_size) > 0.0001:
            print(f"  {pos.get('symbol','?')}: {pos.get('position')} @ {pos.get('avg_entry_price')}"
                  f" | UPnL={pos.get('unrealized_pnl')} | liq={pos.get('liquidation_price')}"
                  f" | margin={pos.get('allocated_margin')}")
        # Also print even tiny positions
        if pos_size == 0:
            print(f"  {pos.get('symbol','?')}: ZERO position")

    # Print open orders info
    print(f"\n=== CHIP Market Info ===")
    print(f"pending_order_count: {acc_data.get('pending_order_count')}")
    print(f"total_order_count: {acc_data.get('total_order_count')}")

    # Assets
    print(f"\n=== ASSETS ===")
    for asset in acc_data.get("assets", []):
        print(f"  {json.dumps(asset, default=str)}")

    await api.close(); await sc.close()

asyncio.run(main())
