// jupiterPriceService.js - CORREGIDO: URLs correctas + Price API v3 + decimales auto-detectados
import fetch from "node-fetch";
import {
  Connection,
  VersionedTransaction,
  Keypair,
  SendTransactionError,
  PublicKey
} from "@solana/web3.js";
import bs58 from "bs58";

// Helper para reintentos automáticos
async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return await res.json();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export class JupiterPriceService {
  constructor(config) {
    this.rpcUrl = config.RPC_URL;
    this.connection = new Connection(this.rpcUrl, {
      commitment: "confirmed"
    });

    // Private key (para firmar swaps)
    try {
      const decoded = Array.isArray(config.PRIVATE_KEY)
        ? Uint8Array.from(config.PRIVATE_KEY)
        : bs58.decode(config.PRIVATE_KEY);

      this.wallet = Keypair.fromSecretKey(decoded);
    } catch (err) {
      console.error("❌ JupiterPriceService INVALID PRIVATE KEY:", err.message);
      throw err;
    }

    // Cache
    this.priceCache = new Map();
    this.cacheMaxAge = 5000; // 5s

    // Cache de decimales por mint
    this.decimalsCache = new Map();

    // ✅ FIXED: URLs correctas con /swap/v1/
    this.jupiterQuoteURL = "https://lite-api.jup.ag/swap/v1/quote";
    this.jupiterSwapURL = "https://lite-api.jup.ag/swap/v1/swap";
    this.jupiterPriceURL = "https://lite-api.jup.ag/price/v3"; // API simplificada

    console.log("🪐 JupiterPriceService READY (lite-api - FREE)");
    console.log("   Quote API: https://lite-api.jup.ag/swap/v1/quote");
    console.log("   Swap API: https://lite-api.jup.ag/swap/v1/swap");
    console.log("   Price API: https://lite-api.jup.ag/price/v3");
  }

  // ------------------------------------------------------------------------
  // Helper: obtener decimales reales de la mint (auto, sin env)
  // ------------------------------------------------------------------------
  async getTokenDecimals(mintStr) {
    if (this.decimalsCache.has(mintStr)) {
      return this.decimalsCache.get(mintStr);
    }

    try {
      const mintPubkey = new PublicKey(mintStr);
      const info = await this.connection.getParsedAccountInfo(mintPubkey);

      const decimals =
        info?.value?.data?.parsed?.info?.decimals ?? 6; // fallback 6

      this.decimalsCache.set(mintStr, decimals);
      console.log(
        `   🔍 Decimals for ${mintStr.slice(0, 8)}...: ${decimals}`
      );
      return decimals;
    } catch (err) {
      console.warn(
        `   ⚠️ Could not fetch decimals for ${mintStr.slice(
          0,
          8
        )}... using 6 as fallback: ${err.message}`
      );
      this.decimalsCache.set(mintStr, 6);
      return 6;
    }
  }

  // ------------------------------------------------------------------------
  // 🎓 1. Detectar si un token está graduado
  // ------------------------------------------------------------------------
  async isGraduated(mint) {
    try {
      const pumpProgramId = new PublicKey(
        process.env.PUMP_PROGRAM_ID ||
          "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
      );

      const accounts = await this.connection.getProgramAccounts(pumpProgramId, {
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: mint
            }
          }
        ]
      });

      if (accounts.length === 0) {
        console.log(`🎓 Token ${mint.slice(0, 8)}... GRADUADO`);
        return true;
      }
      return false;
    } catch (err) {
      console.warn("⚠️ Graduation check failed:", err.message);
      return false;
    }
  }

  // ------------------------------------------------------------------------
  // 💰 2. Obtener precio usando Price API v3 (más simple y rápido)
  // ------------------------------------------------------------------------
  async getPriceSimple(mint) {
    try {
      const url = `${this.jupiterPriceURL}?ids=${mint}&vsCurrency=USDC`;
      const data = await fetchWithRetry(url, {}, 2, 500);

      if (data && data[mint] && data[mint].price) {
        const priceUSDC = data[mint].price;

        // Convertir USDC a SOL (aproximado, asume 1 SOL ≈ precio de mercado)
        // Para más precisión, podrías obtener el precio SOL/USDC también
        const SOL_USDC_PRICE = 100; // Ajustar según mercado real
        const priceSOL = priceUSDC / SOL_USDC_PRICE;

        return {
          price: priceSOL,
          priceUSD: priceUSDC,
          source: "jupiter_price_v3"
        };
      }

      return null;
    } catch (err) {
      // Silent fail, intentar con método de quote
      return null;
    }
  }

  // ------------------------------------------------------------------------
  // 💰 3. Obtener precio usando Quote API (método original, más preciso)
  // ------------------------------------------------------------------------
  async getPrice(mint, forceFresh = false) {
    try {
      const now = Date.now();

      // Cache
      if (!forceFresh && this.priceCache.has(mint)) {
        const old = this.priceCache.get(mint);
        if (now - old.timestamp < this.cacheMaxAge) {
          return { price: old.price, source: "cache" };
        }
      }

      // ✅ Intentar primero con Price API v3 (más rápido)
      const simplePrice = await this.getPriceSimple(mint);
      if (simplePrice && simplePrice.price) {
        this.priceCache.set(mint, {
          price: simplePrice.price,
          timestamp: now
        });
        return simplePrice;
      }

      // ✅ Fallback: Quote API (más completo pero puede fallar en tokens nuevos)
      const SOL = "So11111111111111111111111111111111111111112";

      // ✅ FIXED: URL correcta con /swap/v1/
      const url = `${this.jupiterQuoteURL}?inputMint=${mint}&outputMint=${SOL}&amount=1000000&swapMode=ExactIn&slippageBps=50`;

      const data = await fetchWithRetry(url, {}, 2, 500);

      if (!data.outAmount) {
        throw new Error("Quote has no outAmount");
      }

      const price = Number(data.outAmount) / 1_000_000;

      this.priceCache.set(mint, {
        price,
        timestamp: now,
        outAmount: data.outAmount
      });

      return { price, source: "jupiter_quote" };
    } catch (err) {
      // Manejo mejorado de errores comunes
      if (err.message.includes("ENOTFOUND") || err.message.includes("fetch failed")) {
        console.warn(`⚠️ Jupiter Connection Issue: ${err.message.split("\n")[0]}`);
      } else if (err.message.includes("404") || err.message.includes("Route not found")) {
        console.warn(
          `⚠️ Jupiter Route Not Found: Token may be too new or illiquid`
        );
        console.warn(`   Mint: ${mint.slice(0, 8)}...`);
        console.warn(
          `   Tip: Token needs ~$500 liquidity and 1-2 hours to be indexed`
        );
      } else if (err.message.includes("401")) {
        console.error(`❌ Jupiter API Error: ${err.message}`);
        console.error(`   Note: Using lite-api.jup.ag (free tier)`);
      } else {
        console.warn("⚠️ Jupiter getPrice failed:", err.message.split("\n")[0]);
      }

      // Usar cache como último recurso
      if (this.priceCache.has(mint)) {
        const cached = this.priceCache.get(mint);
        console.log(
          `   ℹ️ Using cached price (${Math.floor(
            (now - cached.timestamp) / 1000
          )}s old)`
        );
        return {
          price: cached.price,
          source: "cache-fallback"
        };
      }

      return { price: null, error: err.message };
    }
  }

  // ------------------------------------------------------------------------
  // 🔄 4. Ejecutar Swap Ultra para vender tokens graduados
  // ------------------------------------------------------------------------
  async swapToken(mint, tokenAmount, slippageBps = 500) {
    try {
      console.log("\n🪐 JUPITER ULTRA SWAP (lite-api)");
      console.log("   Mint:", mint);
      console.log("   Tokens (UI):", tokenAmount);
      console.log(`   Slippage: ${slippageBps / 100}%`);

      const inputMint = mint;
      const outputMint =
        "So11111111111111111111111111111111111111112"; // SOL

      // ✅ FIX: obtener decimales reales desde la mint (auto)
      const decimals = await this.getTokenDecimals(inputMint);
      const rawAmount = Number(tokenAmount) * 10 ** decimals;
      const amount = Math.floor(rawAmount);

      console.log(`   Decimals detectados: ${decimals}`);
      console.log(`   Amount (base units): ${amount}`);

      // Paso 1: obtener quote (Retry incluido, URL corregida)
      const quoteURL = `${this.jupiterQuoteURL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;

      const quoteResponse = await fetchWithRetry(quoteURL, {}, 3, 1000);

      if (!quoteResponse.outAmount) {
        throw new Error("Jupiter quote failed - no outAmount");
      }

      console.log(
        `   Expected SOL: ${(Number(quoteResponse.outAmount) / 1e9).toFixed(
          4
        )} SOL`
      );

      // Paso 2: Swap instructions (Retry incluido, URL corregida)
      const swapData = await fetchWithRetry(
        this.jupiterSwapURL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quoteResponse: quoteResponse,
            userPublicKey: this.wallet.publicKey.toString(),
            wrapAndUnwrapSol: true
          })
        },
        3,
        1000
      );

      if (!swapData.swapTransaction) {
        throw new Error("Jupiter swap API returned no transaction");
      }

      // Paso 3: Construir transacción
      const swapTxBuf = Buffer.from(swapData.swapTransaction, "base64");
      const swapTx = VersionedTransaction.deserialize(swapTxBuf);

      swapTx.sign([this.wallet]);

      // Paso 4: Enviar transacción
      let signature;
      try {
        signature = await this.connection.sendTransaction(swapTx, {
          skipPreflight: false,
          maxRetries: 3
        });
      } catch (err) {
        if (err instanceof SendTransactionError) {
          console.error("   Jupiter transaction error logs:", err.logs);
        }
        throw err;
      }

      console.log("   ✅ Swap signature:", signature);

      return {
        success: true,
        action: "sell",
        signature,
        solReceived: Number(quoteResponse.outAmount) / 1e9,
        expectedSOL: Number(quoteResponse.outAmount) / 1e9,
        priceImpact: quoteResponse.priceImpact,
        tokenAmount
      };
    } catch (err) {
      console.error("❌ Jupiter swapToken error:", err.message);

      // Mensajes de ayuda según el error
      if (err.message.includes("Route not found")) {
        console.error(
          "   💡 Tip: Token may need more liquidity or time to be indexed"
        );
      } else if (err.message.includes("Slippage tolerance exceeded")) {
        console.error(
          "   💡 Tip: Try increasing slippage (current: " +
            slippageBps +
            " bps)"
        );
      }

      return {
        success: false,
        error: err.message
      };
    }
  }
}
