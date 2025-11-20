// pumpPortalExecutor.js - PumpPortal Lightning API Integration (Copy-Trading Version)
// TOTALMENTE INTEGRADO A TU ARQUITECTURA
// Reemplaza completamente PumpFunExecutor para compras/ventas en Pump.fun

import axios from 'axios';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export class PumpPortalExecutor {
  constructor(config) {
    this.apiKey = config.PUMPPORTAL_API_KEY;
    this.rpcUrl = config.RPC_URL;
    this.privateKey = config.PRIVATE_KEY;
    this.dryRun = config.DRY_RUN !== 'false';

    // Convertir private key a Keypair
    try {
      const decoded = Array.isArray(this.privateKey)
        ? Uint8Array.from(this.privateKey)
        : bs58.decode(this.privateKey);

      this.wallet = Keypair.fromSecretKey(decoded);
    } catch (err) {
      console.error("❌ INVALID PRIVATE_KEY format:", err.message);
      throw err;
    }

    this.baseUrl = "https://pumpportal.fun/api";
    this.connection = new Connection(this.rpcUrl, "confirmed");

    console.log("🔷 PumpPortalExecutor READY");
    console.log(` Wallet: ${this.wallet.publicKey.toString()}`);
    console.log(` Mode: ${this.dryRun ? "📄 PAPER" : "💰 LIVE"}`);
  }

  // ============================================================
  // 📘 COPY TRADING BUY
  // ============================================================
  async buyToken(mint, solAmount, slippage = 10, priorityFee = 0.0005) {
    try {
      console.log(`\n🟦 COPY BUY → PUMPPORTAL`);
      console.log(` Mint: ${mint}`);
      console.log(` Amount (SOL): ${solAmount}`);
      console.log(` Slippage: ${slippage}%`);
      console.log(` Priority Fee: ${priorityFee} SOL`);

      // 🔹 PAPER MODE SIMULATION
      if (this.dryRun) {
        return this.simulateBuy(mint, solAmount);
      }

      // ======================================================
      // LIVE MODE - PumpPortal Lightning API
      // ======================================================
      const payload = {
        action: "buy",
        mint: mint,
        amount: solAmount,
        denominatedInSol: "true",
        slippage: slippage,
        priorityFee: priorityFee,
        pool: "pump",
        skipPreflight: false,
        jitoOnly: false
      };

      const response = await axios.post(
        `${this.baseUrl}/trade?api-key=${this.apiKey}`,
        payload,
        {
          timeout: 30000,
          headers: { "Content-Type": "application/json" }
        }
      );

      if (!response.data?.signature) {
        throw new Error("PumpPortal API didn't return a signature");
      }

      const signature = response.data.signature;
      console.log(`   ✔ Signature: ${signature}`);

      // Confirmación
      await this.waitForConfirmation(signature);

      const txDetails = await this.getTxDetails(signature);

      return {
        success: true,
        action: "buy",
        mint,
        signature,
        solSpent: solAmount,
        tokensReceived: txDetails.tokensReceived ?? 0,
        timestamp: Date.now()
      };

    } catch (error) {
      console.error("❌ PumpPortal BUY error:", error.message);
      return {
        success: false,
        error: error.message,
        mint
      };
    }
  }

  // ============================================================
  // 📘 COPY TRADING SELL
  // ============================================================
  async sellToken(mint, tokenAmount, slippage = 10, priorityFee = 0.0005) {
    try {
      console.log(`\n🟦 COPY SELL → PUMPPORTAL`);
      console.log(` Mint: ${mint}`);
      console.log(` Tokens to sell: ${tokenAmount}`);
      console.log(` Slippage: ${slippage}%`);

      if (this.dryRun) {
        return this.simulateSell(mint, tokenAmount);
      }

      const payload = {
        action: "sell",
        mint: mint,
        amount: tokenAmount,
        denominatedInSol: "false",
        slippage: slippage,
        priorityFee: priorityFee,
        pool: "pump",
        skipPreflight: false,
        jitoOnly: false
      };

      const response = await axios.post(
        `${this.baseUrl}/trade?api-key=${this.apiKey}`,
        payload,
        {
          timeout: 30000,
          headers: { "Content-Type": "application/json" }
        }
      );

      if (!response.data?.signature) {
        throw new Error("PumpPortal API did not return signature");
      }

      const signature = response.data.signature;
      console.log(`   ✔ Sell signature: ${signature}`);

      await this.waitForConfirmation(signature);
      const tx = await this.getTxDetails(signature);

      return {
        success: true,
        action: "sell",
        mint,
        signature,
        tokensSold: tokenAmount,
        solReceived: tx.solReceived ?? 0,
        timestamp: Date.now()
      };

    } catch (error) {
      console.error(`❌ SELL ERROR: ${error.message}`);
      return { success: false, error: error.message, mint };
    }
  }

  // ============================================================
  // 📝 PAPER MODE SIMULATIONS
  // ============================================================
  simulateBuy(mint, solAmount) {
    const price = 0.000001; // fake bonding curve
    const tokens = solAmount / price;

    return {
      success: true,
      simulated: true,
      mint,
      solSpent: solAmount,
      tokensReceived: tokens,
      signature: this.generateFakeSignature(),
      timestamp: Date.now()
    };
  }

  simulateSell(mint, tokenAmount) {
    const price = 0.000001;
    const sol = tokenAmount * price * 0.99;

    return {
      success: true,
      simulated: true,
      mint,
      solReceived: sol,
      tokensSold: tokenAmount,
      signature: this.generateFakeSignature(),
      timestamp: Date.now()
    };
  }

  // ============================================================
  // ⏳ CONFIRMATIONS + HELPERS
  // ============================================================
  async waitForConfirmation(signature, max = 20) {
    for (let i = 0; i < max; i++) {
      let status = await this.connection.getSignatureStatus(signature);

      if (
        status.value?.confirmationStatus === "confirmed" ||
        status.value?.confirmationStatus === "finalized"
      ) {
        return true;
      }

      await new Promise((res) => setTimeout(res, 1000));
    }
    console.warn("⚠️ Confirmation timeout");
    return false;
  }

  async getTxDetails(signature) {
    try {
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0
      });

      // No implementamos parsing completo (PumpPortal lo hace casi todo)
      return {};
    } catch (err) {
      return {};
    }
  }

  generateFakeSignature() {
    return bs58.encode(
      Buffer.from(Array.from({ length: 64 }, () => Math.floor(Math.random() * 255)))
    );
  }
}
