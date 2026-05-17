const { GrvtClient, GrvtEnv, GrvtRawClient } = require('@wezzcoetzee/grvt');

async function getAccountInfo() {
  const apiKey = '3DrjGEbVpPt00RNLXGA1zxTTYr7';
  const privateKey = '0x4d359493795d49f4edb43da4146edebf37867b9300435d8b4f06410824ed719c';

  console.log('=== Getting Account Info ===\n');

  // Method 1: Use GrvtRawClient to get account info
  console.log('1. Using GrvtRawClient...');
  try {
    const rawClient = new GrvtRawClient({
      env: GrvtEnv.TESTNET,
      apiKey,
    });

    // Get account summary
    const summary = await rawClient.getFundingAccountSummary();
    console.log(`   Funding Account: ${JSON.stringify(summary, null, 2)}`);

    // Get sub accounts
    const subAccounts = await rawClient.getSubAccountSummary({});
    console.log(`   Sub Accounts: ${JSON.stringify(subAccounts, null, 2)}`);

  } catch (err) {
    console.error(`   Error: ${err.message}`);
    console.error(`   Stack: ${err.stack}`);
  }

  // Method 2: Use GrvtClient
  console.log('\n2. Using GrvtClient...');
  try {
    const client = new GrvtClient({
      env: GrvtEnv.TESTNET,
      apiKey,
      privateKey,
    });

    await client.loadMarkets();

    // Try to get account info
    try {
      const summary = await client.getAccountSummary();
      console.log(`   Account Summary: ${JSON.stringify(summary, null, 2)}`);
    } catch (err) {
      console.log(`   getAccountSummary: ${err.message}`);
    }

    // Try open orders
    try {
      const orders = await client.fetchOpenOrders();
      console.log(`   Open Orders: ${orders.length} orders`);
    } catch (err) {
      console.log(`   fetchOpenOrders: ${err.message}`);
    }

    // Try balance
    try {
      const balance = await client.fetchBalance();
      console.log(`   Balance: ${JSON.stringify(balance, null, 2)}`);
    } catch (err) {
      console.log(`   fetchBalance: ${err.message}`);
    }

  } catch (err) {
    console.error(`   Error: ${err.message}`);
  }

  console.log('\n=== Complete ===');
}

getAccountInfo().catch(console.error);
