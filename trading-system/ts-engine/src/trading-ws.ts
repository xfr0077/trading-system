import { EGrvtEnvironment } from '@grvt/sdk';
import { ethers } from 'ethers';
import axios from 'axios';
import * as setCookieParser from 'set-cookie-parser';
import { OrderUpdate } from './types';
import { Order } from './sqlite-store';

export interface GrvtConfig {
  apiKey: string;
  privateKey: string;
  tradingAccountId: string;
  env: EGrvtEnvironment;
}

interface CookieData {
  gravity: string;
  expires: number;
  XGrvtAccountId?: string;
}

function getEdgeBaseUrl(env: EGrvtEnvironment): string {
  const domains: Record<EGrvtEnvironment, string> = {
    [EGrvtEnvironment.PRODUCTION]: 'grvt.io',
    [EGrvtEnvironment.TESTNET]: 'testnet.grvt.io',
    [EGrvtEnvironment.STAGING]: 'staging.gravitymarkets.io',
    [EGrvtEnvironment.DEV]: 'dev.gravitymarkets.io',
  };
  return `https://edge.${domains[env]}`;
}

export async function configureProxy(): Promise<void> {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  if (proxyUrl) {
    const url = new URL(proxyUrl);
    axios.defaults.proxy = {
      host: url.hostname,
      port: parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80),
      protocol: url.protocol.replace(':', ''),
    };
    console.log(`[TradingWS] Using HTTP proxy: ${proxyUrl}`);
  }
}

async function fetchCookie(apiKey: string, env: EGrvtEnvironment): Promise<CookieData> {
  const path = getEdgeBaseUrl(env) + '/auth/api_key/login';
  const response = await axios.post(path, { api_key: apiKey }, {
    validateStatus: () => true,
  } as any);

  const bodyText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Cookie fetch failed: ${response.status} ${response.statusText} — ${bodyText}`);
  }

  const cookieHeader = response.headers['set-cookie'];
  const accountId = response.headers['x-grvt-account-id'];

  if (!cookieHeader) {
    throw new Error(`No cookie header in response — GRVT returned: ${bodyText}`);
  }

  const cookieStr = Array.isArray(cookieHeader) ? cookieHeader.join(', ') : cookieHeader;
  const cookies = setCookieParser.parse(cookieStr);
  const gravityCookie = cookies.find((c) => c.name === 'gravity');

  if (!gravityCookie || !gravityCookie.expires) {
    throw new Error('Invalid gravity cookie');
  }

  return {
    gravity: gravityCookie.value,
    expires: gravityCookie.expires.getTime() / 1000,
    XGrvtAccountId: (Array.isArray(accountId) ? accountId[0] : accountId) || undefined,
  };
}

export class TradingWebSocket {
  private cookie: string | null = null;
  private accountId: string | null = null;
  private wallet: ethers.Wallet | null = null;
  private orderCallbacks: Array<(update: OrderUpdate) => void> = [];
  private config: GrvtConfig | null = null;
  private instrumentHash = '0x030501';
  private instruments: Record<string, { instrumentHash: string; baseDecimals: number }> = {};

  async connect(config: GrvtConfig): Promise<void> {
    this.config = config;

    const cookieData = await fetchCookie(config.apiKey, config.env);
    this.cookie = cookieData.gravity;
    this.wallet = new ethers.Wallet(config.privateKey);
    this.accountId = cookieData.XGrvtAccountId || config.tradingAccountId;

    console.log(`[TradingWS] Connected, account: ${this.accountId} (cfg: ${config.tradingAccountId})`);
  }

  addInstrument(symbol: string, instrumentHash: string, baseDecimals: number): void {
    this.instruments[symbol] = { instrumentHash, baseDecimals };
  }

  async getInstruments(): Promise<Array<{ symbol: string; instrument_hash: string; base_decimals?: number; status: string }>> {
    if (!this.config) return [];

    const marketDataUrl = this.getMarketDataUrl(this.config.env);

    try {
      const response = await axios.post(
        `${marketDataUrl}/full/v1/all_instruments`,
        { is_active: true },
        { headers: { 'Content-Type': 'application/json' } } as any
      );
      const instruments = Array.isArray(response.data?.result) ? response.data.result : [];
      return instruments.map((inst: any) => ({
        symbol: inst.instrument,
        instrument_hash: inst.instrument_hash,
        base_decimals: inst.base_decimals,
        status: 'active',
      }));
    } catch (err) {
      console.error('[TradingWS] Get instruments failed:', err);
      return [];
    }
  }

  async submitOrder(order: Order): Promise<string> {
    if (!this.cookie || !this.wallet) {
      throw new Error('TradingWS not connected');
    }

    const currentTime = Date.now();
    const expirationNs = (BigInt(currentTime) + BigInt(3600 * 1000)) * 1000000n;
    const nonce = Math.floor(Math.random() * 1e9);
    const clientOrderId = (BigInt(Date.now()) << BigInt(10)) | BigInt(Math.floor(Math.random() * 1024));

    const instrumentHash = this.instruments[order.symbol]?.instrumentHash || this.instrumentHash;
    const baseDecimals = this.instruments[order.symbol]?.baseDecimals || 9;

    const domain = {
      name: 'GRVT Exchange',
      version: '0',
      chainId: this.config?.env === EGrvtEnvironment.TESTNET ? 326 : 325,
    };

    const types = {
      Order: [
        { name: 'subAccountID', type: 'uint64' },
        { name: 'isMarket', type: 'bool' },
        { name: 'timeInForce', type: 'uint8' },
        { name: 'postOnly', type: 'bool' },
        { name: 'reduceOnly', type: 'bool' },
        { name: 'legs', type: 'OrderLeg[]' },
        { name: 'nonce', type: 'uint32' },
        { name: 'expiration', type: 'int64' },
      ],
      OrderLeg: [
        { name: 'assetID', type: 'uint256' },
        { name: 'contractSize', type: 'uint64' },
        { name: 'limitPrice', type: 'uint64' },
        { name: 'isBuyingContract', type: 'bool' },
      ],
    };

    const isMarket = order.orderType === 'market';
    const size = parseFloat(order.size);
    const price = isMarket ? 0 : parseFloat(order.limitPrice);

    const message = {
      subAccountID: BigInt(this.config!.tradingAccountId),
      isMarket,
      timeInForce: 1,
      postOnly: false,
      reduceOnly: false,
      legs: [{
        assetID: BigInt(instrumentHash),
        contractSize: BigInt(Math.round(size * (10 ** baseDecimals))),
        limitPrice: BigInt(Math.round(price * 1e9)),
        isBuyingContract: order.side === 'buy',
      }],
      nonce,
      expiration: expirationNs,
    };

    const signature = await this.wallet.signTypedData(domain, types, message);
    const sig = ethers.Signature.from(signature);

    const payload = {
      order: {
        sub_account_id: this.config!.tradingAccountId,
        is_market: isMarket,
        time_in_force: 'GOOD_TILL_TIME',
        post_only: false,
        reduce_only: false,
        legs: [{
          instrument: order.symbol,
          size: order.size,
          limit_price: isMarket ? '0' : order.limitPrice,
          is_buying_asset: order.side === 'buy',
        }],
        signature: {
          signer: this.wallet.address.toLowerCase(),
          r: sig.r,
          s: sig.s,
          v: sig.v,
          expiration: expirationNs.toString(),
          nonce,
          chain_id: domain.chainId.toString(),
        },
        metadata: {
          client_order_id: clientOrderId.toString(),
          create_time: (BigInt(currentTime) * 1000000n).toString(),
        },
      },
    };

    console.log(`[TradingWS] Submitting order: ${order.clientOrderId} (${order.side} ${order.size} ${order.symbol} @ ${order.limitPrice})`);

    const tradesUrl = this.getTradesUrl(this.config!.env);

    try {
      const response = await axios.post(
        `${tradesUrl}/full/v1/create_order`,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Cookie': `gravity=${this.cookie}`,
            'X-Grvt-Account-Id': this.accountId,
          },
        }
      );

      const orderId = response.data.result?.order_id || order.clientOrderId;
      console.log(`[TradingWS] Order submitted: ${orderId}`);
      return orderId;
    } catch (err: any) {
      console.error('[TradingWS] Order submission failed:', err.response?.data || err.message);
      throw err;
    }
  }

  async cancelOrder(exchangeOrderId: string): Promise<void> {
    if (!this.cookie) {
      throw new Error('TradingWS not connected');
    }

    const tradesUrl = this.getTradesUrl(this.config!.env);

    try {
      await axios.post(
        `${tradesUrl}/full/v1/cancel_order`,
        {
          sub_account_id: this.config!.tradingAccountId,
          client_order_id: exchangeOrderId,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Cookie': `gravity=${this.cookie}`,
            'X-Grvt-Account-Id': this.accountId,
          },
        }
      );
      console.log(`[TradingWS] Cancelled order: ${exchangeOrderId}`);
    } catch (err: any) {
      if (err.response?.data?.code === 2013 || err.response?.data?.message?.includes('not found')) {
        console.log(`[TradingWS] Order ${exchangeOrderId} already completed, skip cancel`);
        return;
      }
      console.error('[TradingWS] Cancel failed:', err.response?.data || err.message);
      throw err;
    }
  }

  async getOpenOrders(): Promise<any[]> {
    if (!this.cookie) {
      throw new Error('TradingWS not connected');
    }

    const tradesUrl = this.getTradesUrl(this.config!.env);

    try {
      const response = await axios.post(
        `${tradesUrl}/full/v1/open_orders`,
        { sub_account_id: this.config!.tradingAccountId },
        {
          headers: {
            'Content-Type': 'application/json',
            'Cookie': `gravity=${this.cookie}`,
            'X-Grvt-Account-Id': this.accountId,
          },
        } as any
      );
      return response.data.result?.orders || [];
    } catch (err) {
      console.error('[TradingWS] Get open orders failed:', err);
      return [];
    }
  }

  async getPositions(): Promise<any[]> {
    if (!this.cookie) {
      throw new Error('TradingWS not connected');
    }

    const tradesUrl = this.getTradesUrl(this.config!.env);

    try {
      const response = await axios.post(
        `${tradesUrl}/full/v1/positions`,
        { sub_account_id: this.config!.tradingAccountId },
        {
          headers: {
            'Content-Type': 'application/json',
            'Cookie': `gravity=${this.cookie}`,
            'X-Grvt-Account-Id': this.accountId,
          },
        } as any
      );
      return response.data.result?.positions || [];
    } catch (err) {
      console.error('[TradingWS] Get positions failed:', err);
      return [];
    }
  }

  async getFills(clientOrderId?: string): Promise<any[]> {
    if (!this.cookie) {
      throw new Error('TradingWS not connected');
    }

    const tradesUrl = this.getTradesUrl(this.config!.env);

    try {
      const params: any = { sub_account_id: this.config!.tradingAccountId };
      if (clientOrderId) {
        params.client_order_id = clientOrderId;
      }
      const response = await axios.post(
        `${tradesUrl}/full/v1/fills`,
        params,
        {
          headers: {
            'Content-Type': 'application/json',
            'Cookie': `gravity=${this.cookie}`,
            'X-Grvt-Account-Id': this.accountId,
          },
        } as any
      );
      return response.data.result?.fills || [];
    } catch (err) {
      console.error('[TradingWS] Get fills failed:', err);
      return [];
    }
  }

  onOrderUpdate(callback: (update: OrderUpdate) => void): void {
    this.orderCallbacks.push(callback);
  }

  emitTestUpdate(update: OrderUpdate): void {
    for (const cb of this.orderCallbacks) {
      cb(update);
    }
  }

  mapGrvtStatus(grvtStatus: string): OrderUpdate['status'] {
    const statusMap: Record<string, OrderUpdate['status']> = {
      'FILLED': 'filled',
      'CANCELLED': 'cancelled',
      'REJECTED': 'rejected',
      'PENDING': 'pending',
      'PARTIALLY_FILLED': 'partially_filled',
      'SUBMITTED': 'submitted',
    };
    return statusMap[grvtStatus] || 'pending';
  }

  disconnect(): void {
    this.cookie = null;
    this.wallet = null;
  }

  private getTradesUrl(env: EGrvtEnvironment): string {
    const urls: Record<EGrvtEnvironment, string> = {
      [EGrvtEnvironment.PRODUCTION]: 'https://trades.grvt.io',
      [EGrvtEnvironment.TESTNET]: 'https://trades.testnet.grvt.io',
      [EGrvtEnvironment.STAGING]: 'https://trades.staging.gravitymarkets.io',
      [EGrvtEnvironment.DEV]: 'https://trades.dev.gravitymarkets.io',
    };
    return urls[env] || urls[EGrvtEnvironment.TESTNET];
  }

  private getMarketDataUrl(env: EGrvtEnvironment): string {
    const urls: Record<EGrvtEnvironment, string> = {
      [EGrvtEnvironment.PRODUCTION]: 'https://market-data.grvt.io',
      [EGrvtEnvironment.TESTNET]: 'https://market-data.testnet.grvt.io',
      [EGrvtEnvironment.STAGING]: 'https://market-data.staging.gravitymarkets.io',
      [EGrvtEnvironment.DEV]: 'https://market-data.dev.gravitymarkets.io',
    };
    return urls[env] || urls[EGrvtEnvironment.TESTNET];
  }
}
