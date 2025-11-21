// priceService.js - Servicio de precios unificado Pump.fun + Jupiter
import { Connection, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';
import { JupiterPriceService } from './jupiterPriceService.js';

// ✅ Program ID CORRECTO de Pump.fun
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkp1KPcLW7jkZo4U9AWhjbnESmtDDMTP');
const PUMP_CURVE_SEED = Buffer.from('bonding-curve');
const PUMP_TOKEN_DECIMALS = 6;
const LAMPORTS_PER_SOL = 1e9;

// Opcional: DexScreener como fallback remoto
const DEXSCREENER_URL = 'https://api.dexscreener.com/latest/dex/tokens';

class PriceService {
  constructor(config) {
    this.rpcUrl = config.RPC_URL;
    this.connection = new Connection(this.rpcUrl, { commitment: 'confirmed' });

    // Jupiter para graduados / fallback
    this.jupiter = new JupiterPriceService({
      RPC_URL: config.RPC_URL,
      PRIVATE_KEY: config.PRIVATE_KEY,
    });

    // Caches simples
    this.priceCache = new Map(); // mint -> { price, source, ts }
    this.cacheMs = 5000; // 5 seg

    console.log('💵 PriceService initialized');
    console.log(` RPC: ${this.rpcUrl}`);
    console.log(` Pump.fun Program ID: ${PUMP_PROGRAM_ID.toBase58()}`);
  }

  // ------------------------------------------------------------------
  // 🌐 API principal
  // ------------------------------------------------------------------

  /**
   * Obtener precio de un token:
   * - Primero intenta Pump.fun bonding curve (si sigue en Pump.fun)
   * - Si no existe curva o está graduado → usa Jupiter
   */
  async getPrice(mintStr, { forceFresh = false } = {}) {
    const mint = new PublicKey(mintStr);
    const now = Date.now();
    const cacheKey = mint.toBase58();

    // Cache
    if (!forceFresh && this.priceCache.has(cacheKey)) {
      const cached = this.priceCache.get(cacheKey);
      if (now - cached.ts < this.cacheMs) {
        return cached;
      }
    }

    // 1) Intentar Pump.fun bonding curve
    try {
      const pump = await this.getPumpFunPrice(mint);
      if (pump && pump.price && !pump.graduated) {
        const result = {
          mint: cacheKey,
          price: pump.price,
          source: 'pump.fun',
          bondingProgress: pump.bondingProgress,
          graduated: false,
          ts: now,
        };
        this.priceCache.set(cacheKey, result);
        return result;
      }

      // Si la curva marca "complete" o no existe → considerar graduado
      if (pump && pump.graduated) {
        console.log(`🎓 ${cacheKey.slice(0, 8)}... marcado como graduado por bonding curve`);
      }
    } catch (err) {
      console.warn(`⚠️ Pump.fun price failed for ${cacheKey}: ${err.message}`);
    }

    // 2) Intentar Jupiter (graduado o no se pudo leer la curva)
    const jup = await this.getPriceForGraduated(cacheKey);
    if (jup && jup.price) {
      const result = {
        mint: cacheKey,
        price: jup.price,
        source: jup.source || 'jupiter',
        bondingProgress: null,
        graduated: true,
        ts: now,
      };
      this.priceCache.set(cacheKey, result);
      return result;
    }

    // 3) Último fallback: DexScreener
    const dex = await this.getPriceFromDexScreener(cacheKey);
    if (dex && dex.price) {
      const result = {
        mint: cacheKey,
        price: dex.price,
        source: 'dexscreener',
        bondingProgress: null,
        graduated: true,
        ts: now,
      };
      this.priceCache.set(cacheKey, result);
      return result;
    }

    return {
      mint: cacheKey,
      price: null,
      source: 'none',
      bondingProgress: null,
      graduated: false,
      ts: now,
      error: 'No price source available',
    };
  }

  /**
   * Forzar uso de Jupiter para tokens graduados
   */
  async getPriceForGraduated(mintStr) {
    try {
      const jup = await this.jupiter.getPrice(mintStr, true);
      if (jup && jup.price) {
        return {
          price: jup.price,
          source: jup.source || 'jupiter',
        };
      }
      return { price: null, source: 'jupiter', error: jup?.error };
    } catch (err) {
      console.error(`❌ Jupiter getPriceForGraduated error: ${err.message}`);
      return { price: null, source: 'jupiter', error: err.message };
    }
  }

  // ------------------------------------------------------------------
  // 🧮 Pump.fun bonding curve
  // ------------------------------------------------------------------

  /**
   * Derivar PDA de la bonding curve
   */
  findBondingCurveAddress(tokenMint) {
    const [curveAddress] = PublicKey.findProgramAddressSync(
      [PUMP_CURVE_SEED, tokenMint.toBuffer()],
      PUMP_PROGRAM_ID
    );
    return curveAddress;
  }

  /**
   * Leer el estado de la bonding curve + calcular precio + progreso
   */
  async getPumpFunPrice(tokenMint) {
    const curveAddress = this.findBondingCurveAddress(tokenMint);

    const accountInfo = await this.connection.getAccountInfo(curveAddress);
    if (!accountInfo || !accountInfo.data) {
      // No hay curva: probablemente graduado o token inválido
      throw new Error('No bonding curve account found');
    }

    const data = accountInfo.data;

    // Opcional: verificar signature (primeros 8 bytes)
    const expectedSig = Buffer.from([0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60]);
    const actualSig = data.subarray(0, 8);
    if (!actualSig.equals(expectedSig)) {
      console.warn('⚠️ Bonding curve account signature mismatch (IDL discriminator)');
    }

    // Layout según el IDL
    const virtualTokenReserves = data.readBigUInt64LE(0x08);
    const virtualSolReserves = data.readBigUInt64LE(0x10);
    const realTokenReserves = data.readBigUInt64LE(0x18);
    const realSolReserves = data.readBigUInt64LE(0x20);
    const tokenTotalSupply = data.readBigUInt64LE(0x28);
    const complete = data.readUInt8(0x30) !== 0;

    if (virtualTokenReserves <= 0n || virtualSolReserves <= 0n) {
      throw new Error('Invalid bonding curve state (zero reserves)');
    }

    const virtualSol = Number(virtualSolReserves) / LAMPORTS_PER_SOL;
    const virtualTokens = Number(virtualTokenReserves) / 10 ** PUMP_TOKEN_DECIMALS;

    const price = virtualSol / virtualTokens;

    // Progreso de bonding
    const INITIAL_REAL_TOKEN_RESERVES = 793100000000000n;
    let bondingProgress = 0;
    if (realTokenReserves < INITIAL_REAL_TOKEN_RESERVES) {
      bondingProgress =
        1 -
        Number((realTokenReserves * 10000n) / INITIAL_REAL_TOKEN_RESERVES) /
          10000;
    }

    console.log(`🎵 Pump.fun price for ${tokenMint.toBase58().slice(0, 8)}...: ${price.toFixed(10)} SOL`);
    console.log(`  complete: ${complete}, bondingProgress: ${(bondingProgress * 100).toFixed(2)}%`);

    return {
      price,
      curveState: {
        virtualTokenReserves: virtualTokenReserves.toString(),
        virtualSolReserves: virtualSolReserves.toString(),
        realTokenReserves: realTokenReserves.toString(),
        realSolReserves: realSolReserves.toString(),
        tokenTotalSupply: tokenTotalSupply.toString(),
        complete,
      },
      bondingProgress,
      graduated: complete,
    };
  }

  // ------------------------------------------------------------------
  // 🔄 Fallback: DexScreener (por si Jupiter falla)
  // ------------------------------------------------------------------
  async getPriceFromDexScreener(mintStr) {
    try {
      const url = `${DEXSCREENER_URL}/${mintStr}`;
      const res = await fetch(url, { timeout: 5000 });

      if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
      const data = await res.json();
      if (!data.pairs || !data.pairs.length) {
        throw new Error('No pairs for token');
      }

      // Tomar el par con más liquidez
      const best = data.pairs.sort(
        (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
      )[0];

      const price = Number(best.priceNative || best.priceUsd || 0);
      if (!price || !Number.isFinite(price)) {
        throw new Error('Invalid DexScreener price');
      }

      console.log(
        `📊 DexScreener price for ${mintStr.slice(0, 8)}...: ${price} (source: ${best.dexId})`
      );

      return { price, source: 'dexscreener' };
    } catch (err) {
      console.warn(`⚠️ DexScreener failed for ${mintStr}: ${err.message}`);
      return { price: null, error: err.message };
    }
  }

  // ------------------------------------------------------------------
  // Utilidades
  // ------------------------------------------------------------------

  /**
   * Calcular valor actual (en SOL) dada una posición y el precio
   */
  calculateCurrentValue(tokensAmount, price) {
    const amount = typeof tokensAmount === 'number'
      ? tokensAmount
      : Number(tokensAmount);
    return amount * price;
  }
}

// Singleton para mantener compatibilidad con tu bot actual
let _singleton = null;

export function getPriceService() {
  if (!_singleton) {
    const config = {
      RPC_URL: process.env.RPC_URL,
      PRIVATE_KEY: process.env.PRIVATE_KEY,
    };
    _singleton = new PriceService(config);
  }
  return _singleton;
}
