const { GrvtRawClient, GrvtEnv } = require('@wezzcoetzee/grvt');

async function checkSubAccounts() {
  const apiKey = '3DrjGEbVpPt00RNLXGA1zxTTYr7';

  const rawClient = new GrvtRawClient({
    env: GrvtEnv.TESTNET,
    apiKey,
  });

  console.log('=== Checking Sub Accounts ===\n');

  // Try different methods to get sub accounts
  try {
    // Method 1: Get all sub accounts
    const subAccounts = await rawClient.getSubAccountSummary({
      main_account_id: '0x4208e4451ad67504611bdcc6f3843c524fad3e80'
    });
    console.log('Sub Accounts:', JSON.stringify(subAccounts, null, 2));
  } catch (err) {
    console.log('getSubAccountSummary error:', err.message);
  }

  // Try to create a sub account
  console.log('\nTrying to create sub account...');
  try {
    const result = await rawClient.createSubAccount({
      main_account_id: '0x4208e4451ad67504611bdcc6f3843c524fad3e80',
      name: 'Trading Bot',
    });
    console.log('Created:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.log('createSubAccount error:', err.message);
  }

  // Check open orders without sub account
  console.log('\nTrying to get open orders...');
  try {
    const orders = await rawClient.getOpenOrders({
      main_account_id: '0x4208e4451ad67504611bdcc6f3843c524fad3e80'
    });
    console.log('Open Orders:', JSON.stringify(orders, null, 2));
  } catch (err) {
    console.log('getOpenOrders error:', err.message);
  }
}

checkSubAccounts().catch(console.error);
