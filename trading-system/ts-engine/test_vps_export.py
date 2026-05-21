import sys, json, asyncio
from lighter import SignerClient, TransactionApi, OrderApi, AccountApi, ApiClient, Configuration

ACC = 725539
URL = "https://mainnet.zklighter.elliot.ai"

async def main():
    api = ApiClient(Configuration(host=URL))

    # Try export with different params
    oa = OrderApi(api)

    # Export without auth
    print("1. Export (no auth):")
    try:
        ex = await oa.export("orders", account_index=ACC, market_id=163)
        print(f"   {json.dumps(ex.to_dict(), default=str)[:300]}")
    except Exception as e:
        print(f"   Error: {str(e)[:200]}")

    # Order book details
    print("\n2. Order book details:")
    obd = await oa.order_book_details(market_id=163)
    print(f"   {json.dumps(obd.to_dict(), default=str)[:500]}")

    # Exchange stats
    print("\n3. Exchange stats:")
    es = await oa.exchange_stats(market_id=163)
    print(f"   {json.dumps(es.to_dict(), default=str)[:500]}")

    await api.close()

asyncio.run(main())
