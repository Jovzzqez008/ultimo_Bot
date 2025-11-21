// pumpPortalExecutor.js – PumpPortal LOCAL Transaction API (0.5% fee)
// ✅ FIXED: Simulador realista con validación de coherencia

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

    // ✅ SIMULADOR: Cache de precios para coherencia buy->sell
    this.simulatedPrices = new Map(); // mint -> { price, timestamp }
    this.priceValidityMs = 300000; // 5 minutos

    // ✅ Estadísticas del simulador
    this.simulationStats = {
      totalBuys: 0,
      totalSells: 0,
      simulatedPnL: 0
    };

    console.log(`🔷 PumpPortal Executor (LOCAL API - 0.5% fee)`);
    console.log(`   Wallet: ${this.wallet.publicKey.toString()}`);
    console.log(`   Mode: ${this.dryRun ? '📄 PAPER' : '💰 LIVE'}`);
    console.log(`   ✅ Using your own private key`);
    if (this.dryRun) {
      console.log(`   🎯 Simulator: REALISTIC MODE (coherent buy/sell prices)\n`);
    }
  }

  // ========================================================================
  // ✅ REALISTIC PRICE GENERATOR
  // ========================================================================
  /**
   * Genera un precio realista basado en:
   * - Pump.fun bonding curve
   * - Volatilidad típica (±20% en primeras operaciones)
   * - Coherencia entre buy y sell
   */
  generateRealisticPrice(mint, solAmount, action = 'BUY') {
    const now = Date.now();
    
    // Verificar si ya existe precio para este mint
    if (this.simulatedPrices.has(mint)) {
      const cached = this.simulatedPrices.get(mint);
      
      // Si el precio es reciente, usar con variación
      if (now - cached.timestamp < this.priceValidityMs) {
        const basePrice = cached.price;
        
        // SELL tiene pequeña variación (±5%)
        if (action === 'SELL') {
          const variation = 0.95 + (Math.random() * 0.1); // 95% a 105%
          return basePrice * variation;
        }
        
        // BUY también usa variación pero distinta
        return basePrice * (0.98 + Math.random() * 0.04); // 98% a 102%
      }
    }

    // ✅ GENERAR PRECIO INICIAL REALISTA
    // Pump.fun típicamente comienza con precios entre 0.000001 y 0.00001 SOL/token
    
    // Rango base realista
    const minPrice = 0.000001;
    const maxPrice = 0.00001;
    
    // Log-scale para distribución más realista (más tokens cheap que expensive)
    const logMin = Math.log10(minPrice);
    const logMax = Math.log10(maxPrice);
    const randomLog = logMin + Math.random() * (logMax - logMin);
    let basePrice = Math.pow(10, randomLog);

    // ✅ AJUSTE POR VOLUMEN
    // Si compras mucho SOL, el precio debería subir (curva bonding)
    // Fórmula simplificada: precio = basePrice * (1 + solAmount/0.5)^0.1
    if (solAmount > 0.1) {
      const volumeMultiplier = Math.pow(1 + (solAmount / 0.5), 0.1);
      basePrice = basePrice * volumeMultiplier;
    }

    // Guardar para coherencia futura
    this.simulatedPrices.set(mint, {
      price: basePrice,
      timestamp: now,
      solAmountBuy: solAmount
    });

    console.log(`   📊 Generated price for ${mint.slice(0, 8)}...: ${basePrice.toFixed(10)} SOL/token`);

    return basePrice;
  }

  // ========================================================================
  // BUY via Local API
  // ========================================================================
  async buyToken(mint, solAmount, slippage = 10, priorityFee = 0.0005) {
    try {
      console.log(`\n🟦 BUY REQUEST (Local API)`);
      console.log(`   Mint: ${mint.slice(0, 12)}...`);
      console.log(`   Amount: ${solAmount} SOL`);
      console.log(`   Slippage: ${slippage}%`);
      console.log(`   Priority: ${priorityFee} SOL`);

      if (this.dryRun) {
        return this.simulateBuyRealistic(mint, solAmount, slippage);
      }

      // ✅ Payload para Local API (NO incluye API key)
      const payload = {
        publicKey: this.wallet.publicKey.toBase58(),
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
          responseType: 'arraybuffer'
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
        fee: '1.75%', // Pump.fun + PumpPortal
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

  // ========================================================================
  // SELL via Local API
  // ========================================================================
  async sellToken(mint, amountTokens, slippage = 10, priorityFee = 0.0005) {
    try {
      console.log(`\n🟥 SELL REQUEST (Local API)`);
      console.log(`   Mint: ${mint.slice(0, 12)}...`);
      console.log(`   Amount: ${amountTokens} tokens`);
      console.log(`   Slippage: ${slippage}%`);

      if (this.dryRun) {
        return this.simulateSellRealistic(mint, amountTokens, slippage);
      }

      // ✅ Payload para Local API
      const payload = {
        publicKey: this.wallet.publicKey.toBase58(),
        action: 'sell',
        mint,
        amount: amountTokens,
        denominatedInSol: 'false',
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
        fee: '1.75%',
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

  // ========================================================================
  // ✅ SIMULACIONES REALISTAS
  // ========================================================================

  /**
   * Simula una compra realista
   * - Genera precio coherente
   * - Calcula tokens basado en SOL/precio
   * - Aplica fees reales de Pump.fun
   */
  simulateBuyRealistic(mint, solAmount, slippage = 10) {
    console.log(`   🎯 REALISTIC SIMULATION`);
    
    // Generar precio realista
    const pricePerToken = this.generateRealisticPrice(mint, solAmount, 'BUY');

    // ✅ CALCULAR TOKENS RECIBIDOS CON FEES
    // Fee de Pump.fun: 1.25%
    // Fee de PumpPortal: 0.5% (incluida en Local API)
    // Total: 1.75%
    const buyFeePercent = 0.0175;
    
    const solAfterFee = solAmount * (1 - buyFeePercent);
    const tokensReceived = Math.floor(solAfterFee / pricePerToken);

    console.log(`   💰 Price: ${pricePerToken.toFixed(10)} SOL/token`);
    console.log(`   📊 Buy Fee: 1.75% (${(solAmount * buyFeePercent).toFixed(6)} SOL)`);
    console.log(`   🎫 Tokens: ${tokensReceived.toLocaleString()}`);

    this.simulationStats.totalBuys++;

    return {
      success: true,
      simulated: true,
      action: 'buy',
      mint,
      solSpent: solAmount,
      tokensReceived: tokensReceived,
      pricePerToken: pricePerToken,
      signature: this.fakeSignature(),
      timestamp: Date.now(),
      fee: '1.75%',
      api: 'local'
    };
  }

  /**
   * Simula una venta realista
   * - Usa precio coherente con la compra anterior
   * - Aplica fees de venta (1.75%)
   * - Aplica slippage
   * - Valida que el resultado sea razonable
   */
  simulateSellRealistic(mint, amountTokens, slippage = 10) {
    console.log(`   🎯 REALISTIC SIMULATION`);

    if (!this.simulatedPrices.has(mint)) {
      console.warn(`   ⚠️ No price history for ${mint.slice(0, 8)}...`);
      console.warn(`      Using fallback realistic price`);
      this.generateRealisticPrice(mint, 0.05, 'SELL');
    }

    const basePrice = this.simulatedPrices.get(mint)?.price || 0.000001;
    
    // ✅ APLICAR VARIACIÓN DE PRECIO (volatilidad)
    // Rango: -5% a +20% (más alcista porque es pump.fun)
    const priceVariation = 0.95 + (Math.random() * 0.25);
    const currentPrice = basePrice * priceVariation;

    // ✅ APLICAR SLIPPAGE (impacto de precio)
    const slippagePercent = slippage / 100;
    const priceWithSlippage = currentPrice * (1 - slippagePercent);

    // ✅ CALCULAR SOL RECIBIDO
    const grossValue = amountTokens * priceWithSlippage;
    
    // Fee de venta: 1.75% (Pump.fun 1.25% + PumpPortal 0.5%)
    const sellFeePercent = 0.0175;
    const sellFeeAmount = grossValue * sellFeePercent;
    
    // Priority fee (network)
    const priorityFee = 0.0005;
    
    const solReceived = grossValue - sellFeeAmount - priorityFee;

    // ✅ VALIDAR COHERENCIA
    const validation = this.validateSellCoherence(mint, amountTokens, solReceived);
    
    if (!validation.isValid) {
      console.warn(`   ⚠️ ${validation.warning}`);
      console.warn(`      Regenerando precio coherente...`);
      
      // Regenerar con coherencia forzada
      return this.simulateSellForced(mint, amountTokens, slippage);
    }

    console.log(`   💰 Base Price: ${basePrice.toFixed(10)} SOL/token`);
    console.log(`   📈 Variation: ${(priceVariation * 100).toFixed(1)}%`);
    console.log(`   📊 Current: ${currentPrice.toFixed(10)} SOL/token`);
    console.log(`   📉 With ${slippage}% slippage: ${priceWithSlippage.toFixed(10)} SOL/token`);
    console.log(`   💰 Sell Fee: 1.75% (${sellFeeAmount.toFixed(6)} SOL)`);
    console.log(`   💾 Net Received: ${solReceived.toFixed(6)} SOL`);

    this.simulationStats.totalSells++;
    this.simulationStats.simulatedPnL += (solReceived - (this.simulatedPrices.get(mint)?.solAmountBuy || 0.05));

    return {
      success: true,
      simulated: true,
      action: 'sell',
      mint,
      tokensSold: amountTokens,
      solReceived: solReceived,
      pricePerToken: priceWithSlippage,
      basePrice: basePrice,
      variation: priceVariation,
      signature: this.fakeSignature(),
      timestamp: Date.now(),
      fee: '1.75%',
      api: 'local'
    };
  }

  /**
   * Forzar coherencia en venta
   * Cuando no hay compra previa o precio fuera de rango
   */
  simulateSellForced(mint, amountTokens, slippage = 10) {
    // Precio base realista
    const basePrice = 0.000005;
    
    // Aplicar variación pequeña (±10%)
    const priceVariation = 0.9 + (Math.random() * 0.2);
    const currentPrice = basePrice * priceVariation;
    
    // Con slippage
    const priceWithSlippage = currentPrice * (1 - (slippage / 100));
    
    // Calcular SOL
    const grossValue = amountTokens * priceWithSlippage;
    const solReceived = grossValue * 0.9825 - 0.0005; // 1.75% fee + priority fee

    return {
      success: true,
      simulated: true,
      action: 'sell',
      mint,
      tokensSold: amountTokens,
      solReceived: Math.max(solReceived, 0.001), // Mínimo 0.001 SOL
      pricePerToken: priceWithSlippage,
      basePrice: basePrice,
      variation: priceVariation,
      signature: this.fakeSignature(),
      timestamp: Date.now(),
      fee: '1.75%',
      api: 'local'
    };
  }

  /**
   * Validar que la venta sea coherente con la compra
   * Evita resultados absurdos (vender 0.05 SOL y recibir 3 SOL)
   */
  validateSellCoherence(mint, amountTokens, solReceived) {
    const buyData = this.simulatedPrices.get(mint);
    
    if (!buyData) {
      return { isValid: true, warning: null };
    }

    const solSpent = buyData.solAmountBuy;
    const buyPrice = buyData.price;

    // ✅ VALIDACIONES
    const minExpected = solSpent * 0.5;   // Mínimo: -50%
    const maxExpected = solSpent * 5;    // Máximo: +400%

    if (solReceived < minExpected) {
      return {
        isValid: false,
        warning: `Sell too low: ${solReceived.toFixed(4)} SOL < ${minExpected.toFixed(4)} SOL`
      };
    }

    if (solReceived > maxExpected) {
      return {
        isValid: false,
        warning: `Sell too high: ${solReceived.toFixed(4)} SOL > ${maxExpected.toFixed(4)} SOL`
      };
    }

    // ✅ VALIDAR PRECIO POR TOKEN
    const pricePerToken = solReceived / amountTokens;
    
    // Precio no debería diferir más de 500% del precio de compra
    if (pricePerToken > buyPrice * 6 || pricePerToken < buyPrice * 0.1) {
      return {
        isValid: false,
        warning: `Price deviation too high: ${pricePerToken.toFixed(10)} vs ${buyPrice.toFixed(10)}`
      };
    }

    return { isValid: true, warning: null };
  }

  // ========================================================================
  // HELPERS
  // ========================================================================
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

  // ========================================================================
  // STATS Y DEBUG
  // ========================================================================
  getSimulationStats() {
    return {
      ...this.simulationStats,
      avgPnLPerTrade: this.simulationStats.totalSells > 0 
        ? (this.simulationStats.simulatedPnL / this.simulationStats.totalSells).toFixed(4)
        : 0
    };
  }

  clearPriceCache() {
    this.simulatedPrices.clear();
    console.log('🧹 Price cache cleared');
  }
}
