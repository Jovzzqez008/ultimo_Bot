// copyMonitor.js - HYBRID SMART COPY TRADING con P&L CORRECTO
// ✅ PumpPortal Local API (1.75% total) + Jupiter (graduated tokens)

import { GraduationHandler } from './graduationHandler.js';
const graduationHandler = new GraduationHandler();
import IORedis from 'ioredis';
import { CopyStrategy } from './copyStrategy.js';
import { sendTelegramAlert } from './telegram.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { getPriceService } from './priceService.js';
import { PumpPortalExecutor } from './pumpPortalExecutor.js';
import { JupiterPriceService } from './jupiterPriceService.js';
import { PnLCalculator } from './pnlCalculator.js';

const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  retryDelayOnFailover: 100,
});

const connection = new Connection(process.env.RPC_URL, 'confirmed');
const copyStrategy = new CopyStrategy();
const priceService = getPriceService();

const ENABLE_TRADING = process.env.ENABLE_AUTO_TRADING === 'true';
const DRY_RUN = process.env.DRY_RUN !== 'false';
const LIVE_UPDATES = process.env.TELEGRAM_LIVE_UPDATES !== 'false';

// 🎯 HYBRID STRATEGY CONFIG
const WALLET_EXIT_WINDOW = 180000; // 3 minutes
const LOSS_PROTECTION_WINDOW = 600000; // 10 minutes
const INDEPENDENT_MODE_TIME = 600000; // After 10 min

let positionManager;
let pumpPortal = null;
let jupiterService = null;

// helper pequeño para delays
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (ENABLE_TRADING) {
  try {
    const { PositionManager } = await import('./riskManager.js');

    // ✅ Inicializar PumpPortal con Local API (no necesita API key)
    pumpPortal = new PumpPortalExecutor({
      RPC_URL: process.env.RPC_URL,
      PRIVATE_KEY: process.env.PRIVATE_KEY,
      DRY_RUN: process.env.DRY_RUN,
    });

    // ✅ Inicializar Jupiter para tokens graduados
    jupiterService = new JupiterPriceService({
      RPC_URL: process.env.RPC_URL,
      PRIVATE_KEY: process.env.PRIVATE_KEY,
    });

    positionManager = new PositionManager(redis);

    console.log(`💼 Smart Copy Trading ${DRY_RUN ? '📄 PAPER' : '💰 LIVE'} enabled`);
    console.log(`   Pump.fun: PumpPortal Local API (1.75% total fee)`);
    console.log(`   Graduated: Jupiter Ultra Swap (~0.3% fee)`);
    console.log(`   Position Size (ENV): ${process.env.POSITION_SIZE_SOL || '0.1'} SOL`);
    console.log(`   🎯 HYBRID exit strategy active\n`);
  } catch (error) {
    console.error('⚠️ Trading init failed:', error.message);
    console.error('   Stack:', error.stack);
    pumpPortal = null;
    jupiterService = null;
    positionManager = null;
  }
}

// Obtiene precio actual + valor en SOL usando PriceService (Pump.fun + Jupiter)
async function calculateCurrentValue(mint, tokenAmount) {
  try {
    const priceInfo = await priceService.getPrice(mint, { forceFresh: true });
    if (!priceInfo || !priceInfo.price) {
      return null;
    }

    const price = priceInfo.price;
    const solValue = Number(tokenAmount) * price;

    return {
      marketPrice: price,
      solValue,
      source: priceInfo.source,
      graduated: priceInfo.graduated,
    };
  } catch (error) {
    console.error('   ❌ Error calculating value:', error.message);
    return null;
  }
}

async function checkTrackedWalletSold(mint, walletAddress) {
  try {
    const recentSell = await redis.get(`wallet_sold:${walletAddress}:${mint}`);
    if (recentSell) {
      return {
        sold: true,
        timestamp: parseInt(recentSell),
        cached: true,
      };
    }

    const signatures = await connection.getSignaturesForAddress(
      new PublicKey(walletAddress),
      { limit: 20 },
    );

    for (const sig of signatures) {
      const fiveMinutesAgo = Date.now() - 300000;
      if (sig.blockTime * 1000 < fiveMinutesAgo) break;

      try {
        const tx = await connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (!tx || !tx.meta || tx.meta.err) continue;

        const postTokenBalances = tx.meta.postTokenBalances || [];
        const preTokenBalances = tx.meta.preTokenBalances || [];

        for (let i = 0; i < postTokenBalances.length; i++) {
          const post = postTokenBalances[i];
          const pre = preTokenBalances.find(
            (p) => p.accountIndex === post.accountIndex,
          );

          if (
            post.mint === mint &&
            pre &&
            post.uiTokenAmount.uiAmount < pre.uiTokenAmount.uiAmount
          ) {
            const sellTime = sig.blockTime * 1000;
            await redis.setex(
              `wallet_sold:${walletAddress}:${mint}`,
              600,
              sellTime.toString(),
            );

            return {
              sold: true,
              timestamp: sellTime,
              signature: sig.signature,
            };
          }
        }
      } catch (txError) {
        continue;
      }
    }

    return { sold: false };
  } catch (error) {
    console.error('   ⚠️ Error checking wallet sell:', error.message);
    return { sold: false };
  }
}

async function evaluateHybridExit(position, currentPrice, pnlPercent, currentSolValue) {
  const holdTime = Date.now() - parseInt(position.entryTime);
  const walletAddress = position.walletSource;
  const mint = position.mint;

  const walletSellCheck = await checkTrackedWalletSold(mint, walletAddress);

  if (!walletSellCheck.sold) {
    return { shouldExit: false, phase: 'none' };
  }

  const sellTime = walletSellCheck.timestamp;
  const timeSinceSell = Date.now() - sellTime;

  if (sellTime < parseInt(position.entryTime)) {
    return { shouldExit: false, phase: 'none' };
  }

  if (holdTime < WALLET_EXIT_WINDOW) {
    console.log(`\n⚡ PHASE 1: WALLET EXIT DETECTED (0-3 min)`);
    console.log(`   Hold time: ${Math.floor(holdTime / 1000)}s`);
    console.log(`   Wallet sold ${Math.floor(timeSinceSell / 1000)}s ago`);
    console.log(
      `   Current PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`,
    );
    console.log(`   🎯 Action: COPY EXIT (early phase)`);

    return {
      shouldExit: true,
      phase: 'phase1',
      reason: 'wallet_exit_early',
      description: `Tracked wallet sold in first 3 minutes`,
      priority: 2,
    };
  }

  if (holdTime >= WALLET_EXIT_WINDOW && holdTime < LOSS_PROTECTION_WINDOW) {
    if (pnlPercent < 0) {
      console.log(`\n🛡️ PHASE 2: WALLET EXIT + LOSS PROTECTION`);
      console.log(`   Hold time: ${Math.floor(holdTime / 1000)}s`);
      console.log(`   Wallet sold ${Math.floor(timeSinceSell / 1000)}s ago`);
      console.log(
        `   Current PnL: ${pnlPercent.toFixed(2)}% (NEGATIVE)`,
      );
      console.log(`   🎯 Action: COPY EXIT (protect loss)`);

      return {
        shouldExit: true,
        phase: 'phase2',
        reason: 'wallet_exit_loss_protection',
        description: `Wallet sold and position is negative (${pnlPercent.toFixed(
          2,
        )}%)`,
        priority: 2,
      };
    } else {
      console.log(`\n✋ PHASE 2: WALLET SOLD BUT HOLDING`);
      console.log(`   Hold time: ${Math.floor(holdTime / 1000)}s`);
      console.log(`   Wallet sold ${Math.floor(timeSinceSell / 1000)}s ago`);
      console.log(
        `   Current PnL: +${pnlPercent.toFixed(2)}% (POSITIVE)`,
      );
      console.log(
        `   🎯 Action: IGNORE wallet exit, use trailing stop`,
      );

      return { shouldExit: false, phase: 'phase2_holding' };
    }
  }

  if (holdTime >= INDEPENDENT_MODE_TIME) {
    console.log(`\n✅ PHASE 3: INDEPENDENT MODE`);
    console.log(`   Hold time: ${Math.floor(holdTime / 60000)} minutes`);
    console.log(`   Wallet sold ${Math.floor(timeSinceSell / 1000)}s ago`);
    console.log(
      `   Current PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`,
    );
    console.log(
      `   🎯 Action: IGNORE wallet exit, using trailing stop`,
    );

    return { shouldExit: false, phase: 'phase3_independent' };
  }

  return { shouldExit: false, phase: 'unknown' };
}

async function processCopySignals() {
  console.log('🎯 Copy signals processor started\n');

  while (true) {
    try {
      const signalJson = await Promise.race([
        redis.lpop('copy_signals'),
        new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);

      if (!signalJson) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      const copySignal = JSON.parse(signalJson);

      console.log(`\n🔥 Processing copy signal from ${copySignal.walletName}`);
      console.log(`   Mint: ${copySignal.mint.slice(0, 8)}...`);
      console.log(`   Upvotes: ${copySignal.upvotes}`);

      const decision = await copyStrategy.shouldCopy(copySignal);

      if (!decision.copy) {
        console.log(`   ❌ Copy rejected: ${decision.reason}\n`);
        continue;
      }

      const priceData = await priceService.getPrice(copySignal.mint, {
        forceFresh: true,
      });

      if (!priceData || !priceData.price) {
        console.log(`   ❌ Could not get price\n`);
        continue;
      }

      const currentPrice = priceData.price;

      console.log(`   💰 Executing ${decision.mode} trade...`);
      console.log(`   💵 Price: $${currentPrice.toFixed(10)}`);
      console.log(
        `   📊 Amount: ${decision.amount.toFixed(4)} SOL`,
      );

      if (ENABLE_TRADING && pumpPortal && positionManager) {
        const buyResult = await pumpPortal.buyToken(
          copySignal.mint,
          decision.amount,
          Number(process.env.COPY_SLIPPAGE || '10'),
          Number(process.env.PRIORITY_FEE || '0.0005'),
        );

        if (buyResult.success) {
          const mode = DRY_RUN ? '📄 PAPER' : '💰 LIVE';
          const executedDex =
            'Pump.fun (PumpPortal Local API - 1.75%)';

          console.log(`${mode} BUY EXECUTED via PumpPortal`);
          console.log(`   Tokens: ${buyResult.tokensReceived}`);
          console.log(`   Signature: ${buyResult.signature}\n`);

          await positionManager.openPosition(
            copySignal.mint,
            'COPY',
            currentPrice,
            decision.amount,
            buyResult.tokensReceived,
            buyResult.signature,
          );

          await redis.hset(`position:${copySignal.mint}`, {
            strategy: 'copy',
            walletSource: copySignal.walletAddress,
            walletName: copySignal.walletName,
            upvotes: decision.upvotes.toString(),
            buyers: JSON.stringify(decision.buyers),
            originalSignature: copySignal.signature,
            originalDex: copySignal.dex,
            executedDex: executedDex,
            confidence: decision.confidence.toString(),
            exitStrategy: 'hybrid_smart_exit',
          });

          // 🔥 Cooldown POR MINT eliminado: ahora el bot puede recomprar
          // el mismo token si copyStrategy lo permite, sin bloqueo extra.

          if (process.env.TELEGRAM_OWNER_CHAT_ID) {
            try {
              const confidenceEmoji =
                decision.confidence >= 80
                  ? '🔥'
                  : decision.confidence >= 60
                  ? '🟢'
                  : '🟡';

              await sendTelegramAlert(
                process.env.TELEGRAM_OWNER_CHAT_ID,
                `${confidenceEmoji} SMART COPY BUY\n\n` +
                  `Trader: ${copySignal.walletName}\n` +
                  `Token: ${copySignal.mint.slice(0, 16)}...\n` +
                  `\n` +
                  `🚀 Bought via: ${executedDex}\n` +
                  `${
                    copySignal.dex
                      ? `Original DEX: ${copySignal.dex}\n`
                      : ''
                  }` +
                  `Price: $${currentPrice.toFixed(10)}\n` +
                  `Amount: ${decision.amount.toFixed(4)} SOL\n` +
                  `\n` +
                  `Upvotes: ${decision.upvotes} wallet(s)\n` +
                  `Confidence: ${decision.confidence}%\n` +
                  `\n` +
                  `🎯 HYBRID Exit Strategy:\n` +
                  `• 0-3 min: Copy wallet exits\n` +
                  `• 3-10 min: Copy only on loss\n` +
                  `• 10+ min: Independent trading\n` +
                  `• Take Profit: +${
                    process.env.COPY_PROFIT_TARGET || 200
                  }%\n` +
                  `• Trailing Stop: -${
                    process.env.TRAILING_STOP || 35
                  }%\n` +
                  `• Stop Loss: -${
                    process.env.COPY_STOP_LOSS || 25
                  }%`,
                false,
              );
            } catch (e) {
              console.log('⚠️ Telegram notification failed');
            }
          }
        } else {
          console.log(`❌ BUY FAILED: ${buyResult.error}\n`);
        }
      }
    } catch (error) {
      console.error(
        '❌ Error processing copy signal:',
        error.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function processSellSignals() {
  while (true) {
    try {
      const signalJson = await redis.lpop('sell_signals');

      if (!signalJson) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      const sellSignal = JSON.parse(signalJson);
      const { mint, sellCount, sellers } = sellSignal;

      console.log(
        `\n📉 Processing sell signal for ${mint.slice(0, 8)}...`,
      );
      console.log(`   Sellers: ${sellCount}`);

      const hasPosition = await redis.sismember(
        'open_positions',
        mint,
      );

      if (!hasPosition) {
        console.log(`   ⭕️ No position in this token\n`);
        continue;
      }

      const position = await redis.hgetall(`position:${mint}`);

      if (!position || position.strategy !== 'copy') {
        continue;
      }

      const minToSell = parseInt(
        process.env.MIN_WALLETS_TO_SELL || '1',
      );

      if (sellCount >= minToSell) {
        console.log(
          `   🚨 ${sellCount}/${minToSell} wallets sold - FLAGGING FOR REVIEW`,
        );

        await redis.setex(
          `multiple_sellers:${mint}`,
          30,
          sellCount.toString(),
        );

        if (process.env.TELEGRAM_OWNER_CHAT_ID) {
          try {
            await sendTelegramAlert(
              process.env.TELEGRAM_OWNER_CHAT_ID,
              `⚠️ MULTIPLE TRADERS SELLING\n\n` +
                `Token: ${mint.slice(0, 16)}...\n` +
                `Sellers: ${sellCount}/${minToSell} wallets\n` +
                `\n` +
                `Hybrid strategy will evaluate exit...`,
              false,
            );
          } catch (e) {}
        }
      } else {
        console.log(
          `   ⏳ Only ${sellCount}/${minToSell} wallets sold - waiting\n`,
        );
      }
    } catch (error) {
      console.error(
        '❌ Error processing sell signal:',
        error.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

// 🆕 EMERGENCY EXIT para posiciones con datos rotos (P&L no calculable)
async function emergencyExit(position, currentPrice, approxSolValue) {
  try {
    const mint = position.mint;
    const tokensAmount = parseInt(position.tokensAmount || position.tokenAmount || '0');

    if (!tokensAmount || tokensAmount <= 0) {
      console.log(
        `   ⚠️ [EMERGENCY EXIT] No tokens balance stored, cleaning Redis for ${mint.slice(
          0,
          8,
        )}...`,
      );
      await redis.srem('open_positions', mint);
      await redis.persist(`position:${mint}`);
      return;
    }

    // Obtener info de precio / graduación
    const priceInfo = await priceService.getPrice(mint, { forceFresh: true });
    const exitPrice =
      priceInfo && priceInfo.price ? priceInfo.price : currentPrice;
    const isGraduatedFlag = priceInfo && priceInfo.graduated;

    // Delay opcional para Jupiter tras graduación
    let useJupiter = isGraduatedFlag;
    const gradTimeStr = position.graduationTime;
       const gradDelaySec = Number(
      process.env.JUPITER_GRAD_DELAY_SEC || '0',
    );

    if (useJupiter && gradTimeStr && gradDelaySec > 0) {
      const gradTime = parseInt(gradTimeStr);
      const elapsedSec = (Date.now() - gradTime) / 1000;

      if (elapsedSec < gradDelaySec) {
        const waitSec = Math.max(0, gradDelaySec - elapsedSec);
        console.log(
          `\n⏳ [EMERGENCY EXIT] Jupiter warmup: waiting ${waitSec.toFixed(
            1,
          )}s...`,
        );
        await sleep(waitSec * 1000);
      }
    }

    let sellResult;
    let executorLabel;

    if (!useJupiter) {
      // VENDER en Pump.fun via PumpPortal
      sellResult = await pumpPortal.sellToken(
        mint,
        tokensAmount,
        Number(process.env.COPY_SLIPPAGE || '10'),
        Number(process.env.PRIORITY_FEE || '0.0005'),
      );
      executorLabel = 'Pump.fun (PumpPortal Local API - 1.75%)';
    } else {
      // VENDER en Jupiter
      sellResult = await jupiterService.swapToken(
        mint,
        tokensAmount,
        Number(process.env.JUPITER_SLIPPAGE_BPS || '500'),
      );
      executorLabel = 'Jupiter Ultra Swap (~0.3%)';

      const errorMsg = sellResult && sellResult.error ? sellResult.error : '';
      const routeError =
        !sellResult.success &&
        (errorMsg.includes('Route not found') ||
          errorMsg.includes('COULD_NOT_FIND_ANY_ROUTE') ||
          errorMsg.includes('Could not find any route') ||
          errorMsg.includes('custom program error: 0x1789'));

      if (routeError) {
        console.log(
          '\n⚠️ [EMERGENCY EXIT] Jupiter failed, falling back to PumpPortal.',
        );
        sellResult = await pumpPortal.sellToken(
          mint,
          tokensAmount,
          Number(process.env.COPY_SLIPPAGE || '10'),
          Number(process.env.PRIORITY_FEE || '0.0005'),
        );
        executorLabel = 'Pump.fun (PumpPortal Local API - 1.75%)';
      }
    }

    if (!sellResult.success) {
      console.log(
        `❌ [EMERGENCY EXIT] SELL FAILED for ${mint.slice(
          0,
          8,
        )}...: ${sellResult.error}`,
      );
      return;
    }

    const mode = DRY_RUN ? '📄 PAPER' : '💰 LIVE';
    const solReceived =
      sellResult.solReceived ?? sellResult.expectedSOL ?? 0;

    console.log(
      `${mode} [EMERGENCY EXIT] SOLD ${tokensAmount} tokens of ${mint.slice(
        0,
        8,
      )}... via ${executorLabel}`,
    );
    console.log(`   SOL received: ${solReceived}`);
    console.log(`   Signature: ${sellResult.signature}\n`);

    // Cerrar posición en Redis SIN PnL (datos rotos)
    await redis.hmset(`position:${mint}`, {
      status: 'closed',
      exitPrice: exitPrice.toString(),
      exitTime: Date.now().toString(),
      solReceived: solReceived.toString(),
      reason: 'emergency_exit_invalid_fields',
      exitSignature: sellResult.signature,
    });

    await redis.srem('open_positions', mint);
    await redis.persist(`position:${mint}`);

    // Guardar en histórico básico
    const today = new Date().toISOString().split('T')[0];
    const tradeRecord = {
      ...position,
      exitPrice,
      solReceived,
      reason: 'emergency_exit_invalid_fields',
      closedAt: Date.now(),
      emergency: true,
    };
    await redis.rpush(`trades:${today}`, JSON.stringify(tradeRecord));
    await redis.expire(`trades:${today}`, 86400 * 30);

    // Telegram opcional
    if (process.env.TELEGRAM_OWNER_CHAT_ID) {
      try {
        await sendTelegramAlert(
          process.env.TELEGRAM_OWNER_CHAT_ID,
          `⚠️ EMERGENCY EXIT (invalid PnL fields)\n\n` +
            `Token: ${mint.slice(0, 16)}...\n` +
            `Executor: ${executorLabel}\n` +
            `Mode: ${mode}\n` +
            `Exit price (approx): $${exitPrice.toFixed(10)}\n` +
            `SOL received: ${solReceived}\n` +
            `\n` +
            `The position had inconsistent data in Redis, so it was closed automatically to free the slot.`,
          false,
        );
      } catch (e) {
        console.log('⚠️ Telegram emergency exit notification failed');
      }
    }
  } catch (error) {
    console.error(
      '❌ [EMERGENCY EXIT] Unexpected error while closing broken position:',
      error.message,
    );
  }
}

async function monitorOpenPositions() {
  let lastUpdate = {};

  while (true) {
    try {
      if (!ENABLE_TRADING || !pumpPortal || !positionManager) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      const openPositions = await positionManager.getOpenPositions();

      for (const position of openPositions) {
        if (position.strategy !== 'copy') {
          continue;
        }

        // Tokens de la posición
        const tokensAmount = Number(
          position.tokensAmount || position.tokenAmount || '0',
        );

        const valueData = await calculateCurrentValue(
          position.mint,
          tokensAmount,
        );

        if (!valueData) {
          console.log(
            `   ⚠️ Could not get current value for ${position.mint.slice(
              0,
              8,
            )}`,
          );
          continue;
        }

        const currentPrice = valueData.marketPrice;
        const executor = valueData.graduated
          ? 'jupiter'
          : 'pumpportal';

        // 🔎 VALIDAR CAMPOS ANTES DE CALCULAR PnL
        const entryPriceNum = Number(position.entryPrice);
        const solSpentNum = Number(position.solAmount || position.solSpent);

        const hasMissingFields =
          !entryPriceNum ||
          !solSpentNum ||
          !tokensAmount ||
          !currentPrice;

        if (hasMissingFields) {
          console.log(
            `\n⚠️ Invalid PnL fields for ${position.mint.slice(
              0,
              8,
            )}... → EMERGENCY EXIT`,
          );
          await emergencyExit(position, currentPrice, valueData.solValue);
          continue;
        }

        // ✅ CALCULAR PnL UNREALIZADO CORRECTO
        const unrealizedPnL = PnLCalculator.calculateUnrealizedPnL(
          position,
          currentPrice,
          {
            executor: executor,
            estimatedSlippage: 0.02, // 2% estimado
            networkFee: 0.000005,
            priorityFee: Number(
              process.env.PRIORITY_FEE || '0.0005',
            ),
          },
        );

        const pnlPercent = unrealizedPnL.pnlPercent;
        const pnlSOL = unrealizedPnL.pnlSOL;

        // Actualizar max price si es necesario
        const maxPrice = parseFloat(
          position.maxPrice || position.entryPrice,
        );
        if (currentPrice > maxPrice) {
          await positionManager.updateMaxPrice(
            position.mint,
            currentPrice,
          );
        }

        // Logs periódicos con PnL correcto
        const now = Date.now();
        const lastUpd = lastUpdate[position.mint] || 0;
        if (LIVE_UPDATES && now - lastUpd >= 5000) {
          console.log(
            `\n📊 ${position.mint.slice(0, 8)}... | ${executor.toUpperCase()}`,
          );
          console.log(`  Price: $${currentPrice.toFixed(10)}`);
          console.log(
            `  ${
              pnlPercent >= 0 ? '🟢' : '🔴'
            } PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(
              2,
            )}% (${pnlSOL >= 0 ? '+' : ''}${pnlSOL.toFixed(4)} SOL)`,
          );
          console.log(
            `  Est. Net if sold now: ${unrealizedPnL.current.netReceived.toFixed(
              4,
            )} SOL`,
          );
          lastUpdate[position.mint] = now;
        }

        // Force exit por graduación
        const forceExit = await redis.get(
          `force_exit:${position.mint}`,
        );
        if (forceExit) {
          await redis.del(`force_exit:${position.mint}`);

          console.log(`\n🎓 FORCE EXIT: Graduation detected`);
          console.log(`   Reason: ${forceExit}`);
          console.log(
            `   PnL: ${
              pnlPercent >= 0 ? '+' : ''
            }${pnlPercent.toFixed(2)}% (${
              pnlSOL >= 0 ? '+' : ''
            }${pnlSOL.toFixed(4)} SOL)`,
          );
          console.log(
            `   Priority: 1 (Graduation override)\n`,
          );

          await executeSell(
            position,
            currentPrice,
            unrealizedPnL.current.netReceived,
            forceExit,
          );
          continue;
        }

        // Evaluación híbrida de salida
        const hybridExit = await evaluateHybridExit(
          position,
          currentPrice,
          pnlPercent,
          unrealizedPnL.current.netReceived,
        );

        if (hybridExit.shouldExit) {
          console.log(
            `\n🎯 HYBRID EXIT: ${hybridExit.reason.toUpperCase()}`,
          );
          console.log(`   ${hybridExit.description}`);
          console.log(`   Phase: ${hybridExit.phase}`);
          console.log(
            `   PnL: ${
              pnlPercent >= 0 ? '+' : ''
            }${pnlPercent.toFixed(2)}% (${
              pnlSOL >= 0 ? '+' : ''
            }${pnlSOL.toFixed(4)} SOL)`,
          );
          console.log(
            `   Priority: ${hybridExit.priority}\n`,
          );

          await executeSell(
            position,
            currentPrice,
            unrealizedPnL.current.netReceived,
            hybridExit.reason,
          );
          continue;
        }

        // Evaluación de estrategia de salida
        const exitDecision = await copyStrategy.shouldExit(
          position,
          currentPrice,
        );

        if (exitDecision.exit) {
          const displayPnL =
            exitDecision.pnl !== undefined
              ? exitDecision.pnl
              : pnlPercent;

          console.log(
            `\n🚪 EXIT SIGNAL: ${exitDecision.reason.toUpperCase()}`,
          );
          console.log(`   ${exitDecision.description}`);
          console.log(
            `   PnL Strategy: ${
              displayPnL >= 0 ? '+' : ''
            }${displayPnL.toFixed(2)}%`,
          );
          console.log(
            `   Priority: ${exitDecision.priority || 'N/A'}\n`,
          );

          await executeSell(
            position,
            currentPrice,
            unrealizedPnL.current.netReceived,
            exitDecision.reason,
          );

          await new Promise((resolve) =>
            setTimeout(resolve, 5000),
          );
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(
        '❌ Error monitoring positions:',
        error.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// 🧠 AQUÍ VAN LOS CAMBIOS IMPORTANTES:
// - Delay opcional después de la graduación antes de usar Jupiter
// - Fallback a PumpPortal si Jupiter no tiene ruta o da 0x1789
async function executeSell(position, currentPrice, _currentSolValue, reason) {
  try {
    const tokensAmount = parseInt(position.tokensAmount);

    // Obtener precio fresco y estado de graduación
    const priceInfo = await priceService.getPrice(position.mint, {
      forceFresh: true,
    });
    const exitPrice =
      priceInfo && priceInfo.price ? priceInfo.price : currentPrice;
    const isGraduatedFlag = priceInfo && priceInfo.graduated;

    // Delay opcional después de que la bonding curve marca "complete"
    let useJupiter = isGraduatedFlag;
    const gradTimeStr = position.graduationTime;
    const gradDelaySec = Number(process.env.JUPITER_GRAD_DELAY_SEC || '0');

    if (useJupiter && gradTimeStr && gradDelaySec > 0) {
      const gradTime = parseInt(gradTimeStr);
      const elapsedSec = (Date.now() - gradTime) / 1000;

      if (elapsedSec < gradDelaySec) {
        const waitSec = Math.max(0, gradDelaySec - elapsedSec);
        console.log(
          `\n⏳ Jupiter route warmup: waiting ${waitSec.toFixed(
            1,
          )}s before first Jupiter sell...`,
        );
        await sleep(waitSec * 1000);
      }
    }

    let sellResult;
    let executor;
    let executorLabel;

    if (!useJupiter) {
      // ✅ VENTA EN PUMP.FUN via PumpPortal Local API
      sellResult = await pumpPortal.sellToken(
        position.mint,
        tokensAmount,
        Number(process.env.COPY_SLIPPAGE || '10'),
        Number(process.env.PRIORITY_FEE || '0.0005'),
      );
      executor = 'pumpportal';
      executorLabel = 'Pump.fun (PumpPortal Local API - 1.75%)';
    } else {
      // ✅ VENTA EN JUPITER (TOKEN GRADUADO)
      sellResult = await jupiterService.swapToken(
        position.mint,
        tokensAmount,
        Number(process.env.JUPITER_SLIPPAGE_BPS || '500'),
      );
      executor = 'jupiter';
      executorLabel = 'Jupiter Ultra Swap (~0.3%)';

      // 🔁 FALLBACK: si Jupiter falla por falta de ruta / error 0x1789, volver a PumpPortal
      const errorMsg = sellResult && sellResult.error ? sellResult.error : '';
      const routeError =
        !sellResult.success &&
        (errorMsg.includes('Route not found') ||
          errorMsg.includes('COULD_NOT_FIND_ANY_ROUTE') ||
          errorMsg.includes('Could not find any route') ||
          errorMsg.includes('custom program error: 0x1789'));

      if (routeError) {
        console.log(
          '\n⚠️ Jupiter route not ready / simulation failed. Falling back to PumpPortal for this sell.',
        );

        sellResult = await pumpPortal.sellToken(
          position.mint,
          tokensAmount,
          Number(process.env.COPY_SLIPPAGE || '10'),
          Number(process.env.PRIORITY_FEE || '0.0005'),
        );

        executor = 'pumpportal';
        executorLabel = 'Pump.fun (PumpPortal Local API - 1.75%)';
      }
    }

    if (sellResult.success) {
      const mode = DRY_RUN ? '📄 PAPER' : '💰 LIVE';
      const solReceived =
        sellResult.solReceived ?? sellResult.expectedSOL ?? 0;

      console.log(`${mode} SELL EXECUTED via ${executorLabel}`);
      console.log(`   SOL received: ${solReceived}`);
      console.log(`   Signature: ${sellResult.signature}\n`);

      // ✅ CALCULAR PnL CORRECTO CON FEES REALES
      const pnlData = PnLCalculator.calculatePnL({
        entryPrice: parseFloat(position.entryPrice),
        exitPrice: exitPrice,
        tokenAmount: tokensAmount,
        solSpent: parseFloat(position.solAmount),
        executor: executor,
        slippage: 0, // En producción, calcular del resultado real
        networkFee: 0.000005,
        priorityFee: Number(process.env.PRIORITY_FEE || '0.0005'),
      });

      // Verificar discrepancias (útil para debug)
      PnLCalculator.checkDiscrepancy({
        entryPrice: parseFloat(position.entryPrice),
        exitPrice: exitPrice,
        tokenAmount: tokensAmount,
        solSpent: parseFloat(position.solAmount),
        executor: executor,
      });

      // Cerrar posición con PnL correcto
      const closedPosition = await positionManager.closePosition(
        position.mint,
        exitPrice,
        tokensAmount,
        pnlData.netReceived, // Usar el valor neto calculado
        reason,
        sellResult.signature,
      );

      // Telegram notification con PnL correcto
      if (process.env.TELEGRAM_OWNER_CHAT_ID && closedPosition) {
        try {
          const emoji = pnlData.pnlPercent >= 0 ? '✅' : '❌';
          const holdTime = (
            (Date.now() - parseInt(position.entryTime)) /
            1000
          ).toFixed(0);

          const reasonMap = {
            wallet_exit_early: '⚡ Phase 1: Wallet Exit',
            wallet_exit_loss_protection:
              '🛡️ Phase 2: Loss Protection',
            take_profit: '💰 Take Profit',
            trailing_stop: '📉 Trailing Stop',
            stop_loss: '🛑 Stop Loss',
            graduation: '🎓 Token Graduated',
          };

          await sendTelegramAlert(
            process.env.TELEGRAM_OWNER_CHAT_ID,
            `${emoji} ${mode} EXIT: ${
              reasonMap[reason] || reason
            }\n\n` +
              `Token: ${position.mint.slice(0, 16)}...\n` +
              `Executor: ${executorLabel}\n` +
              `Hold: ${holdTime}s\n\n` +
              `Entry: $${parseFloat(
                position.entryPrice,
              ).toFixed(10)}\n` +
              `Exit: $${exitPrice.toFixed(10)}\n\n` +
              `💰 PnL: ${
                pnlData.pnlPercent >= 0 ? '+' : ''
              }${pnlData.pnlPercent}% ` +
              `(${
                pnlData.pnlSOL >= 0 ? '+' : ''
              }${pnlData.pnlSOL} SOL)\n` +
              `📊 Price Change: ${
                pnlData.priceChangePercent >= 0 ? '+' : ''
              }${pnlData.priceChangePercent}%\n` +
              `💸 Fees Impact: ${(
                pnlData.pnlPercent - pnlData.priceChangePercent
              ).toFixed(2)}%\n\n` +
              `Net Received: ${pnlData.netReceived} SOL`,
            false,
          );
        } catch (e) {
          console.log('⚠️ Telegram notification failed');
        }
      }
    } else {
      console.log(`❌ SELL FAILED: ${sellResult.error}\n`);
    }
  } catch (error) {
    console.error('❌ Error executing sell:', error.message);
  }
}

// ✅ FIXED: Complete sendPnLUpdate function
async function sendPnLUpdate(
  position,
  currentPrice,
  pnlPercent,
  currentSolValue,
) {
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!chatId) return;

  try {
    const entryPrice = parseFloat(position.entryPrice);
    const maxPrice = parseFloat(position.maxPrice || entryPrice);
    const holdTime = (
      (Date.now() - parseInt(position.entryTime)) /
      1000
    ).toFixed(0);
    const upvotes = parseInt(position.upvotes || '1');
    const solSpent = parseFloat(position.solAmount);
    const pnlSOL = currentSolValue - solSpent;

    const sellCount =
      (await redis.scard(
        `upvotes:${position.mint}:sellers`,
      )) || 0;
    const minToSell = parseInt(
      process.env.MIN_WALLETS_TO_SELL || '1',
    );

    const holdTimeMs = Date.now() - parseInt(position.entryTime);
    let phaseInfo = '';
    if (holdTimeMs < WALLET_EXIT_WINDOW) {
      phaseInfo = '⚡ Phase 1: Following wallet';
    } else if (holdTimeMs < LOSS_PROTECTION_WINDOW) {
      phaseInfo =
        pnlPercent < 0
          ? '🛡️ Phase 2: Loss protection active'
          : '🟢 Phase 2: Letting it run';
    } else {
      phaseInfo = '🚀 Phase 3: Independent mode';
    }

    const emoji =
      pnlPercent >= 20
        ? '🚀'
        : pnlPercent >= 10
        ? '📈'
        : pnlPercent >= 0
        ? '🟢'
        : pnlPercent >= -5
        ? '🟡'
        : '🔴';

    await sendTelegramAlert(
      chatId,
      `${emoji} P&L UPDATE\n\n` +
        `Mint: ${position.mint.slice(0, 16)}...\n` +
        `Entry: $${entryPrice.toFixed(10)}\n` +
        `Current: $${currentPrice.toFixed(10)}\n` +
        `Max: $${maxPrice.toFixed(10)}\n` +
        `\n` +
        `💰 PnL: ${
          pnlPercent >= 0 ? '+'
            : ''
        }${pnlPercent.toFixed(2)}% ` +
        `(${
          pnlSOL >= 0 ? '+'
            : ''
        }${pnlSOL.toFixed(4)} SOL)\n` +
        `⏱️ Hold: ${holdTime}s\n` +
        `🎯 Upvotes: ${upvotes}\n` +
        `📉 Sellers: ${sellCount}/${minToSell}\n` +
        `\n` +
        `${phaseInfo}`,
      true,
    );
  } catch (e) {}
}

setInterval(async () => {
  try {
    const openPositions = await redis.scard('open_positions');
    const pendingSignals = await redis.llen('copy_signals');

    if (openPositions > 0 || pendingSignals > 0) {
      const mode = DRY_RUN ? '📄 PAPER' : '💰 LIVE';
      console.log(
        `\n${mode} - Positions: ${openPositions} | Pending: ${pendingSignals}\n`,
      );
    }
  } catch (error) {}
}, 60000);

console.log('🚀 Copy Monitor HYBRID strategy started');
console.log(
  `   Mode: ${
    DRY_RUN ? '📄 PAPER TRADING' : '💰 LIVE TRADING'
  }`,
);
console.log(
  `   Pump.fun: PumpPortal Local API (1.75% fee)`,
);
console.log(
  `   Graduated: Jupiter Ultra Swap (~0.3%)`,
);
console.log(
  `   🎯 HYBRID exit: Phase 1-3 with trailing stop\n`,
);

Promise.all([
  processCopySignals(),
  processSellSignals(),
  monitorOpenPositions(),
]).catch((error) => {
  console.error('❌ Copy monitor crashed:', error.message);
  process.exit(1);
});
