#!/usr/bin/env python3
"""
Lighter Bridge - Python process for Lighter DEX API communication.
Reads JSON commands from stdin, writes JSON responses to stdout.

Request:  {"id": N, "action": "xxx", "params": {...}}\n
Response: {"id": N, "ok": true/false, "data": ..., "error": "..."}\n
"""
import sys, json, asyncio, urllib3, time, os, signal
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

from lighter import (
    SignerClient, AccountApi, OrderApi, TransactionApi,
    ApiClient, Configuration
)

ORDER_TYPE_MAP = {"market": 1, "limit": 0, "stop_loss": 2, "stop_loss_limit": 3,
                   "take_profit": 4, "take_profit_limit": 5, "twap": 6}
TIF_MAP = {"IOC": 0, "FOK": 0, "GTT": 1, "GTC": 1, "POST_ONLY": 2}

# C6: Nonce persistence path
NONCE_FILE = "/data/bridge_nonce.json"
# C3: Auth refresh interval (8 minutes, before 10-minute expiry)
AUTH_REFRESH_INTERVAL_SEC = 8 * 60


class LighterBridge:
    def __init__(self):
        self.signer: Optional[SignerClient] = None
        self.api: Optional[ApiClient] = None
        self.account_api: Optional[AccountApi] = None
        self.order_api: Optional[OrderApi] = None
        self.tx_api: Optional[TransactionApi] = None
        self.auth_token: Optional[str] = None
        self.config: dict = {}
        self._last_nonce: Optional[int] = None
        self._auth_refresh_task: Optional[asyncio.Task] = None
        self._running = True

    def _load_nonce(self) -> Optional[int]:
        """C6: Load persisted nonce from disk"""
        try:
            if os.path.exists(NONCE_FILE):
                with open(NONCE_FILE, 'r') as f:
                    data = json.load(f)
                    return data.get("nonce")
        except:
            pass
        return None

    def _save_nonce(self, nonce: int):
        """C6: Persist nonce to disk"""
        try:
            os.makedirs(os.path.dirname(NONCE_FILE), exist_ok=True)
            with open(NONCE_FILE, 'w') as f:
                json.dump({"nonce": nonce, "updated_at": time.time()}, f)
        except Exception as e:
            sys.stderr.write(f"[Bridge] Failed to save nonce: {e}\n")

    async def _auth_refresh_loop(self):
        """C3: Periodically refresh auth token before expiry"""
        while self._running:
            await asyncio.sleep(AUTH_REFRESH_INTERVAL_SEC)
            if self._running and self.signer:
                auth, err = self.signer.create_auth_token_with_expiry(600)
                if err:
                    sys.stderr.write(f"[Bridge] Auth refresh failed: {err}\n")
                else:
                    self.auth_token = str(auth)
                    sys.stderr.write(f"[Bridge] Auth token refreshed\n")

    async def handle_init(self, params: dict) -> dict:
        self.config = params
        url = params["url"]
        account_index = int(params["account_index"])
        api_key_index = int(params.get("api_key_index", 7))
        private_key = params["api_private_key"]

        self.signer = SignerClient(
            url=url, account_index=account_index,
            api_private_keys={api_key_index: private_key},
        )
        err = self.signer.check_client()
        if err:
            return {"ok": False, "error": f"SignerClient init failed: {err}"}

        auth, auth_err = self.signer.create_auth_token_with_expiry(600)
        if auth_err:
            return {"ok": False, "error": f"Auth token failed: {auth_err}"}
        self.auth_token = str(auth)

        config = Configuration(host=url)
        self.api = ApiClient(config)
        self.account_api = AccountApi(self.api)
        self.order_api = OrderApi(self.api)
        self.tx_api = TransactionApi(self.api)

        # C6: Load persisted nonce first, then verify with chain
        persisted_nonce = self._load_nonce()
        try:
            nonce_resp = await self.tx_api.next_nonce(account_index, api_key_index)
            nd = nonce_resp.to_dict()
            chain_nonce = nd.get("nonce", 0)
            # Use the higher of persisted vs chain nonce to prevent drift
            self._last_nonce = max(chain_nonce, persisted_nonce or 0)
        except:
            self._last_nonce = persisted_nonce or 0

        # C3: Start auth refresh loop
        if self._auth_refresh_task:
            self._auth_refresh_task.cancel()
        self._auth_refresh_task = asyncio.create_task(self._auth_refresh_loop())

        # Cache market details for correct scaling
        self._market_decimals: dict = {}
        try:
            r = await self.order_api.order_book_details()
            for m in r.to_dict().get("order_book_details", []):
                mid = m.get("market_id")
                self._market_decimals[mid] = {
                    "size_dec": m.get("size_decimals", m.get("supported_size_decimals", 1)),
                    "price_dec": m.get("price_decimals", m.get("supported_price_decimals", 5)),
                }
        except:
            pass

        return {"ok": True, "data": {
            "account_index": account_index, "nonce": self._last_nonce
        }}

    async def handle_get_account(self, params: dict) -> dict:
        idx = int(params.get("account_index", self.config.get("account_index", 0)))
        try:
            r = await self.account_api.account(
                by="index", value=str(idx),
                _headers={"Authorization": self.auth_token}
            )
            d = r.to_dict()
            return {"ok": True, "data": d}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def handle_get_positions(self, params: dict) -> dict:
        idx = int(params.get("account_index", self.config.get("account_index", 0)))
        try:
            r = await self.account_api.account(
                by="index", value=str(idx),
                _headers={"Authorization": self.auth_token}
            )
            d = r.to_dict()
            positions = []
            for acc in d.get("accounts", []):
                for pos in acc.get("positions", []):
                    size = float(pos.get("position", 0))
                    if abs(size) > 1e-8:
                        positions.append(pos)
            return {"ok": True, "data": positions}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def handle_get_open_orders(self, params: dict) -> dict:
        idx = int(params.get("account_index", self.config.get("account_index", 0)))
        market_id = int(params.get("market_id", 0))
        try:
            r = await self.order_api.account_active_orders(
                idx, market_id,
                _headers={"Authorization": self.auth_token}
            )
            return {"ok": True, "data": r.to_dict().get("orders", [])}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def handle_get_inactive_orders(self, params: dict) -> dict:
        idx = int(params.get("account_index", self.config.get("account_index", 0)))
        limit = int(params.get("limit", 20))
        try:
            r = await self.order_api.account_inactive_orders(
                idx, limit,
                _headers={"Authorization": self.auth_token}
            )
            return {"ok": True, "data": r.to_dict()}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def handle_get_fills(self, params: dict) -> dict:
        idx = int(params.get("account_index", self.config.get("account_index", 0)))
        limit = int(params.get("limit", 20))
        try:
            r = await self.order_api.trades(
                idx, limit,
                _headers={"Authorization": self.auth_token}
            )
            return {"ok": True, "data": r.to_dict().get("trades", [])}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def handle_health_check(self, params: dict = {}) -> dict:
        try:
            start = time.time()
            if self.api:
                r = await self.order_api.order_books()
                latency = int((time.time() - start) * 1000)
                return {"ok": True, "data": {"healthy": True, "latency_ms": latency}}
            return {"ok": True, "data": {"healthy": False, "latency_ms": 0}}
        except Exception as e:
            return {"ok": True, "data": {"healthy": False, "latency_ms": 0, "error": str(e)}}

    async def handle_get_markets(self, params: dict = {}) -> dict:
        try:
            r = await self.order_api.order_book_details()
            return {"ok": True, "data": r.to_dict().get("order_book_details", [])}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def handle_get_recent_trades(self, params: dict) -> dict:
        market_id = int(params.get("market_id", 0))
        limit = int(params.get("limit", 20))
        try:
            r = await self.order_api.recent_trades(market_id, limit)
            return {"ok": True, "data": r.to_dict().get("trades", [])}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def handle_get_exchange_stats(self, params: dict = {}) -> dict:
        try:
            r = await self.order_api.exchange_stats()
            return {"ok": True, "data": r.to_dict().get("order_book_stats", [])}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def handle_get_mid_price(self, params: dict) -> dict:
        """C1: Get mid price from Lighter order book (best bid/ask)"""
        market_id = int(params.get("market_id", 0))
        try:
            r = await self.order_api.order_books()
            books = r.to_dict().get("order_books", [])
            for book in books:
                if book.get("market_id") == market_id or book.get("market_index") == market_id:
                    bids = book.get("bids", [])
                    asks = book.get("asks", [])
                    if bids and asks:
                        best_bid = float(bids[0].get("price", 0))
                        best_ask = float(asks[0].get("price", 0))
                        mid = (best_bid + best_ask) / 2
                        return {"ok": True, "data": {
                            "market_id": market_id,
                            "mid_price": mid,
                            "best_bid": best_bid,
                            "best_ask": best_ask,
                            "spread": best_ask - best_bid,
                        }}
                    elif bids:
                        price = float(bids[0].get("price", 0))
                        return {"ok": True, "data": {
                            "market_id": market_id,
                            "mid_price": price,
                            "best_bid": price,
                            "best_ask": price,
                            "spread": 0,
                        }}
                    elif asks:
                        price = float(asks[0].get("price", 0))
                        return {"ok": True, "data": {
                            "market_id": market_id,
                            "mid_price": price,
                            "best_bid": price,
                            "best_ask": price,
                            "spread": 0,
                        }}
            return {"ok": False, "error": f"No order book found for market {market_id}"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def handle_get_position_funding(self, params: dict) -> dict:
        idx = int(params.get("account_index", self.config.get("account_index", 0)))
        limit = int(params.get("limit", 10))
        try:
            r = await self.account_api.position_funding(
                idx, limit,
                _headers={"Authorization": self.auth_token}
            )
            return {"ok": True, "data": r.to_dict().get("position_fundings", [])}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def handle_submit_order(self, params: dict) -> dict:
        if not self.signer or not self.config:
            return {"ok": False, "error": "Not initialized"}
        try:
            idx = int(params.get("account_index", self.config.get("account_index", 0)))
            api_key_idx = int(params.get("api_key_index", self.config.get("api_key_index", 7)))
            market_index = int(params["market_index"])
            client_order_index = int(params["client_order_index"])
            is_ask = int(params["is_ask"])
            order_type = params.get("order_type", 0)
            if isinstance(order_type, str):
                order_type = ORDER_TYPE_MAP.get(order_type, 0)
            else:
                order_type = int(order_type)
            time_in_force = int(params.get("time_in_force", 0))
            reduce_only = int(params.get("reduce_only", 0))

            # C6: Re-fetch nonce from chain before each order to prevent drift
            try:
                nonce_resp = await self.tx_api.next_nonce(idx, api_key_idx)
                chain_nonce = nonce_resp.to_dict().get("nonce", 0)
                self._last_nonce = max(chain_nonce, self._last_nonce or 0)
            except:
                pass  # fall through with in-memory nonce

            # Get market decimals for scaling
            dec = self._market_decimals.get(market_index, {"size_dec": 1, "price_dec": 5})
            size_mult = 10 ** dec["size_dec"]
            price_mult = 10 ** dec["price_dec"]

            raw_base = params["base_amount"]
            raw_price = params.get("price", 0)
            if isinstance(raw_base, str):
                raw_base = float(raw_base)
            if isinstance(raw_price, str):
                raw_price = float(raw_price)
            base_amount = int(raw_base * size_mult)
            price = int(raw_price * price_mult)

            # For market orders, use create_market_order (handles IOC + price fetching)
            if order_type == 1:  # MARKET
                best_price = await self.signer.get_best_price(market_index, is_ask=bool(is_ask))
                result = await self.signer.create_market_order(
                    market_index=market_index,
                    client_order_index=client_order_index,
                    base_amount=base_amount,
                    avg_execution_price=best_price,
                    is_ask=bool(is_ask),
                    reduce_only=bool(reduce_only),
                    nonce=self._last_nonce or 0,
                    api_key_index=api_key_idx,
                )
                if result[2]:
                    return {"ok": False, "error": result[2]}
                _, resp, _ = result
                rd = resp.to_dict()
                if self._last_nonce is not None:
                    self._last_nonce += 1
                    self._save_nonce(self._last_nonce)
                return {"ok": True, "data": {"tx_hash": rd.get("tx_hash"), "code": rd.get("code")}}

            # Limit order: sign + send
            tx_type, tx_info, tx_hash, error = self.signer.sign_create_order(
                market_index=market_index,
                client_order_index=client_order_index,
                base_amount=base_amount,
                price=price,
                is_ask=is_ask,
                order_type=order_type,
                time_in_force=time_in_force,
                reduce_only=reduce_only,
                order_expiry=0,
                nonce=self._last_nonce or 0,
                api_key_index=api_key_idx,
            )
            if error:
                return {"ok": False, "error": error}

            send_resp = await self.tx_api.send_tx(
                tx_type=int(tx_type), tx_info=tx_info,
                _headers={"Authorization": self.auth_token}
            )

            resp = {"tx_hash": send_resp.tx_hash, "code": send_resp.code}
            if send_resp.additional_properties:
                resp.update(send_resp.additional_properties)

            if self._last_nonce is not None:
                self._last_nonce += 1
                self._save_nonce(self._last_nonce)

            return {"ok": True, "data": resp}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def handle_cancel_order(self, params: dict) -> dict:
        if not self.signer:
            return {"ok": False, "error": "Not initialized"}
        try:
            api_key_idx = int(params.get("api_key_index", self.config.get("api_key_index", 7)))
            idx = int(params.get("account_index", self.config.get("account_index", 0)))
            market_index = int(params.get("market_index", 0))
            order_index = int(params["order_index"])

            tx_type, tx_info, tx_hash, error = self.signer.sign_cancel_order(
                market_index=market_index,
                order_index=order_index,
                api_key_index=api_key_idx,
            )
            if error:
                return {"ok": False, "error": error}

            send_resp = await self.tx_api.send_tx(
                tx_type=int(tx_type), tx_info=tx_info,
                _headers={"Authorization": self.auth_token}
            )

            if self._last_nonce is not None:
                self._last_nonce += 1
                self._save_nonce(self._last_nonce)

            return {"ok": True, "data": {
                "tx_hash": send_resp.tx_hash, "code": send_resp.code
            }}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def handle_get_nonce(self, params: dict) -> dict:
        idx = int(params.get("account_index", self.config.get("account_index", 0)))
        api_key_idx = int(params.get("api_key_index", self.config.get("api_key_index", 7)))
        try:
            r = await self.tx_api.next_nonce(idx, api_key_idx)
            nd = r.to_dict()
            self._last_nonce = nd.get("nonce", 0)
            return {"ok": True, "data": nd}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def handle_refresh_auth(self, params: dict = {}) -> dict:
        if not self.signer:
            return {"ok": False, "error": "Not initialized"}
        auth, err = self.signer.create_auth_token_with_expiry(600)
        if err:
            return {"ok": False, "error": str(err)}
        self.auth_token = str(auth)
        return {"ok": True, "data": {"refreshed": True}}


async def run_bridge():
    loop = asyncio.get_event_loop()
    bridge = LighterBridge()
    executor = ThreadPoolExecutor(max_workers=1)

    handlers = {}
    for name in dir(bridge):
        if name.startswith("handle_"):
            action = name[7:]
            handlers[action] = getattr(bridge, name)

    # H8: Graceful shutdown on SIGTERM/SIGINT
    def handle_signal(signum, frame):
        bridge._running = False
        if bridge._auth_refresh_task:
            bridge._auth_refresh_task.cancel()
        sys.stderr.write(f"[Bridge] Received signal {signum}, shutting down\n")

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    while bridge._running:
        try:
            line = await asyncio.wait_for(
                loop.run_in_executor(executor, sys.stdin.readline),
                timeout=30.0
            )
        except asyncio.TimeoutError:
            continue
        except:
            break

        if not line:
            break

        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            continue

        req_id = msg.get("id", 0)
        action = msg.get("action", "")
        params = msg.get("params", {})

        handler = handlers.get(action)
        if not handler:
            result = {"ok": False, "error": f"Unknown action: {action}"}
        else:
            try:
                result = await handler(params)
            except Exception as e:
                result = {"ok": False, "error": str(e)}

        resp = {"id": req_id, **result}
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    # Cleanup
    bridge._running = False
    if bridge._auth_refresh_task:
        bridge._auth_refresh_task.cancel()
    executor.shutdown(wait=False)


if __name__ == "__main__":
    asyncio.run(run_bridge())
