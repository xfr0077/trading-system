// Mock for @wezzcoetzee/grvt - used in local tests where ESM modules can't be parsed by Jest

export const GrvtEnv = {
  DEV: 'dev',
  STG: 'stg',
  TESTNET: 'testnet',
  PROD: 'prod',
};

export class GrvtRawClient {
  constructor(_config: any) {}
  async getAllInstruments(_params: any) { return { result: [] }; }
  async getTicker(_params: any) { return { result: { last_price: '50000' } }; }
  async getFundingAccountSummary() { return { result: { main_account_id: '0xtest' } }; }
  async getSubAccountSummary(_params: any) { return { result: [] }; }
  async getOpenOrders(_params: any) { return { result: [] }; }
  async createOrder(_payload: any) { return { result: { order_id: 'test-order' } }; }
  async cancelOrder(_params: any) { return { result: {} }; }
}

export class GrvtClient {
  constructor(_config: any) {}
  async loadMarkets() {}
  async createOrder(_symbol: string, _type: string, _side: string, _amount: number, _price?: number, _params?: any) {
    return { id: 'test-order' };
  }
  async cancelOrder(_id: string) { return {}; }
  async fetchOpenOrders() { return []; }
  async getAccountSummary() { return {}; }
  get tdgClient() { return new GrvtRawClient({}); }
}

export class WebSocketTransport {
  constructor(_config: any) {}
  async ready() {}
  async close() {}
  onConnect(_cb: () => void) {}
  onClose(_cb: () => void) {}
  onError(_cb: (err: any) => void) {}
  subscribe(_channel: string, _params: any, _cb: (data: any) => void) {
    return { unsubscribe: async () => {} };
  }
}

export function buildTickerFeed(_symbol: string, _interval: string) { return {}; }
export function buildTradeFeed(_symbol: string) { return {}; }
export function buildOrderbookFeed(_symbol: string, _depth: number) { return {}; }
