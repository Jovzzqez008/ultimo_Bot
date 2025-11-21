// envCleaner.js - Ultra Clean & Validate Environment Variables (PumpPortal + Jupiter + Helius)

import dotenv from 'dotenv';

/**
 * ULTRA CLEANER – Actualizado para:
 *  - PumpPortal Lightning API
 *  - Jupiter SDK
 *  - Pump.fun bonding curve reader
 *  - Copy trading hybrid strategy
 *  - All worker/server/runtime modules
 */
export class EnvCleaner {
  constructor() {
    this.cleaned = {};
    this.errors = [];
  }

  // -------------------------------
  // BASIC CLEANERS
  // -------------------------------

  cleanString(value) {
    if (!value) return '';
    let cleaned = value.toString().trim();
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
      cleaned = cleaned.slice(1, -1);
    }
    return cleaned.trim();
  }

  cleanPrivateKey(value) {
    if (!value) return '';
    let cleaned = this.cleanString(value);
    cleaned = cleaned.replace(/\s/g, '');
    cleaned = cleaned.replace(/[^123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]/g, '');
    return cleaned;
  }

  cleanURL(value) {
    if (!value) return '';
    return this.cleanString(value).replace(/\s/g, '');
  }

  cleanNumber(value) {
    if (!value) return '';
    return this.cleanString(value).replace(/[^\d.-]/g, '');
  }

  cleanBoolean(value) {
    if (!value) return 'false';
    const v = this.cleanString(value).toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(v) ? 'true' : 'false';
  }

  // -------------------------------
  // VALIDATORS
  // -------------------------------

  validatePrivateKey(key) {
    if (!key) return { valid: false, error: 'Private key is empty' };
    if (key.length !== 88) return { valid: false, error: `Invalid length: ${key.length} (expected 88)` };
    if (!/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(key))
      return { valid: false, error: 'Contains invalid Base58 chars' };
    return { valid: true };
  }

  validateRPCURL(url) {
    if (!url) return { valid: false, error: 'RPC empty' };
    if (!url.startsWith('http')) return { valid: false, error: 'RPC must start with http(s)://' };
    return { valid: true };
  }

  // -------------------------------
  // MAIN CLEANER
  // -------------------------------
  cleanAllEnv() {
    console.log('🧹 Cleaning environment variables...\n');

    // ----------------------------------
    // 🔑 PRIVATE KEY
    // ----------------------------------
    const rawPK = process.env.PRIVATE_KEY;
    this.cleaned.PRIVATE_KEY = this.cleanPrivateKey(rawPK);
    const pkVal = this.validatePrivateKey(this.cleaned.PRIVATE_KEY);
    if (!pkVal.valid) {
      console.error(`❌ PRIVATE_KEY INVALID: ${pkVal.error}`);
      this.errors.push(pkVal.error);
    } else {
      console.log(`✅ PRIVATE_KEY OK (${this.cleaned.PRIVATE_KEY.length} chars)`);
    }

    // ----------------------------------
    // 🌐 RPC / WSS URLs
    // ----------------------------------
    this.cleaned.RPC_URL = this.cleanURL(process.env.RPC_URL);
    this.cleaned.HELIUS_WSS_URL = this.cleanURL(process.env.HELIUS_WSS_URL);

    let rpcVal = this.validateRPCURL(this.cleaned.RPC_URL);
    if (!rpcVal.valid) this.errors.push(`RPC_URL: ${rpcVal.error}`);
    console.log(`✅ RPC_URL: ${this.cleaned.RPC_URL}`);

    // ----------------------------------
    // 🔥 PumpPortal Lightning API
    // ----------------------------------
    this.cleaned.PUMPPORTAL_API_KEY =
      this.cleanString(process.env.PUMPPORTAL_API_KEY || '');

    console.log(`⚡ PUMPPORTAL_API_KEY: ${this.cleaned.PUMPPORTAL_API_KEY ? 'OK' : 'missing'}`);

    // ----------------------------------
    // 🪐 Jupiter Service
    // ----------------------------------
    this.cleaned.JUPITER_SLIPPAGE_BPS = this.cleanNumber(
      process.env.JUPITER_SLIPPAGE_BPS || '50'
    );
    this.cleaned.JUPITER_TIMEOUT = this.cleanNumber(
      process.env.JUPITER_TIMEOUT || '5000'
    );

    console.log(`🪐 Jupiter slippage: ${this.cleaned.JUPITER_SLIPPAGE_BPS} bps`);

    // ----------------------------------
    // 💰 TRADING CONFIG
    // ----------------------------------
    this.cleaned.DRY_RUN = this.cleanBoolean(process.env.DRY_RUN);
    this.cleaned.ENABLE_AUTO_TRADING = this.cleanBoolean(
      process.env.ENABLE_AUTO_TRADING
    );

    this.cleaned.POSITION_SIZE_SOL = this.cleanNumber(
      process.env.POSITION_SIZE_SOL || '0.05'
    );
    this.cleaned.MAX_POSITIONS = this.cleanNumber(
      process.env.MAX_POSITIONS || '2'
    );

    this.cleaned.COPY_PROFIT_TARGET = this.cleanNumber(
      process.env.COPY_PROFIT_TARGET || '200'
    );
    this.cleaned.COPY_STOP_LOSS = this.cleanNumber(
      process.env.COPY_STOP_LOSS || '15'
    );
    this.cleaned.TRAILING_STOP = this.cleanNumber(
      process.env.TRAILING_STOP || '25'
    );

    this.cleaned.MIN_WALLETS_TO_BUY = this.cleanNumber(
      process.env.MIN_WALLETS_TO_BUY || '1'
    );

    this.cleaned.MIN_WALLETS_TO_SELL = this.cleanNumber(
      process.env.MIN_WALLETS_TO_SELL || '1'
    );

    console.log(`📈 POSITION_SIZE_SOL: ${this.cleaned.POSITION_SIZE_SOL}`);
    console.log(`📉 COPY_STOP_LOSS: -${this.cleaned.COPY_STOP_LOSS}%`);
    console.log(`📈 TAKE PROFIT: +${this.cleaned.COPY_PROFIT_TARGET}%`);
    console.log(`📉 TRAILING STOP: -${this.cleaned.TRAILING_STOP}%`);

    // ----------------------------------
    // 📊 TELEGRAM
    // ----------------------------------
    this.cleaned.TELEGRAM_BOT_TOKEN = this.cleanString(
      process.env.TELEGRAM_BOT_TOKEN
    );
    this.cleaned.TELEGRAM_OWNER_CHAT_ID = this.cleanString(
      process.env.TELEGRAM_OWNER_CHAT_ID
    );
    this.cleaned.TELEGRAM_LIVE_UPDATES = this.cleanBoolean(
      process.env.TELEGRAM_LIVE_UPDATES
    );

    // ----------------------------------
    // REDIS
    // ----------------------------------
    this.cleaned.REDIS_URL = this.cleanURL(process.env.REDIS_URL);

    if (!this.cleaned.REDIS_URL)
      this.errors.push('REDIS_URL missing');

    console.log(`🔗 REDIS_URL: ${this.cleaned.REDIS_URL}`);

    // ----------------------------------
    // Programa Pump.fun
    // ----------------------------------
    this.cleaned.PUMP_PROGRAM_ID = this.cleanString(
      process.env.PUMP_PROGRAM_ID ||
      '6EF8rrecthR5Dkp1KPcLW7jkZo4U9AWhjbnESmtDDMTP'
    );

    console.log(`🎵 Pump.fun ProgramID: ${this.cleaned.PUMP_PROGRAM_ID}`);

    // FINAL
    if (this.errors.length > 0) {
      console.error('\n❌ ENV ERRORS FOUND:');
      this.errors.forEach(e => console.error('  -', e));
      return false;
    }

    console.log('\n✅ Environment clean & validated');
    return true;
  }

  applyCleanedEnv() {
    Object.entries(this.cleaned).forEach(([k, v]) => {
      process.env[k] = v;
    });
    console.log('🌱 Cleaned env applied\n');
  }
}

/**
 * MAIN ENTRY
 */
export function cleanAndValidateEnv() {
  const cleaner = new EnvCleaner();
  const ok = cleaner.cleanAllEnv();

  if (!ok) {
    console.error('\n❌ Fix environment errors before starting.\n');
    process.exit(1);
  }

  cleaner.applyCleanedEnv();
  return cleaner;
}

export function getCleanEnv(key, defaultValue = '') {
  const cleaner = new EnvCleaner();
  const val = process.env[key] || defaultValue;

  if (key === 'PRIVATE_KEY') return cleaner.cleanPrivateKey(val);
  if (key.includes('URL')) return cleaner.cleanURL(val);
  if (['true', 'false'].includes(val)) return cleaner.cleanBoolean(val);
  if (!isNaN(val)) return cleaner.cleanNumber(val);

  return cleaner.cleanString(val);
}
