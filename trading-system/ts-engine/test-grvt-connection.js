const { GrvtClient, GrvtEnv, GrvtRawClient, WebSocketTransport, buildTickerFeed } = require('@wezzcoetzee/grvt');

async function testGrvtConnection() {
  const apiKey = '3DrjGEbVpPt00RNLXGA1zxTTYr7';
  const privateKey = '0x4d359493795d49f4edb43da4146edebf37867b9300435d8b4f06410824ed719c';

  console.log('=== Testing GRVT Testnet with Community SDK ===\n');

  // Test 1: Raw Client (read data)
  console.log('1. Testing GrvtRawClient (read data)...');
  try {
    const rawClient = new GrvtRawClient({
      env: GrvtEnv.TESTNET,
      apiKey,
    });

    // Get instruments
    const instruments = await rawClient.getAllInstruments({ is_active: true });
    console.log(`   Instruments count: ${instruments.result?.length || 0}`);
    if (instruments.result?.length > 0) {
      const btc = instruments.result.find(i => i.instrument === 'BTC_USDT_Perp');
      console.log(`   BTC_USDT_Perp: ${btc ? 'Found' : 'Not found'}`);
      if (btc) console.log(`   BTC details: ${JSON.stringify(btc).substring(0, 200)}...`);
    }

    // Get ticker
    const ticker = await rawClient.getTicker({ instrument: 'BTC_USDT_Perp' });
    console.log(`   BTC ticker: last_price=${ticker.result?.last_price}`);

    console.log('   RawClient OK');
  } catch (err) {
    console.error(`   RawClient error: ${err.message}`);
  }

  // Test 2: High-level Client (trading)
  console.log('\n2. Testing GrvtClient (trading)...');
  try {
    const client = new GrvtClient({
      env: GrvtEnv.TESTNET,
      apiKey,
      tradingAccountId: '',  // Will be auto-detected
      privateKey,
    });

    // Load markets
    await client.loadMarkets();
    console.log('   Markets loaded');

    // Get account info
    try {
      const summary = await client.getAccountSummary();
      console.log(`   Account: ${JSON.stringify(summary).substring(0, 200)}...`);
    } catch (err) {
      console.log(`   Account summary: ${err.message}`);
    }

    console.log('   GrvtClient OK');
  } catch (err) {
    console.error(`   GrvtClient error: ${err.message}`);
  }

  // Test 3: WebSocket (real-time data)
  console.log('\n3. Testing WebSocket (real-time ticker)...');
  try {
    const ws = new WebSocketTransport({
      env: GrvtEnv.TESTNET,
    });

    await ws.ready();
    console.log('   WebSocket ready');

    // Subscribe to ticker
    const subscription = await ws.subscribe(
      'ticker.s',
      buildTickerFeed('BTC_USDT_Perp', '500'),
      (data) => {
        console.log(`   Ticker update: ${JSON.stringify(data).substring(0, 200)}...`);
      }
    );

    console.log('   Subscribed, waiting for data...');

    // Wait for data
    await new Promise(resolve => setTimeout(resolve, 8000));

    await subscription.unsubscribe();
    await ws.close();
    console.log('   WebSocket test complete');
  } catch (err) {
    console.error(`   WebSocket error: ${err.message}`);
  }

  console.log('\n=== Test Complete ===');
}

testGrvtConnection().catch(console.error);
