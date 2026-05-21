import sys, json, asyncio
from lighter import SignerClient, TransactionApi, OrderApi, ApiClient, Configuration

ACC = 725539; KEY = 7
PK = "717501be92f2c0f5ddf2f5b3a9d8962c1170119822aebc0d8f25b798d61ab068b7d9682eb30e885d"
URL = "https://mainnet.zklighter.elliot.ai"

async def main():
    api = ApiClient(Configuration(host=URL))
    order_api = OrderApi(api)

    # List all methods of OrderApi
    methods = [m for m in dir(order_api) if not m.startswith('_')]
    print("OrderApi methods:", methods)

    # Also check AccountApi
    from lighter import AccountApi
    acc_api = AccountApi(api)
    acc_methods = [m for m in dir(acc_api) if not m.startswith('_')]
    print("AccountApi methods:", acc_methods)

    # TransactionApi
    tx = TransactionApi(api)
    tx_methods = [m for m in dir(tx) if not m.startswith('_')]
    print("TransactionApi methods:", tx_methods)

    await api.close()

asyncio.run(main())
