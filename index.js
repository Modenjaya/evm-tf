const { ethers } = require("ethers");
const colors = require("colors");
const fs = require("fs");
const readlineSync = require("readline-sync");

const checkBalance = require("./src/checkBalance");
const displayHeader = require("./src/displayHeader");
const sleep = require("./src/sleep");
const { loadChains, selectChain, selectNetworkType } = require("./src/chainUtils");

const MAX_RETRIES = 3;
const RETRY_DELAY = 3000;

async function retry(fn, maxRetries = MAX_RETRIES, delay = RETRY_DELAY) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      console.log(colors.yellow(`⚠️ Error occurred. Retrying... (${i + 1}/${maxRetries})`));
      await sleep(delay);
    }
  }
}

// Helper function untuk mendapatkan gas price dengan buffer
async function getGasPrice(provider, manualGwei = null, bufferPercent = 5) {
    try {
        if (manualGwei !== null) {
            const baseGasPrice = ethers.parseUnits(manualGwei.toString(), "gwei");
            return baseGasPrice * BigInt(100 + bufferPercent) / BigInt(100);
        }
        const feeData = await provider.getFeeData();
        return feeData.gasPrice * BigInt(100 + bufferPercent) / BigInt(100);
    } catch (error) {
        console.log(colors.yellow(`⚠️ Error getting gas price: ${error.message}`));
        return ethers.parseUnits("0.1", "gwei");
    }
}

const main = async () => {
  displayHeader();

  const networkType = selectNetworkType();
  const chains = loadChains(networkType);
  const selectedChain = selectChain(chains);

  console.log(colors.green(`✅ You have selected: ${selectedChain.name}`));
  console.log(colors.green(`🛠 RPC URL: ${selectedChain.rpcUrl}`));
  console.log(colors.green(`🔗 Chain ID: ${selectedChain.chainId}`));

  const provider = new ethers.JsonRpcProvider(selectedChain.rpcUrl);

  const privateKeys = JSON.parse(fs.readFileSync("privateKeys.json"));

  const transactionCount = readlineSync.questionInt(
    "Enter the number of transactions you want to send for each address: "
  );

  // Input gas price manual
  const useManualGas = readlineSync.keyInYN("Do you want to set gas price manually?");
  let manualGwei = null;
    
  if (useManualGas) {
      manualGwei = readlineSync.questionFloat("Enter gas price in Gwei (e.g., 0.1): ");
      console.log(colors.green(`Setting gas price to ${manualGwei} Gwei (+ 5% buffer)`));
  }

  // Input gas limit manual
  const useManualGasLimit = readlineSync.keyInYN("Do you want to set gas limit manually?");
  let manualGasLimit = 21000; // Default gas limit

  if (useManualGasLimit) {
      manualGasLimit = readlineSync.questionInt("Enter gas limit (default is 21000): ");
      console.log(colors.green(`Setting gas limit to ${manualGasLimit}`));
  }

  for (const privateKey of privateKeys) {
    const wallet = new ethers.Wallet(privateKey, provider);
    const senderAddress = wallet.address;

    console.log(colors.cyan(`💼 Processing transactions for address: ${senderAddress}`));

    let senderBalance;
    try {
      senderBalance = await retry(() => checkBalance(provider, senderAddress));
    } catch (error) {
      console.log(
        colors.red(`❌ Failed to check balance for ${senderAddress}. Skipping to next address.`)
      );
      continue;
    }

    if (senderBalance < ethers.parseUnits("0.0001", "ether")) {
      console.log(colors.red("❌ Insufficient or zero balance. Skipping to next address."));
      continue;
    }

    let continuePrintingBalance = true;
    const printSenderBalance = async () => {
      while (continuePrintingBalance) {
        try {
          senderBalance = await retry(() => checkBalance(provider, senderAddress));
          console.log(
            colors.blue(
              `💰 Current Balance: ${ethers.formatUnits(senderBalance, "ether")} ${
                selectedChain.symbol
              }`
            )
          );
          if (senderBalance < ethers.parseUnits("0.0001", "ether")) {
            console.log(colors.red("❌ Insufficient balance for transactions."));
            continuePrintingBalance = false;
          }
        } catch (error) {
          console.log(colors.red(`❌ Failed to check balance: ${error.message}`));
        }
        await sleep(5000);
      }
    };

    // Start balance printing in background
    printSenderBalance();

    for (let i = 1; i <= transactionCount; i++) {
      const receiverWallet = ethers.Wallet.createRandom();
      const receiverAddress = receiverWallet.address;
      console.log(colors.white(`\n🆕 Generated address ${i}: ${receiverAddress}`));

      const amountToSend = ethers.parseUnits(
        (Math.random() * (0.0000001 - 0.00000001) + 0.00000001).toFixed(10).toString(),
        "ether"
      );

      // Get gas price with buffer
      let gasPrice;
      try {
        gasPrice = await retry(() => getGasPrice(provider, manualGwei));
      } catch (error) {
        console.log(colors.red("❌ Failed to fetch gas price from the network."));
        continue;
      }

      // Prepare legacy transaction with manual gas limit
      const transaction = {
        to: receiverAddress,
        value: amountToSend,
        gasLimit: manualGasLimit,
        gasPrice: gasPrice,
        nonce: await wallet.getNonce(),
        chainId: parseInt(selectedChain.chainId),
      };

      let tx;
      try {
        tx = await retry(() => wallet.sendTransaction(transaction));
      } catch (error) {
        console.log(colors.red(`❌ Failed to send transaction: ${error.message}`));
        // If error contains "replacement fee too low", try with higher gas price
        if (error.message.includes("replacement fee too low")) {
          try {
            gasPrice = gasPrice * BigInt(120) / BigInt(100); // Increase by 20%
            transaction.gasPrice = gasPrice;
            tx = await wallet.sendTransaction(transaction);
          } catch (retryError) {
            console.log(colors.red(`❌ Failed retry with higher gas: ${retryError.message}`));
            continue;
          }
        } else {
          continue;
        }
      }

      // Log transaction details
      console.log(colors.white(`🔗 Transaction ${i}:`));
      console.log(colors.white(`  Hash: ${colors.green(tx.hash)}`));
      console.log(colors.white(`  From: ${colors.green(senderAddress)}`));
      console.log(colors.white(`  To: ${colors.green(receiverAddress)}`));
      console.log(
        colors.white(
          `  Amount: ${colors.green(ethers.formatUnits(amountToSend, "ether"))} ${
            selectedChain.symbol
          }`
        )
      );
      console.log(
        colors.white(`  Gas Price: ${colors.green(ethers.formatUnits(gasPrice, "gwei"))} Gwei`)
      );
      console.log(
        colors.white(`  Gas Limit: ${colors.green(manualGasLimit)}`)
      );

      // Wait between transactions
      await sleep(15000);

      // Check transaction receipt
      let receipt;
      try {
        receipt = await retry(() => provider.getTransactionReceipt(tx.hash));
        if (receipt) {
          if (receipt.status === 1) {
            console.log(colors.green("✅ Transaction Success!"));
            console.log(colors.green(`  Block Number: ${receipt.blockNumber}`));
            console.log(colors.green(`  Gas Used: ${receipt.gasUsed.toString()}`));
            console.log(
              colors.green(`  Transaction hash: ${selectedChain.explorer}/tx/${receipt.hash}`)
            );
          } else {
            console.log(colors.red("❌ Transaction FAILED"));
          }
        } else {
          console.log(colors.yellow("⏳ Transaction is still pending after multiple retries."));
        }
      } catch (error) {
        console.log(colors.red(`❌ Error checking transaction status: ${error.message}`));
      }

      console.log();
    }

    console.log(colors.green(`✅ Finished transactions for address: ${senderAddress}`));
  }

  console.log("");
  console.log(colors.green("All transactions completed."));
  console.log(colors.green("Subscribe: https://t.me/HappyCuanAirdrop."));
  process.exit(0);
};

main().catch((error) => {
  console.error(colors.red("🚨 An unexpected error occurred:"), error);
  process.exit(1);
});
