// worker.js - Copy Trading Worker with ENV CLEANER
import 'dotenv/config';
import { cleanAndValidateEnv } from './envCleaner.js';

// 🧹 CRITICAL: Clean environment variables FIRST
console.log('🚀 Starting Copy Trading Worker...\n');
const envCleaner = cleanAndValidateEnv();

import IORedis from 'ioredis';

async function startWorker() {
  // Verificar Redis
  if (!process.env.REDIS_URL) {
    console.log('❌ REDIS_URL not set - worker cannot start');
    return;
  }

  let redis;
  try {
    redis = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      retryDelayOnFailover: 100,
    });

    await redis.ping();
    console.log('✅ Redis connected for worker\n');
  } catch (error) {
    console.log('❌ Redis connection failed:', error.message);
    return;
  }

  try {
    // Verificar configuración necesaria
    const requiredVars = ['RPC_URL', 'PRIVATE_KEY', 'PUMPPORTAL_API_KEY'];
    const missingVars = requiredVars.filter((v) => !process.env[v]);

    if (missingVars.length > 0) {
      console.log(`❌ Missing required env vars: ${missingVars.join(', ')}`);
      return;
    }

    // Verificar modo
    const dryRun = process.env.DRY_RUN !== 'false';
    const autoTrading = process.env.ENABLE_AUTO_TRADING === 'true';

    const maxPositions = process.env.MAX_POSITIONS || '2';
    const positionSize = process.env.POSITION_SIZE_SOL || '0.025';
    const priorityFeeSol = process.env.PRIORITY_FEE || '0.0005'; // En SOL, usado por PumpPortalExecutor
    const profitTarget = process.env.COPY_PROFIT_TARGET || '200';
    const trailingStop = process.env.TRAILING_STOP || '15';
    const stopLoss = process.env.COPY_STOP_LOSS || '15';
    const jupiterSlippageBps = process.env.JUPITER_SLIPPAGE_BPS || '500';
    const copySlippage = process.env.COPY_SLIPPAGE || '10';

    console.log('📋 Configuration:');
    console.log(
      `   Mode: ${dryRun ? '📄 DRY RUN (Paper Trading)' : '💰 LIVE TRADING'}`
    );
    console.log(`   Auto Trading: ${autoTrading ? 'Enabled' : 'Disabled'}`);
    console.log(`   Max Positions: ${maxPositions}`);
    console.log(`   Position Size: ${positionSize} SOL`);
    console.log(`   Priority Fee (PumpPortal): ${priorityFeeSol} SOL`);
    console.log(
      `   Profit Target: +${profitTarget}% | Trailing Stop: -${trailingStop}% | Stop Loss: -${stopLoss}%`
    );
    console.log(
      `   Jupiter Slippage: ${jupiterSlippageBps} bps (${(
        Number(jupiterSlippageBps) / 100
      ).toFixed(2)}%)`
    );
    console.log(`   Copy Slippage (PumpPortal): ${copySlippage}%\n`);

    if (!autoTrading) {
      console.log('⚠️ Auto trading is DISABLED');
      console.log('   Set ENABLE_AUTO_TRADING=true to enable\n');
    }

    if (dryRun) {
      console.log('📄 PAPER TRADING MODE - No real trades will be executed');
      console.log('   Set DRY_RUN=false for live trading\n');
    } else if (autoTrading) {
      console.log('⚠️ LIVE TRADING MODE - Real SOL will be used!');
      console.log('   Make sure your wallet has enough balance\n');
    }

    // Iniciar Copy Monitor (procesa señales y ejecuta trades)
    console.log('🔄 Starting Copy Monitor...');
    await import('./copyMonitor.js');
    console.log('✅ Copy Monitor started\n');

    // Stats periódicos
    setInterval(async () => {
      try {
        const openPositions = await redis.scard('open_positions');
        const trackedWallets = await redis.scard('tracked_wallets');
        const pendingSignals = await redis.llen('copy_signals');

        console.log('\n📊 Worker Status:');
        console.log(`   Tracked Wallets: ${trackedWallets}`);
        console.log(`   Open Positions: ${openPositions}`);
        console.log(`   Pending Signals: ${pendingSignals}`);

        // Obtener stats de hoy
        try {
          const { RiskManager } = await import('./riskManager.js');
          const riskManager = new RiskManager({}, redis);
          const stats = await riskManager.getDailyStats();

          if (stats && stats.totalTrades > 0) {
            console.log(`\n💰 Today's Performance:`);
            console.log(`   Total Trades: ${stats.totalTrades}`);
            console.log(`   Win Rate: ${stats.winRate}`);
            console.log(`   Total P&L: ${stats.totalPnL} SOL`);
          }
        } catch (e) {
          // Stats no disponibles aún
        }

        console.log('');
      } catch (error) {
        // Silent
      }
    }, 120000); // Cada 2 min

    console.log('✅ Copy Trading Worker is running');
    console.log('   Waiting for copy signals from tracked wallets...\n');
  } catch (error) {
    console.log('❌ Worker setup failed:', error.message);
    process.exit(1);
  }
}

// Manejo de errores global
process.on('unhandledRejection', (err) => {
  console.log('Unhandled rejection:', err.message);
});

process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down worker...');

  try {
    // Cerrar wallet tracker
    const { getWalletTracker } = await import('./walletTracker.js');
    const tracker = getWalletTracker();
    if (tracker) {
      await tracker.close();
    }
  } catch (e) {}

  console.log('✅ Worker stopped gracefully\n');
  process.exit(0);
});

// Iniciar el worker
startWorker();
