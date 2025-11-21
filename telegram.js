// telegram.js - FIXED: Constructor correcto para PumpPortalExecutor
import TelegramBot from 'node-telegram-bot-api';
import IORedis from 'ioredis';
import { getPriceService } from './priceService.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;

let bot, redis;
const priceService = getPriceService();

async function safeSend(chatId, text, silent = false) {
  if (!bot || !chatId) return false;

  try {
    const cleanText = text
      .replace(/\*/g, '')
      .replace(/`/g, '')
      .replace(/_/g, '')
      .replace(/\[/g, '')
      .replace(/\]/g, '');

    await bot.sendMessage(chatId, cleanText, {
      disable_notification: silent,
    });
    return true;
  } catch (error) {
    console.log('⚠️ Telegram send failed:', error.message);
    return false;
  }
}

export async function initTelegram() {
  if (!BOT_TOKEN) {
    console.log('⚠️ TELEGRAM_BOT_TOKEN not set, skipping Telegram bot');
    return;
  }

  try {
    bot = new TelegramBot(BOT_TOKEN, {
      polling: true,
      request: {
        agentOptions: {
          keepAlive: true,
          family: 4,
        },
      },
    });

    redis = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      retryDelayOnFailover: 100,
    });

    console.log('✅ Telegram bot initialized');

    // === COMANDOS ===

    bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return bot.sendMessage(chatId, '⛔ Unauthorized');
      }

      await safeSend(
        chatId,
        `💼 Copy Trading Bot v3\n\n` +
          `📊 General:\n` +
          `/status - Current status\n` +
          `/positions - Open positions\n` +
          `/stats - Today's performance\n\n` +
          `👁️ Wallets:\n` +
          `/wallets - List tracked wallets\n` +
          `/add_wallet ADDRESS NAME - Add wallet\n` +
          `/remove_wallet ADDRESS - Remove wallet\n\n` +
          `💰 Trading:\n` +
          `/sell MINT - Manual sell\n` +
          `/sell_all - Close all positions`
      );
    });

    bot.onText(/\/status/, async (msg) => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return;
      }

      try {
        const openPositions = await redis.scard('open_positions');
        const trackedWallets = await redis.scard('tracked_wallets');
        const pendingSignals = await redis.llen('copy_signals');

        const mode =
          process.env.DRY_RUN !== 'false' ? '📝 PAPER' : '💰 LIVE';

        let totalPnL = 0;
        const positionMints = await redis.smembers('open_positions');

        for (const mint of positionMints) {
          const position = await redis.hgetall(`position:${mint}`);
          if (position && position.strategy === 'copy') {
            const entryPrice = parseFloat(position.entryPrice);
            const priceData = await priceService.getPrice(mint, { forceFresh: true });

            if (priceData && priceData.price && !isNaN(priceData.price)) {
              const pnlPercent =
                ((priceData.price - entryPrice) / entryPrice) * 100;
              const pnlSOL =
                (pnlPercent / 100) * parseFloat(position.solAmount);
              totalPnL += pnlSOL;
            }
          }
        }

        await safeSend(
          chatId,
          `📊 Status\n\n` +
            `Mode: ${mode}\n` +
            `Tracked Wallets: ${trackedWallets}\n` +
            `Open Positions: ${openPositions}/${
              process.env.MAX_POSITIONS || 2
            }\n` +
            `Pending Signals: ${pendingSignals}\n` +
            `\n` +
            `💰 Total P&L: ${totalPnL.toFixed(4)} SOL`
        );
      } catch (error) {
        await safeSend(chatId, `❌ Error: ${error.message}`);
      }
    });

    // ✅ /positions con Price Service
    bot.onText(/\/positions/, async (msg) => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return;
      }

      try {
        const { PositionManager } = await import('./riskManager.js');
        const positionManager = new PositionManager(redis);
        const positions = await positionManager.getOpenPositions();

        const copyPositions = positions.filter(
          (p) => p.strategy === 'copy'
        );

        if (copyPositions.length === 0) {
          return safeSend(chatId, '🔭 No open positions');
        }

        let message = '📈 Open Positions:\n\n';

        for (const pos of copyPositions) {
          const entryPrice = parseFloat(pos.entryPrice);

          // ✅ USAR PRICE SERVICE
          const priceData = await priceService.getPrice(pos.mint, { forceFresh: true });

          let currentPrice = entryPrice; // Fallback
          let isGraduated = false;

          if (priceData && priceData.price && !isNaN(priceData.price)) {
            currentPrice = priceData.price;
            isGraduated =
              priceData.graduated ||
              priceData.source === 'jupiter';
          } else {
            console.log(
              `   ⚠️ Using entry price as fallback for ${pos.mint.slice(
                0,
                8
              )}`
            );
          }

          const pnlPercent =
            ((currentPrice - entryPrice) / entryPrice) * 100;
          const pnl = pnlPercent.toFixed(2);
          const pnlSOL =
            (pnlPercent / 100) * parseFloat(pos.solAmount);
          const emoji = parseFloat(pnl) >= 0 ? '🟢' : '🔴';
          const holdTime = (
            (Date.now() - parseInt(pos.entryTime)) /
            1000
          ).toFixed(0);
          const upvotes = pos.upvotes || '1';

          const posNum = copyPositions.indexOf(pos) + 1;
          const graduatedTag = isGraduated ? ' 🎓' : '';

          message += `${emoji} Position ${posNum}${graduatedTag}\n`;
          message += `Wallet: ${pos.walletName || 'Unknown'}\n`;
          message += `Mint: ${pos.mint.slice(0, 12)}...\n`;
          message += `Entry: ${entryPrice.toFixed(8)}\n`;
          message += `Current: ${currentPrice.toFixed(8)}\n`;
          message += `PnL: ${pnl}% | ${pnlSOL.toFixed(4)} SOL\n`;
          message += `Hold: ${holdTime}s | Votes: ${upvotes}\n`;
          if (isGraduated) {
            message += `Status: GRADUATED (DEX price)\n`;
          }
          message += `/sell ${pos.mint.slice(0, 8)}\n\n`;
        }

        await safeSend(chatId, message);
      } catch (error) {
        await safeSend(chatId, `❌ Error: ${error.message}`);
      }
    });

    // ✅ /sell con constructor CORRECTO
    bot.onText(/\/sell(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return;
      }

      const mintArg = match[1]?.trim();

      if (!mintArg) {
        return safeSend(
          chatId,
          `💰 Manual Sell\n\n` +
            `Usage: /sell MINT\n` +
            `Example: /sell 7xKXtGH4\n\n` +
            `Use /positions to see open positions`
        );
      }

      try {
        await safeSend(chatId, '⏳ Processing manual sell...');

        const positionMints = await redis.smembers('open_positions');
        let targetMint = null;

        for (const mint of positionMints) {
          if (mint.startsWith(mintArg) || mint.includes(mintArg)) {
            targetMint = mint;
            break;
          }
        }

        if (!targetMint) {
          return safeSend(
            chatId,
            `❌ No position found for: ${mintArg}`
          );
        }

        const position = await redis.hgetall(`position:${targetMint}`);

        if (!position || position.strategy !== 'copy') {
          return safeSend(chatId, `❌ Invalid position`);
        }

        // ✅ PRICE SERVICE para PnL y detectar graduation
        const priceData = await priceService.getPrice(targetMint, { forceFresh: true });

        if (!priceData || !priceData.price || isNaN(priceData.price)) {
          return safeSend(
            chatId,
            `❌ Could not get current price\n` +
              `Token may be graduated - try again`
          );
        }

        const currentPrice = priceData.price;
        const entryPrice = parseFloat(position.entryPrice);
        const pnlPercent =
          ((currentPrice - entryPrice) / entryPrice) * 100;
        const isGraduated =
          priceData.graduated ||
          priceData.source === 'jupiter';

        // ✅ Constructor CORRECTO
        const { PumpPortalExecutor } = await import('./pumpPortalExecutor.js');
        const { PositionManager } = await import('./riskManager.js');

        const tradeExecutor = new PumpPortalExecutor({
          RPC_URL: process.env.RPC_URL,
          PRIVATE_KEY: process.env.PRIVATE_KEY,
          DRY_RUN: process.env.DRY_RUN,
        });

        const dexLabel = isGraduated
          ? 'Jupiter (graduated)'
          : 'Pump.fun (Local API)';

        console.log(`\n💰 Manual sell: ${targetMint.slice(0, 8)}`);
        console.log(`   Graduated: ${isGraduated}`);
        console.log(`   Route: ${dexLabel}`);

        const sellResult = await tradeExecutor.sellToken(
          targetMint,
          parseInt(position.tokensAmount),
          Number(process.env.COPY_SLIPPAGE || '10'),
          Number(process.env.PRIORITY_FEE || '0.0005')
        );

        if (sellResult.success) {
          const positionManager = new PositionManager(redis);
          const closedPosition = await positionManager.closePosition(
            targetMint,
            currentPrice,
            parseInt(position.tokensAmount),
            sellResult.solReceived,
            'manual_sell',
            sellResult.signature
          );

          const mode = process.env.DRY_RUN !== 'false' ? '📝 PAPER' : '💰 LIVE';
          const graduatedTag = isGraduated ? ' 🎓' : '';

          await safeSend(
            chatId,
            `✅ ${mode} MANUAL SELL${graduatedTag}\n\n` +
              `Mint: ${targetMint.slice(0, 12)}...\n` +
              `Route: ${dexLabel}\n` +
              `Entry: ${entryPrice.toFixed(8)}\n` +
              `Exit: ${currentPrice.toFixed(8)}\n` +
              `\n` +
              `💰 PnL: ${pnlPercent.toFixed(2)}%\n` +
              `Amount: ${parseFloat(
                closedPosition.pnlSOL
              ).toFixed(4)} SOL\n` +
              `\n` +
              `Signature: ${sellResult.signature.slice(0, 12)}...`
          );
        } else {
          await safeSend(
            chatId,
            `❌ Sell failed: ${sellResult.error}`
          );
        }
      } catch (error) {
        await safeSend(chatId, `❌ Error: ${error.message}`);
      }
    });

    // ✅ /sell_all con constructor CORRECTO
    bot.onText(/\/sell_all/, async (msg) => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return;
      }

      try {
        await safeSend(chatId, '⏳ Closing all positions...');

        const { PositionManager } = await import('./riskManager.js');
        const positionManager = new PositionManager(redis);
        const positions = await positionManager.getOpenPositions();

        const copyPositions = positions.filter(
          (p) => p.strategy === 'copy'
        );

        if (copyPositions.length === 0) {
          return safeSend(chatId, '🔭 No positions to close');
        }

        // ✅ Constructor CORRECTO
        const { PumpPortalExecutor } = await import('./pumpPortalExecutor.js');
        
        const tradeExecutor = new PumpPortalExecutor({
          RPC_URL: process.env.RPC_URL,
          PRIVATE_KEY: process.env.PRIVATE_KEY,
          DRY_RUN: process.env.DRY_RUN,
        });

        let closed = 0;
        let failed = 0;

        for (const position of copyPositions) {
          try {
            const priceData = await priceService.getPrice(position.mint, { forceFresh: true });

            if (!priceData || !priceData.price) {
              failed++;
              continue;
            }

            const isGraduated =
              priceData.graduated ||
              priceData.source === 'jupiter';

            const sellResult = await tradeExecutor.sellToken(
              position.mint,
              parseInt(position.tokensAmount),
              Number(process.env.COPY_SLIPPAGE || '10'),
              Number(process.env.PRIORITY_FEE || '0.0005')
            );

            if (sellResult.success) {
              await positionManager.closePosition(
                position.mint,
                priceData.price,
                parseInt(position.tokensAmount),
                sellResult.solReceived,
                isGraduated
                  ? 'manual_sell_all_graduated'
                  : 'manual_sell_all',
                sellResult.signature
              );
              closed++;
            } else {
              failed++;
            }
          } catch (e) {
            failed++;
          }
        }

        await safeSend(
          chatId,
          `✅ Closed All Positions\n\n` +
            `Closed: ${closed}\n` +
            `Failed: ${failed}`
        );
      } catch (error) {
        await safeSend(chatId, `❌ Error: ${error.message}`);
      }
    });

    bot.onText(/\/wallets/, async (msg) => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return;
      }

      try {
        const { getWalletTracker } = await import('./walletTracker.js');
        const tracker = getWalletTracker();

        if (!tracker) {
          return safeSend(
            chatId,
            '⚠️ Wallet tracker not initialized'
          );
        }

        const wallets = tracker.getTrackedWallets();

        if (wallets.length === 0) {
          return safeSend(
            chatId,
            '🔭 No wallets tracked\n\nUse /add_wallet to start'
          );
        }

        let message = '👁️ Tracked Wallets:\n\n';

        for (const wallet of wallets) {
          const stats = await tracker.getWalletStats(wallet.address);

          message += `${wallet.name}\n`;
          message += `${wallet.address.slice(0, 12)}...\n`;
          message += `Copy: ${wallet.copyPercentage}% | ${
            wallet.enabled ? 'Active' : 'Paused'
          }\n`;
          message += `Amount: ${
            process.env.POSITION_SIZE_SOL || '0.1'
          } SOL\n`;
          message += `Trades: ${
            stats.totalDetected
          } detected, ${stats.totalCopied} copied\n`;
          if (stats.totalCopied > 0) {
            message += `Win Rate: ${stats.winRate} | P&L: ${stats.totalPnL}\n`;
          }
          message += `/remove_wallet ${wallet.address.slice(0, 12)}\n\n`;
        }

        await safeSend(chatId, message);
      } catch (error) {
        await safeSend(chatId, `❌ Error: ${error.message}`);
      }
    });

    bot.onText(/\/add_wallet (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return;
      }

      try {
        const parts = match[1].trim().split(' ');
        const address = parts[0];
        const name = parts[1] || `Wallet-${address.slice(0, 8)}`;
        const copyPercentage = 100;

        const { getWalletTracker } = await import('./walletTracker.js');
        const tracker = getWalletTracker();

        if (!tracker) {
          return safeSend(
            chatId,
            '⚠️ Wallet tracker not initialized'
          );
        }

        const result = await tracker.addWallet(address, {
          name,
          copyPercentage,
          minAmount: parseFloat(
            process.env.POSITION_SIZE_SOL || '0.1'
          ),
          maxAmount: parseFloat(
            process.env.POSITION_SIZE_SOL || '0.1'
          ),
        });

        if (result) {
          await safeSend(
            chatId,
            `✅ Wallet Added\n\n` +
              `Name: ${name}\n` +
              `Address: ${address.slice(0, 12)}...\n` +
              `Copy: ${copyPercentage}%\n` +
              `Amount: ${
                process.env.POSITION_SIZE_SOL || '0.1'
              } SOL\n\n` +
              `Now tracking trades`
          );
        } else {
          await safeSend(chatId, '❌ Failed to add wallet');
        }
      } catch (error) {
        await safeSend(chatId, `❌ Error: ${error.message}`);
      }
    });

    bot.onText(/\/remove_wallet (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return;
      }

      try {
        const addressArg = match[1].trim();

        const { getWalletTracker } = await import('./walletTracker.js');
        const tracker = getWalletTracker();

        if (!tracker) {
          return safeSend(
            chatId,
            '⚠️ Wallet tracker not initialized'
          );
        }

        const wallets = tracker.getTrackedWallets();
        let targetWallet = null;

        for (const wallet of wallets) {
          if (
            wallet.address === addressArg ||
            wallet.address.startsWith(addressArg)
          ) {
            targetWallet = wallet;
            break;
          }
        }

        if (!targetWallet) {
          return safeSend(
            chatId,
            `❌ Wallet not found: ${addressArg}`
          );
        }

        const result = await tracker.removeWallet(targetWallet.address);

        if (result) {
          await safeSend(
            chatId,
            `✅ Wallet Removed\n\n` +
              `Name: ${targetWallet.name}\n` +
              `Address: ${targetWallet.address.slice(0, 12)}...\n\n` +
              `No longer tracking trades`
          );
        } else {
          await safeSend(chatId, '❌ Failed to remove wallet');
        }
      } catch (error) {
        await safeSend(chatId, `❌ Error: ${error.message}`);
      }
    });

    bot.onText(/\/stats/, async (msg) => {
      const chatId = msg.chat.id;

      if (OWNER_CHAT_ID && chatId.toString() !== OWNER_CHAT_ID) {
        return;
      }

      try {
        const { RiskManager } = await import('./riskManager.js');
        const riskManager = new RiskManager({}, redis);
        const stats = await riskManager.getDailyStats();

        if (!stats || stats.totalTrades === 0) {
          return safeSend(chatId, '🔭 No trades today yet');
        }

        await safeSend(
          chatId,
          `📊 Today's Performance\n\n` +
            `Total Trades: ${stats.totalTrades}\n` +
            `Wins: ${stats.wins} | Losses: ${stats.losses}\n` +
            `Win Rate: ${stats.winRate}\n` +
            `Total P&L: ${stats.totalPnL} SOL\n` +
            `Avg P&L: ${stats.avgPnL} SOL\n` +
            `Best: ${stats.biggestWin} SOL\n` +
            `Worst: ${stats.biggestLoss} SOL`
        );
      } catch (error) {
        await safeSend(chatId, `❌ Error: ${error.message}`);
      }
    });

    bot.on('polling_error', (error) => {
      console.log('Telegram polling error:', error.message);
    });

    console.log('✅ Telegram bot commands registered');
  } catch (error) {
    console.error('❌ Failed to initialize Telegram bot:', error.message);
  }
}

export async function sendTelegramAlert(chatId, message, silent = false) {
  await safeSend(chatId, message, silent);
}
