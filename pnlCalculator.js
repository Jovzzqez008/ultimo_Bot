// pnlCalculator.js - Cálculo de PnL CORRECTO con FEES REALES (Nov 2025)

/**
 * 💰 FEES REALES ACTUALIZADOS:
 * - Pump.fun bonding curve: 1.25% (0.95% Protocol + 0.30% Creator)
 * - PumpPortal Local API: 0.5% adicional
 * - TOTAL PumpPortal: 1.75% por operación (buy/sell)
 * - Jupiter (tokens graduados): ~0.3% promedio (varía según DEX)
 * - Solana network: 0.000005 SOL base + priority fee
 */

export class PnLCalculator {
  /**
   * 💰 Calcula P&L CORRECTO incluyendo TODAS las fees
   * 
   * FEES INCLUIDOS:
   * - Pump.fun: 1.25% buy + 1.25% sell
   * - PumpPortal: 0.5% buy + 0.5% sell (adicional a Pump.fun)
   * - Jupiter: ~0.3% (para tokens graduados, sin protocol fee)
   * - Slippage: configurado por usuario
   * - Network fees: ~0.000005 SOL + priority fee
   * 
   * @param {Object} trade - {entryPrice, exitPrice, tokenAmount, solSpent, executor, slippage, networkFee, priorityFee}
   * @returns {Object} - {pnlSOL, pnlPercent, breakdown, netReceived}
   */
  static calculatePnL(trade) {
    const {
      entryPrice,        // Precio al comprar (SOL/token)
      exitPrice,         // Precio al vender (SOL/token)
      tokenAmount,       // Cantidad de tokens comprados
      solSpent,          // SOL gastado en compra (YA incluye fees)
      executor = 'pumpportal',  // 'pumpportal' o 'jupiter'
      slippage = 0,      // Slippage real experimentado (0-1, ej: 0.05 = 5%)
      networkFee = 0.000005,  // Fee base de red Solana
      priorityFee = 0     // Priority fee adicional en SOL
    } = trade;

    if (!entryPrice || !exitPrice || !tokenAmount || !solSpent) {
      throw new Error('❌ Missing required fields for PnL calculation');
    }

    // === FEES SEGÚN EXECUTOR (FEES REALES) ===
    let buyFeeTotal, sellFeeTotal, executorLabel;
    
    if (executor === 'pumpportal') {
      // PumpPortal Local API = Pump.fun (1.25%) + PumpPortal (0.5%) = 1.75% total
      buyFeeTotal = 0.0175;   // 1.75%
      sellFeeTotal = 0.0175;  // 1.75%
      executorLabel = 'PumpPortal (Pump.fun bonding curve)';
    } else if (executor === 'jupiter') {
      // Jupiter para tokens graduados (~0.3% promedio, sin protocol fee)
      buyFeeTotal = 0.003;   // ~0.3%
      sellFeeTotal = 0.003;  // ~0.3%
      executorLabel = 'Jupiter (DEX aggregator)';
    } else {
      // Fallback genérico
      buyFeeTotal = 0.01;
      sellFeeTotal = 0.01;
      executorLabel = 'Generic DEX';
    }

    console.log(`\n📊 P&L CALCULATION (${executorLabel})`);
    console.log(`════════════════════════════════════════`);
    
    // === PASO 1: Análisis de la COMPRA ===
    console.log(`\n💵 ENTRY (BUY)`);
    console.log(`  Price: ${entryPrice.toFixed(10)} SOL/token`);
    console.log(`  Tokens: ${tokenAmount.toLocaleString()}`);
    console.log(`  SOL Spent (total): ${solSpent.toFixed(6)} SOL`);
    console.log(`  Buy Fee: ${(buyFeeTotal * 100).toFixed(2)}%`);
    
    // === PASO 2: Valor actual de los tokens (ANTES de fees de venta) ===
    const grossValue = tokenAmount * exitPrice;
    console.log(`\n💰 EXIT (SELL)`);
    console.log(`  Price: ${exitPrice.toFixed(10)} SOL/token`);
    console.log(`  Gross Value: ${grossValue.toFixed(6)} SOL`);
    
    // === PASO 3: Aplicar fee de venta ===
    const sellFeeAmount = grossValue * sellFeeTotal;
    const valueAfterSellFee = grossValue - sellFeeAmount;
    console.log(`  Sell Fee (${(sellFeeTotal * 100).toFixed(2)}%): -${sellFeeAmount.toFixed(6)} SOL`);
    console.log(`  After Sell Fee: ${valueAfterSellFee.toFixed(6)} SOL`);
    
    // === PASO 4: Aplicar slippage (si existe) ===
    const slippageAmount = valueAfterSellFee * Math.abs(slippage);
    const valueAfterSlippage = valueAfterSellFee - slippageAmount;
    if (slippage > 0) {
      console.log(`  Slippage (${(slippage * 100).toFixed(2)}%): -${slippageAmount.toFixed(6)} SOL`);
      console.log(`  After Slippage: ${valueAfterSlippage.toFixed(6)} SOL`);
    }
    
    // === PASO 5: Network fees ===
    const totalNetworkFee = networkFee + priorityFee;
    const netReceived = valueAfterSlippage - totalNetworkFee;
    console.log(`  Network Fee: -${networkFee.toFixed(6)} SOL`);
    if (priorityFee > 0) {
      console.log(`  Priority Fee: -${priorityFee.toFixed(6)} SOL`);
    }
    console.log(`  ✅ NET RECEIVED: ${netReceived.toFixed(6)} SOL`);
    
    // === PASO 6: Calcular PnL final ===
    const pnlSOL = netReceived - solSpent;
    const pnlPercent = (pnlSOL / solSpent) * 100;
    
    // Cambio de precio puro (sin fees, para referencia)
    const priceChangePercent = ((exitPrice - entryPrice) / entryPrice) * 100;
    
    console.log(`\n═══════════════════════════════════════`);
    console.log(`📈 RESULT`);
    console.log(`  ${pnlSOL >= 0 ? '🟢' : '🔴'} PnL: ${pnlSOL >= 0 ? '+' : ''}${pnlSOL.toFixed(6)} SOL`);
    console.log(`  ${pnlPercent >= 0 ? '🟢' : '🔴'} PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`);
    console.log(`  📊 Price Change: ${priceChangePercent >= 0 ? '+' : ''}${priceChangePercent.toFixed(2)}%`);
    console.log(`  💸 Total Fees Impact: ${((pnlPercent - priceChangePercent)).toFixed(2)}%`);
    console.log(`═══════════════════════════════════════\n`);
    
    return {
      pnlSOL: Number(pnlSOL.toFixed(6)),
      pnlPercent: Number(pnlPercent.toFixed(2)),
      priceChangePercent: Number(priceChangePercent.toFixed(2)),
      netReceived: Number(netReceived.toFixed(6)),
      breakdown: {
        entry: {
          price: entryPrice,
          tokens: tokenAmount,
          solSpent,
          buyFeePercent: buyFeeTotal,
        },
        exit: {
          price: exitPrice,
          grossValue,
          sellFeeAmount,
          sellFeePercent: sellFeeTotal,
          valueAfterSellFee,
          slippageAmount,
          slippagePercent: slippage,
          valueAfterSlippage,
          networkFee,
          priorityFee,
          totalNetworkFee,
          netReceived,
        },
        executor,
        executorLabel,
      },
    };
  }

  /**
   * 📈 PnL UNREALIZADO (posición abierta)
   * Estima cuánto ganarías/perderías si vendieras AHORA
   */
  static calculateUnrealizedPnL(position, currentPrice, options = {}) {
    const {
      executor = 'pumpportal',
      estimatedSlippage = 0.02,  // 2% por defecto
      networkFee = 0.000005,
      priorityFee = 0
    } = options;

    const entryPrice = Number(position.entryPrice);
    const solSpent = Number(position.solAmount || position.solSpent);
    const tokenAmount = Number(position.tokensAmount || position.tokenAmount);

    if (!entryPrice || !solSpent || !tokenAmount || !currentPrice) {
      throw new Error('❌ Missing fields for unrealized PnL');
    }

    // Fees según executor (FEES REALES)
    const sellFeeTotal = executor === 'pumpportal' ? 0.0175 : 0.003; // 1.75% o 0.3%

    // Simular venta
    const grossValue = tokenAmount * currentPrice;
    const sellFeeAmount = grossValue * sellFeeTotal;
    const valueAfterFee = grossValue - sellFeeAmount;
    const slippageAmount = valueAfterFee * estimatedSlippage;
    const valueAfterSlippage = valueAfterFee - slippageAmount;
    const totalNetworkFee = networkFee + priorityFee;
    const netReceived = valueAfterSlippage - totalNetworkFee;

    const pnlSOL = netReceived - solSpent;
    const pnlPercent = (pnlSOL / solSpent) * 100;
    const holdTimeMs = Date.now() - Number(position.entryTime || Date.now());

    return {
      current: {
        price: currentPrice,
        grossValue,
        sellFeeAmount,
        sellFeePercent: sellFeeTotal,
        valueAfterFee,
        slippageEstimate: slippageAmount,
        valueAfterSlippage,
        networkFee: totalNetworkFee,
        netReceived,
      },
      pnlSOL: Number(pnlSOL.toFixed(6)),
      pnlPercent: Number(pnlPercent.toFixed(2)),
      holdTimeMs,
      executor,
    };
  }

  /**
   * ⚠️ Detecta discrepancias grandes entre cambio de precio y PnL real
   * (útil para debugging)
   */
  static checkDiscrepancy(trade) {
    const result = this.calculatePnL(trade);
    const discrepancy = Math.abs(result.priceChangePercent - result.pnlPercent);

    if (discrepancy > 5) {
      console.warn(`\n⚠️ HIGH FEE IMPACT DETECTED`);
      console.warn(`  Price moved: ${result.priceChangePercent.toFixed(2)}%`);
      console.warn(`  Your PnL: ${result.pnlPercent.toFixed(2)}%`);
      console.warn(`  Difference: ${discrepancy.toFixed(2)}% (fees+slippage impact)`);
    }

    return {
      hasHighImpact: discrepancy > 5,
      feeImpact: discrepancy,
    };
  }
}
