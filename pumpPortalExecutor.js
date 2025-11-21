// pumpPortalExecutor.js – PumpPortal LOCAL Transaction API (0.5% fee)
// Compatible con CUALQUIER private key en base58

import axios from 'axios';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';

export class PumpPortalExecutor {
  constructor(config) {
    this.rpcUrl = config.RPC_URL;
    this.dryRun = config.DRY_RUN !== 'false';

    // ✅ USA TU PROPIA PRIVATE KEY (no necesitas la de PumpPortal)
    const secretKey = bs58.decode(config.PRIVATE_KEY);
    this.wallet = Keypair.fromSecretKey(secretKey);

    this.connection = new Connection(this.rpcUrl, {
      commitment: 'confirmed',
      skipPreflight: false,
      maxRetries: 3
    });

    // ✅ Local API endpoint (NO necesita API key)
    this.baseUrl = 'https://pumpportal.fun/api/trade-local';

    console.log(`🔷 PumpPortal Executor (LOCAL API - 0.5% fee)`);
    console.log(`   Wallet: ${this.wallet.publicKey.toString()}`);
    console.log(`   Mode: ${this.dryRun ? '📄 PAPER' : '💰 LIVE'}`);
    console.log(`   ✅ Using your own private key`);
  }

  // ------------------------------------------------------------------------
  // BUY via Local API
  // ------------------------------------------------------------------------
  async buyToken(mint, solAmount, slippage = 10, priorityFee = 0.0005) {
    try {
      console.log(`\n🟦 BUY REQUEST (Local API)`);
      console.log(`   Mint: ${mint.slice(0, 12)}...`);
      console.log(`   Amount: ${solAmount} SOL`);
      console.log(`   Slippage: ${slippage}%`);
      console.log(`   Priority: ${priorityFee} SOL`);

      if (this.dryRun) {
        return this.simulateBuy(mint, solAmount);
      }

      // ✅ Payload para Local API (NO incluye API key)
      const payload = {
        publicKey: this.wallet.publicKey.toBase58(), // Tu wallet pública
        action: 'buy',
        mint,
        amount: solAmount,
        denominatedInSol: 'true',
        slippage,
        priorityFee,
        pool: 'pump'
      };

      console.log(`   📤 Requesting unsigned transaction...`);

      // ✅ Solicitar transacción SIN FIRMAR
      const response = await axios.post(
        this.baseUrl,
        payload,
        { 
          timeout: 30000,
          responseType: 'arraybuffer' // Importante: recibir como buffer
        }
      );

      if (response.status !== 200 || !response.data) {
        throw new Error(`API Error: ${response.statusText}`);
      }

      console.log(`   ✅ Unsigned transaction received`);

      // ✅ Deserializar la transacción
      const txBuffer = new Uint8Array(response.data);
      const tx = VersionedTransaction.deserialize(txBuffer);

      console.log(`   🔐 Signing with your private key...`);

      // ✅ Firmar con TU private key
      tx.sign([this.wallet]);

      console.log(`   📡 Sending to RPC...`);

      // ✅ Enviar con TU RPC
      const signature = await this.connection.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 3
      });

      console.log(`   ✅ Transaction sent: ${signature.slice(0, 20)}...`);
      console.log(`   🔗 https://solscan.io/tx/${signature}`);

      // Esperar confirmación
      await this.waitForConfirmation(signature);

      // Obtener detalles de la transacción
      const txDetails = await this.getTxDetails(signature);

      return {
        success: true,
        action: 'buy',
        mint,
        signature,
        solSpent: solAmount,
        tokensReceived: txDetails?.tokensReceived || 0,
        timestamp: Date.now(),
        fee: '0.5%', // Local API fee
        api: 'local'
      };

    } catch (err) {
      console.error(`❌ BUY FAILED: ${err.message}`);
      return {
        success: false,
        action: 'buy',
        mint,
        error: err.message,
      };
    }
  }

  // ------------------------------------------------------------------------
  // SELL via Local API
  // ------------------------------------------------------------------------
  async sellToken(mint, amountTokens, slippage = 10, priorityFee = 0.0005) {
    try {
      console.log(`\n🟥 SELL REQUEST (Local API)`);
      console.log(`   Mint: ${mint.slice(0, 12)}...`);
      console.log(`   Amount: ${amountTokens} tokens`);
      console.log(`   Slippage: ${slippage}%`);

      if (this.dryRun) {
        return this.simulateSell(mint, amountTokens);
      }

      // ✅ Payload para Local API
      const payload = {
        publicKey: this.wallet.publicKey.toBase58(),
        action: 'sell',
        mint,
        amount: amountTokens,
        denominatedInSol: 'false', // Vender por cantidad de tokens
        slippage,
        priorityFee,
        pool: 'pump'
      };

      console.log(`   📤 Requesting unsigned transaction...`);

      const response = await axios.post(
        this.baseUrl,
        payload,
        { 
          timeout: 30000,
          responseType: 'arraybuffer'
        }
      );

      if (response.status !== 200 || !response.data) {
        throw new Error(`API Error: ${response.statusText}`);
      }

      console.log(`   ✅ Unsigned transaction received`);

      const txBuffer = new Uint8Array(response.data);
      const tx = VersionedTransaction.deserialize(txBuffer);

      console.log(`   🔐 Signing with your private key...`);
      tx.sign([this.wallet]);

      console.log(`   📡 Sending to RPC...`);
      const signature = await this.connection.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 3
      });

      console.log(`   ✅ Transaction sent: ${signature.slice(0, 20)}...`);
      console.log(`   🔗 https://solscan.io/tx/${signature}`);

      await this.waitForConfirmation(signature);
      const txDetails = await this.getTxDetails(signature);

      return {
        success: true,
        action: 'sell',
        mint,
        signature,
        tokensSold: amountTokens,
        solReceived: txDetails?.solReceived || 0,
        timestamp: Date.now(),
        fee: '0.5%',
        api: 'local'
      };

    } catch (err) {
      console.error(`❌ SELL FAILED: ${err.message}`);
      return {
        success: false,
        action: 'sell',
        mint,
        error: err.message,
      };
    }
  }

  // ------------------------------------------------------------------------
  // DRY RUN SIMULATIONS
  // ------------------------------------------------------------------------
  simulateBuy(mint, solAmount) {
    const avgPrice = 0.000001;
    const tokens = solAmount / avgPrice;

    return {
      success: true,
      simulated: true,
      action: 'buy',
      mint,
      solSpent: solAmount,
      tokensReceived: tokens,
      signature: this.fakeSignature(),
      timestamp: Date.now(),
      fee: '0.5%',
      api: 'local'
    };
  }

  simulateSell(mint, amountTokens) {
    const avgPrice = 0.000001;
    const sol = amountTokens * avgPrice;

    return {
      success: true,
      simulated: true,
      action: 'sell',
      mint,
      tokensSold: amountTokens,
      solReceived: sol,
      signature: this.fakeSignature(),
      timestamp: Date.now(),
      fee: '0.5%',
      api: 'local'
    };
  }

  // ------------------------------------------------------------------------
  // HELPERS
  // ------------------------------------------------------------------------
  async waitForConfirmation(signature) {
    console.log(`   ⏳ Waiting for confirmation...`);
    
    for (let i = 0; i < 30; i++) {
      try {
        const status = await this.connection.getSignatureStatus(signature);

        if (
          status.value?.confirmationStatus === 'confirmed' ||
          status.value?.confirmationStatus === 'finalized'
        ) {
          console.log(`   🎉 Confirmed after ${i + 1} attempts`);
          return true;
        }
      } catch (e) {
        // Ignorar errores temporales
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    console.warn(`   ⚠️ Confirmation timeout (may still succeed)`);
    return false;
  }

  async getTxDetails(signature) {
    try {
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });
      return this.parseTx(tx);
    } catch (err) {
      console.warn(`   ⚠️ Could not fetch tx details: ${err.message}`);
      return null;
    }
  }

  parseTx(tx) {
    if (!tx || !tx.meta) return {};

    let tokensReceived = 0;
    let solReceived = 0;

    // Parsear cambios de tokens
    if (tx.meta?.postTokenBalances && tx.meta?.preTokenBalances) {
      for (const postBal of tx.meta.postTokenBalances) {
        const preBal = tx.meta.preTokenBalances.find(
          p => p.accountIndex === postBal.accountIndex
        );

        const preAmount = preBal?.uiTokenAmount?.uiAmount || 0;
        const postAmount = postBal?.uiTokenAmount?.uiAmount || 0;

        tokensReceived += (postAmount - preAmount);
      }
    }

    // Parsear cambios de SOL
    if (tx.meta?.postBalances && tx.meta?.preBalances) {
      const walletPubkey = this.wallet.publicKey.toBase58();
      
      const walletIndex = tx.transaction.message.staticAccountKeys?.findIndex(
        k => k.toBase58() === walletPubkey
      ) ?? tx.transaction.message.accountKeys?.findIndex(
        k => k.toBase58() === walletPubkey
      ) ?? -1;

      if (walletIndex >= 0) {
        const preSOL = (tx.meta.preBalances[walletIndex] || 0) / 1e9;
        const postSOL = (tx.meta.postBalances[walletIndex] || 0) / 1e9;
        solReceived = postSOL - preSOL;
      }
    }

    return {
      tokensReceived: Math.abs(tokensReceived),
      solReceived: Math.abs(solReceived),
    };
  }

  fakeSignature() {
    const arr = new Uint8Array(64).map(() =>
      Math.floor(Math.random() * 256)
    );
    return bs58.encode(arr);
  }
}
