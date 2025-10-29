/**
 * open-nof1.ai - AI 加密货币自动交易系统
 * Copyright (C) 2025 195440
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 * 
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * 交易循环 - 定时执行交易决策
 */
import cron from "node-cron";
import { createPinoLogger } from "@voltagent/logger";
import { createClient } from "@libsql/client";
import { createTradingAgent, generateTradingPrompt, getAccountRiskConfig } from "../agents/tradingAgent";
import { createGateClient } from "../services/gateClient";
import { getChinaTimeISO } from "../utils/timeUtils";
import { RISK_PARAMS } from "../config/riskParams";

const logger = createPinoLogger({
  name: "trading-loop",
  level: "info",
});

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

// 支持的币种 - 从配置中读取
const SYMBOLS = [...RISK_PARAMS.TRADING_SYMBOLS] as string[];

// 交易开始时间
let tradingStartTime = new Date();
let iterationCount = 0;

// 账户风险配置
let accountRiskConfig = getAccountRiskConfig();

/**
 * 确保数值是有效的有限数字，否则返回默认值
 */
function ensureFinite(value: number, defaultValue: number = 0): number {
  if (!Number.isFinite(value)) {
    return defaultValue;
  }
  return value;
}

/**
 * 确保数值在指定范围内
 */
function ensureRange(value: number, min: number, max: number, defaultValue?: number): number {
  if (!Number.isFinite(value)) {
    return defaultValue !== undefined ? defaultValue : (min + max) / 2;
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * 收集所有市场数据（包含多时间框架分析和时序数据）
 * 🔥 优化：增加数据验证和错误处理，返回时序数据用于提示词
 */
async function collectMarketData() {
  const gateClient = createGateClient();
  const marketData: Record<string, any> = {};

  for (const symbol of SYMBOLS) {
    try {
      const contract = `${symbol}_USDT`;
      
      // 🔥 获取价格（带重试）
      let ticker: any = null;
      let retryCount = 0;
      const maxRetries = 2;
      
      while (retryCount <= maxRetries) {
        try {
          ticker = await gateClient.getFuturesTicker(contract);
          
          // 🔥 验证价格数据有效性
          const price = Number.parseFloat(ticker.last || "0");
          if (price === 0 || !Number.isFinite(price)) {
            throw new Error(`价格无效: ${ticker.last}`);
          }
          
          break; // 成功，跳出重试循环
        } catch (error) {
          retryCount++;
          if (retryCount > maxRetries) {
            logger.error(`${symbol} 价格获取失败（${maxRetries}次重试）:`, error as any);
            throw error;
          }
          logger.warn(`${symbol} 价格获取失败，重试 ${retryCount}/${maxRetries}...`);
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      
      // 获取所有时间框架的K线数据
      const candles1m = await gateClient.getFuturesCandles(contract, "1m", 60);
      const candles3m = await gateClient.getFuturesCandles(contract, "3m", 60);
      const candles5m = await gateClient.getFuturesCandles(contract, "5m", 100);
      const candles15m = await gateClient.getFuturesCandles(contract, "15m", 96);
      const candles30m = await gateClient.getFuturesCandles(contract, "30m", 90);
      const candles1h = await gateClient.getFuturesCandles(contract, "1h", 120);
      
      // 计算每个时间框架的指标
      const indicators1m = calculateIndicators(candles1m);
      const indicators3m = calculateIndicators(candles3m);
      const indicators5m = calculateIndicators(candles5m);
      const indicators15m = calculateIndicators(candles15m);
      const indicators30m = calculateIndicators(candles30m);
      const indicators1h = calculateIndicators(candles1h);
      
      // 计算3分钟时序指标（使用全部60个数据计算，但只显示最近10个数据点）
      const intradaySeries = calculateIntradaySeries(candles3m);
      
      // 计算1小时指标作为更长期上下文
      const longerTermContext = calculateLongerTermContext(candles1h);
      
      // 使用5分钟K线数据作为主要指标（兼容性）
      const indicators = indicators5m;
      
      // 🔥 验证技术指标有效性和数据完整性
      const dataTimestamp = new Date().toISOString();
      const dataQuality = {
        price: Number.isFinite(Number.parseFloat(ticker.last || "0")),
        ema20: Number.isFinite(indicators.ema20),
        macd: Number.isFinite(indicators.macd),
        rsi14: Number.isFinite(indicators.rsi14) && indicators.rsi14 >= 0 && indicators.rsi14 <= 100,
        volume: Number.isFinite(indicators.volume) && indicators.volume >= 0,
        candleCount: {
          "1m": candles1m.length,
          "3m": candles3m.length,
          "5m": candles5m.length,
          "15m": candles15m.length,
          "30m": candles30m.length,
          "1h": candles1h.length,
        }
      };
      
      // 记录数据质量问题
      const issues: string[] = [];
      if (!dataQuality.price) issues.push("价格无效");
      if (!dataQuality.ema20) issues.push("EMA20无效");
      if (!dataQuality.macd) issues.push("MACD无效");
      if (!dataQuality.rsi14) issues.push("RSI14无效或超出范围");
      if (!dataQuality.volume) issues.push("成交量无效");
      if (indicators.volume === 0) issues.push("当前成交量为0");
      
      if (issues.length > 0) {
        logger.warn(`${symbol} 数据质量问题 [${dataTimestamp}]: ${issues.join(", ")}`);
        logger.debug(`${symbol} K线数量:`, dataQuality.candleCount);
      } else {
        logger.debug(`${symbol} 数据质量检查通过 [${dataTimestamp}]`);
      }
      
      // 获取资金费率
      let fundingRate = 0;
      try {
        const fr = await gateClient.getFundingRate(contract);
        fundingRate = Number.parseFloat(fr.r || "0");
        if (!Number.isFinite(fundingRate)) {
          fundingRate = 0;
        }
      } catch (error) {
        logger.warn(`获取 ${symbol} 资金费率失败:`, error as any);
      }
      
      // 获取未平仓合约（Open Interest）- Gate.io ticker中没有openInterest字段，暂时跳过
      let openInterest = { latest: 0, average: 0 };
      // Note: Gate.io ticker 数据中没有开放持仓量字段，如需可以使用其他API或外部数据源
      
      // 将各时间框架指标添加到市场数据
      marketData[symbol] = {
        price: Number.parseFloat(ticker.last || "0"),
        change24h: Number.parseFloat(ticker.change_percentage || "0"),
        volume24h: Number.parseFloat(ticker.volume_24h || "0"),
        fundingRate,
        openInterest,
        ...indicators,
        // 添加时序数据（参照 1.md 格式）
        intradaySeries,
        longerTermContext,
        // 直接添加各时间框架指标
        timeframes: {
          "1m": indicators1m,
          "3m": indicators3m,
          "5m": indicators5m,
          "15m": indicators15m,
          "30m": indicators30m,
          "1h": indicators1h,
        },
      };
      
      // 保存技术指标到数据库（确保所有数值都是有效的）
      await dbClient.execute({
        sql: `INSERT INTO trading_signals 
              (symbol, timestamp, price, ema_20, ema_50, macd, rsi_7, rsi_14, volume, funding_rate)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          symbol,
          getChinaTimeISO(),
          ensureFinite(marketData[symbol].price),
          ensureFinite(indicators.ema20),
          ensureFinite(indicators.ema50),
          ensureFinite(indicators.macd),
          ensureFinite(indicators.rsi7, 50), // RSI 默认 50
          ensureFinite(indicators.rsi14, 50),
          ensureFinite(indicators.volume),
          ensureFinite(fundingRate),
        ],
      });
    } catch (error) {
      logger.error(`收集 ${symbol} 市场数据失败:`, error as any);
    }
  }

  return marketData;
}

/**
 * 计算日内时序数据（3分钟级别）
 * 参照 1.md 格式
 * @param candles 全部历史数据（至少60个数据点）
 */
function calculateIntradaySeries(candles: any[]) {
  if (!candles || candles.length === 0) {
    return {
      midPrices: [],
      ema20Series: [],
      macdSeries: [],
      rsi7Series: [],
      rsi14Series: [],
    };
  }

  // 提取收盘价
  const closes = candles.map((c) => Number.parseFloat(c.c || "0")).filter(n => Number.isFinite(n));
  
  if (closes.length === 0) {
    return {
      midPrices: [],
      ema20Series: [],
      macdSeries: [],
      rsi7Series: [],
      rsi14Series: [],
    };
  }

  // 计算每个时间点的指标
  const midPrices = closes;
  const ema20Series: number[] = [];
  const macdSeries: number[] = [];
  const rsi7Series: number[] = [];
  const rsi14Series: number[] = [];

  // 为每个数据点计算指标（使用截至该点的所有历史数据）
  for (let i = 0; i < closes.length; i++) {
    const historicalPrices = closes.slice(0, i + 1);
    
    // EMA20 - 需要至少20个数据点
    ema20Series.push(historicalPrices.length >= 20 ? calcEMA(historicalPrices, 20) : historicalPrices[historicalPrices.length - 1]);
    
    // MACD - 需要至少26个数据点
    macdSeries.push(historicalPrices.length >= 26 ? calcMACD(historicalPrices) : 0);
    
    // RSI7 - 需要至少8个数据点
    rsi7Series.push(historicalPrices.length >= 8 ? calcRSI(historicalPrices, 7) : 50);
    
    // RSI14 - 需要至少15个数据点
    rsi14Series.push(historicalPrices.length >= 15 ? calcRSI(historicalPrices, 14) : 50);
  }

  // 只返回最近10个数据点
  const sliceIndex = Math.max(0, midPrices.length - 10);
  return {
    midPrices: midPrices.slice(sliceIndex),
    ema20Series: ema20Series.slice(sliceIndex),
    macdSeries: macdSeries.slice(sliceIndex),
    rsi7Series: rsi7Series.slice(sliceIndex),
    rsi14Series: rsi14Series.slice(sliceIndex),
  };
}

/**
 * 计算更长期的上下文数据（1小时级别 - 用于短线交易）
 * 参照 1.md 格式
 */
function calculateLongerTermContext(candles: any[]) {
  if (!candles || candles.length < 26) {
    return {
      ema20: 0,
      ema50: 0,
      atr3: 0,
      atr14: 0,
      currentVolume: 0,
      avgVolume: 0,
      macdSeries: [],
      rsi14Series: [],
    };
  }

  const closes = candles.map((c) => Number.parseFloat(c.c || "0")).filter(n => Number.isFinite(n));
  const highs = candles.map((c) => Number.parseFloat(c.h || "0")).filter(n => Number.isFinite(n));
  const lows = candles.map((c) => Number.parseFloat(c.l || "0")).filter(n => Number.isFinite(n));
  const volumes = candles.map((c) => Number.parseFloat(c.v || "0")).filter(n => Number.isFinite(n));

  // 计算 EMA
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);

  // 计算 ATR
  const atr3 = calcATR(highs, lows, closes, 3);
  const atr14 = calcATR(highs, lows, closes, 14);

  // 计算成交量
  const currentVolume = volumes.length > 0 ? volumes[volumes.length - 1] : 0;
  const avgVolume = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;

  // 计算最近10个数据点的 MACD 和 RSI14
  const macdSeries: number[] = [];
  const rsi14Series: number[] = [];
  
  const recentPoints = Math.min(10, closes.length);
  for (let i = closes.length - recentPoints; i < closes.length; i++) {
    const historicalPrices = closes.slice(0, i + 1);
    macdSeries.push(calcMACD(historicalPrices));
    rsi14Series.push(calcRSI(historicalPrices, 14));
  }

  return {
    ema20,
    ema50,
    atr3,
    atr14,
    currentVolume,
    avgVolume,
    macdSeries,
    rsi14Series,
  };
}

/**
 * 计算 ATR (Average True Range)
 */
function calcATR(highs: number[], lows: number[], closes: number[], period: number) {
  if (highs.length < period + 1 || lows.length < period + 1 || closes.length < period + 1) {
    return 0;
  }

  const trueRanges: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const high = highs[i];
    const low = lows[i];
    const prevClose = closes[i - 1];
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  // 计算平均
  const recentTR = trueRanges.slice(-period);
  const atr = recentTR.reduce((sum, tr) => sum + tr, 0) / recentTR.length;
  
  return Number.isFinite(atr) ? atr : 0;
}

// 计算 EMA
function calcEMA(prices: number[], period: number) {
  if (prices.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return Number.isFinite(ema) ? ema : 0;
}

// 计算 RSI
function calcRSI(prices: number[], period: number) {
  if (prices.length < period + 1) return 50; // 数据不足，返回中性值
  
  let gains = 0;
  let losses = 0;

  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  
  // 确保RSI在0-100范围内
  return ensureRange(rsi, 0, 100, 50);
}

// 计算 MACD
function calcMACD(prices: number[]) {
  if (prices.length < 26) return 0; // 数据不足
  const ema12 = calcEMA(prices, 12);
  const ema26 = calcEMA(prices, 26);
  const macd = ema12 - ema26;
  return Number.isFinite(macd) ? macd : 0;
}

/**
 * 计算技术指标
 * 
 * K线数据格式：FuturesCandlestick 对象
 * {
 *   t: number,    // 时间戳
 *   v: number,    // 成交量
 *   c: string,    // 收盘价
 *   h: string,    // 最高价
 *   l: string,    // 最低价
 *   o: string,    // 开盘价
 *   sum: string   // 总成交额
 * }
 */
function calculateIndicators(candles: any[]) {
  if (!candles || candles.length === 0) {
    return {
      currentPrice: 0,
      ema20: 0,
      ema50: 0,
      macd: 0,
      rsi7: 50,
      rsi14: 50,
      volume: 0,
      avgVolume: 0,
    };
  }

  // 处理对象格式的K线数据（Gate.io API返回的是对象，不是数组）
  const closes = candles
    .map((c) => {
      // 如果是对象格式（FuturesCandlestick）
      if (c && typeof c === 'object' && 'c' in c) {
        return Number.parseFloat(c.c);
      }
      // 如果是数组格式（兼容旧代码）
      if (Array.isArray(c)) {
        return Number.parseFloat(c[2]);
      }
      return NaN;
    })
    .filter(n => Number.isFinite(n));

  const volumes = candles
    .map((c) => {
      // 如果是对象格式（FuturesCandlestick）
      if (c && typeof c === 'object' && 'v' in c) {
        const vol = Number.parseFloat(c.v);
        // 验证成交量：必须是有限数字且非负
        return Number.isFinite(vol) && vol >= 0 ? vol : 0;
      }
      // 如果是数组格式（兼容旧代码）
      if (Array.isArray(c)) {
        const vol = Number.parseFloat(c[1]);
        return Number.isFinite(vol) && vol >= 0 ? vol : 0;
      }
      return 0;
    })
    .filter(n => n >= 0); // 过滤掉负数成交量

  if (closes.length === 0 || volumes.length === 0) {
    return {
      currentPrice: 0,
      ema20: 0,
      ema50: 0,
      macd: 0,
      rsi7: 50,
      rsi14: 50,
      volume: 0,
      avgVolume: 0,
    };
  }

  return {
    currentPrice: ensureFinite(closes.at(-1) || 0),
    ema20: ensureFinite(calcEMA(closes, 20)),
    ema50: ensureFinite(calcEMA(closes, 50)),
    macd: ensureFinite(calcMACD(closes)),
    rsi7: ensureRange(calcRSI(closes, 7), 0, 100, 50),
    rsi14: ensureRange(calcRSI(closes, 14), 0, 100, 50),
    volume: ensureFinite(volumes.at(-1) || 0),
    avgVolume: ensureFinite(volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0),
  };
}

/**
 * 计算 Sharpe Ratio
 * 使用最近30天的账户历史数据
 */
async function calculateSharpeRatio(): Promise<number> {
  try {
    // 尝试获取所有账户历史数据（不限制30天）
    const result = await dbClient.execute({
      sql: `SELECT total_value, timestamp FROM account_history 
            ORDER BY timestamp ASC`,
      args: [],
    });
    
    if (!result.rows || result.rows.length < 2) {
      return 0; // 数据不足，返回0
    }
    
    // 计算每次交易的收益率（而不是每日）
    const returns: number[] = [];
    for (let i = 1; i < result.rows.length; i++) {
      const prevValue = Number.parseFloat(result.rows[i - 1].total_value as string);
      const currentValue = Number.parseFloat(result.rows[i].total_value as string);
      
      if (prevValue > 0) {
        const returnRate = (currentValue - prevValue) / prevValue;
        returns.push(returnRate);
      }
    }
    
    if (returns.length < 2) {
      return 0;
    }
    
    // 计算平均收益率
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    
    // 计算收益率的标准差
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    if (stdDev === 0) {
      return avgReturn > 0 ? 10 : 0; // 无波动但有收益，返回高值
    }
    
    // Sharpe Ratio = (平均收益率 - 无风险利率) / 标准差
    // 假设无风险利率为0
    const sharpeRatio = avgReturn / stdDev;
    
    return Number.isFinite(sharpeRatio) ? sharpeRatio : 0;
  } catch (error) {
    logger.error("计算 Sharpe Ratio 失败:", error as any);
    return 0;
  }
}

/**
 * 获取账户信息
 * 
 * Gate.io 的 account.total 包含了未实现盈亏
 * 总资产 = total - unrealisedPnl = available + positionMargin
 * 
 * 因此：
 * - totalBalance 不包含未实现盈亏
 * - returnPercent 反映已实现盈亏
 * - 监控页面的资金曲线实时更新
 */
async function getAccountInfo() {
  const gateClient = createGateClient();
  
  try {
    const account = await gateClient.getFuturesAccount();
    
    // 从数据库获取初始资金
    const initialResult = await dbClient.execute(
      "SELECT total_value FROM account_history ORDER BY timestamp ASC LIMIT 1"
    );
    const initialBalance = initialResult.rows[0]
      ? Number.parseFloat(initialResult.rows[0].total_value as string)
      : 100;
    
    // 从 Gate.io API 返回的数据中提取字段
    const accountTotal = Number.parseFloat(account.total || "0");
    const availableBalance = Number.parseFloat(account.available || "0");
    const unrealisedPnl = Number.parseFloat(account.unrealisedPnl || "0");
    
    // Gate.io 的 account.total 包含了未实现盈亏
    // totalBalance 应该不包含未实现盈亏
    const totalBalance = accountTotal - unrealisedPnl;
    
    // 实时收益率 = (总资产 - 初始资金) / 初始资金 * 100
    // 总资产不包含未实现盈亏，收益率反映已实现盈亏
    const returnPercent = ((totalBalance - initialBalance) / initialBalance) * 100;
    
    // 计算 Sharpe Ratio
    const sharpeRatio = await calculateSharpeRatio();
    
    return {
      totalBalance,      // 总资产（不包含未实现盈亏）
      availableBalance,  // 可用余额
      unrealisedPnl,     // 未实现盈亏
      returnPercent,     // 收益率（不包含未实现盈亏）
      sharpeRatio,       // 夏普比率
    };
  } catch (error) {
    logger.error("获取账户信息失败:", error as any);
    return {
      totalBalance: 0,
      availableBalance: 0,
      unrealisedPnl: 0,
      returnPercent: 0,
      sharpeRatio: 0,
    };
  }
}

/**
 * 从 Gate.io 同步持仓到数据库
 * 🔥 优化：确保持仓数据的准确性和完整性
 * 数据库中的持仓记录主要用于：
 * 1. 保存止损止盈订单ID等元数据
 * 2. 提供历史查询和监控页面展示
 * 实时持仓数据应该直接从 Gate.io 获取
 */
async function syncPositionsFromGate(cachedPositions?: any[]) {
  const gateClient = createGateClient();
  
  try {
    // 如果提供了缓存数据，使用缓存；否则重新获取
    const gatePositions = cachedPositions || await gateClient.getPositions();
    const dbResult = await dbClient.execute("SELECT symbol, sl_order_id, tp_order_id, stop_loss, profit_target, entry_order_id, opened_at FROM positions");
    const dbPositionsMap = new Map(
      dbResult.rows.map((row: any) => [row.symbol, row])
    );
    
    // 检查 Gate.io 是否有持仓（可能 API 有延迟）
    const activeGatePositions = gatePositions.filter((p: any) => Number.parseInt(p.size || "0") !== 0);
    
    // 如果 Gate.io 返回0个持仓但数据库有持仓，可能是 API 延迟，不清空数据库
    if (activeGatePositions.length === 0 && dbResult.rows.length > 0) {
      logger.warn(`⚠️  Gate.io 返回0个持仓，但数据库有 ${dbResult.rows.length} 个持仓，可能是 API 延迟，跳过同步`);
      return;
    }
    
    await dbClient.execute("DELETE FROM positions");
    
    let syncedCount = 0;
    
    for (const pos of gatePositions) {
      const size = Number.parseInt(pos.size || "0");
      if (size === 0) continue;
      
      const symbol = pos.contract.replace("_USDT", "");
      let entryPrice = Number.parseFloat(pos.entryPrice || "0");
      let currentPrice = Number.parseFloat(pos.markPrice || "0");
      const leverage = Number.parseInt(pos.leverage || "1");
      const side = size > 0 ? "long" : "short";
      const quantity = Math.abs(size);
      const unrealizedPnl = Number.parseFloat(pos.unrealisedPnl || "0");
      let liquidationPrice = Number.parseFloat(pos.liqPrice || "0");
      
      if (entryPrice === 0 || currentPrice === 0) {
        try {
          const ticker = await gateClient.getFuturesTicker(pos.contract);
          if (currentPrice === 0) {
            currentPrice = Number.parseFloat(ticker.markPrice || ticker.last || "0");
          }
          if (entryPrice === 0) {
            entryPrice = currentPrice;
          }
        } catch (error) {
          logger.error(`获取 ${symbol} 行情失败:`, error as any);
        }
      }
      
      if (liquidationPrice === 0 && entryPrice > 0) {
        liquidationPrice = side === "long" 
          ? entryPrice * (1 - 0.9 / leverage)
          : entryPrice * (1 + 0.9 / leverage);
      }
      
      const dbPos = dbPositionsMap.get(symbol);
      
      // 保留原有的 entry_order_id，不要覆盖
      const entryOrderId = dbPos?.entry_order_id || `synced-${symbol}-${Date.now()}`;
      
      await dbClient.execute({
        sql: `INSERT INTO positions 
              (symbol, quantity, entry_price, current_price, liquidation_price, unrealized_pnl, 
               leverage, side, stop_loss, profit_target, sl_order_id, tp_order_id, entry_order_id, opened_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          symbol,
          quantity,
          entryPrice,
          currentPrice,
          liquidationPrice,
          unrealizedPnl,
          leverage,
          side,
          dbPos?.stop_loss || null,
          dbPos?.profit_target || null,
          dbPos?.sl_order_id || null,
          dbPos?.tp_order_id || null,
          entryOrderId, // 保留原有的订单ID
          dbPos?.opened_at || new Date().toISOString(), // 保留原有的开仓时间
        ],
      });
      
      syncedCount++;
    }
    
    const activeGatePositionsCount = gatePositions.filter((p: any) => Number.parseInt(p.size || "0") !== 0).length;
    if (activeGatePositionsCount > 0 && syncedCount === 0) {
      logger.error(`Gate.io 有 ${activeGatePositionsCount} 个持仓，但数据库同步失败！`);
    }
    
  } catch (error) {
    logger.error("同步持仓失败:", error as any);
  }
}

/**
 * 获取持仓信息 - 直接从 Gate.io 获取最新数据
 * @param cachedGatePositions 可选，已获取的原始Gate持仓数据，避免重复调用API
 * @returns 格式化后的持仓数据
 */
async function getPositions(cachedGatePositions?: any[]) {
  const gateClient = createGateClient();
  
  try {
    // 如果提供了缓存数据，使用缓存；否则重新获取
    const gatePositions = cachedGatePositions || await gateClient.getPositions();
    
    // 过滤并格式化持仓
    const positions = gatePositions
      .filter((p: any) => Number.parseInt(p.size || "0") !== 0)
      .map((p: any) => {
        const size = Number.parseInt(p.size || "0");
        return {
          symbol: p.contract.replace("_USDT", ""),
          contract: p.contract,
          quantity: Math.abs(size),
          side: size > 0 ? "long" : "short",
          entry_price: Number.parseFloat(p.entryPrice || "0"),
          current_price: Number.parseFloat(p.markPrice || "0"),
          liquidation_price: Number.parseFloat(p.liqPrice || "0"),
          unrealized_pnl: Number.parseFloat(p.unrealisedPnl || "0"),
          leverage: Number.parseInt(p.leverage || "1"),
          margin: Number.parseFloat(p.margin || "0"),
          opened_at: p.create_time || getChinaTimeISO(),
        };
      });
    
    return positions;
  } catch (error) {
    logger.error("获取持仓失败:", error as any);
    return [];
  }
}

/**
 * 获取历史成交记录（最近10条）
 * 从数据库获取历史交易记录（监控页的交易历史）
 */
async function getTradeHistory(limit: number = 10) {
  try {
    // 从数据库获取历史交易记录
    const result = await dbClient.execute({
      sql: `SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?`,
      args: [limit],
    });
    
    if (!result.rows || result.rows.length === 0) {
      return [];
    }
    
    // 转换数据库格式到提示词需要的格式
    const trades = result.rows.map((row: any) => {
      return {
        symbol: row.symbol,
        side: row.side, // long/short
        type: row.type, // open/close
        price: Number.parseFloat(row.price || "0"),
        quantity: Number.parseFloat(row.quantity || "0"),
        leverage: Number.parseInt(row.leverage || "1"),
        pnl: row.pnl ? Number.parseFloat(row.pnl) : null,
        fee: Number.parseFloat(row.fee || "0"),
        timestamp: row.timestamp,
        status: row.status,
      };
    });
    
    // 按时间正序排列（最旧 → 最新）
    trades.sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    
    return trades;
  } catch (error) {
    logger.error("获取历史成交记录失败:", error as any);
    return [];
  }
}

/**
 * 获取最近N次的AI决策记录
 */
async function getRecentDecisions(limit: number = 3) {
  try {
    const result = await dbClient.execute({
      sql: `SELECT timestamp, iteration, decision, account_value, positions_count 
            FROM agent_decisions 
            ORDER BY timestamp DESC 
            LIMIT ?`,
      args: [limit],
    });
    
    if (!result.rows || result.rows.length === 0) {
      return [];
    }
    
    // 返回格式化的决策记录（从旧到新）
    return result.rows.reverse().map((row: any) => ({
      timestamp: row.timestamp,
      iteration: row.iteration,
      decision: row.decision,
      account_value: Number.parseFloat(row.account_value || "0"),
      positions_count: Number.parseInt(row.positions_count || "0"),
    }));
  } catch (error) {
    logger.error("获取最近决策记录失败:", error as any);
    return [];
  }
}

/**
 * 同步风险配置到数据库
 */
async function syncConfigToDatabase() {
  try {
    const config = getAccountRiskConfig();
    const timestamp = getChinaTimeISO();
    
    // 更新或插入配置
    await dbClient.execute({
      sql: `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
      args: ['account_stop_loss_usdt', config.stopLossUsdt.toString(), timestamp],
    });
    
    await dbClient.execute({
      sql: `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
      args: ['account_take_profit_usdt', config.takeProfitUsdt.toString(), timestamp],
    });
    
    logger.info(`配置已同步到数据库: 止损线=${config.stopLossUsdt} USDT, 止盈线=${config.takeProfitUsdt} USDT`);
  } catch (error) {
    logger.error("同步配置到数据库失败:", error as any);
  }
}

/**
 * 从数据库加载风险配置
 */
async function loadConfigFromDatabase() {
  try {
    const stopLossResult = await dbClient.execute({
      sql: `SELECT value FROM system_config WHERE key = ?`,
      args: ['account_stop_loss_usdt'],
    });
    
    const takeProfitResult = await dbClient.execute({
      sql: `SELECT value FROM system_config WHERE key = ?`,
      args: ['account_take_profit_usdt'],
    });
    
    if (stopLossResult.rows.length > 0 && takeProfitResult.rows.length > 0) {
      accountRiskConfig = {
        stopLossUsdt: Number.parseFloat(stopLossResult.rows[0].value as string),
        takeProfitUsdt: Number.parseFloat(takeProfitResult.rows[0].value as string),
        syncOnStartup: accountRiskConfig.syncOnStartup,
      };
      
      logger.info(`从数据库加载配置: 止损线=${accountRiskConfig.stopLossUsdt} USDT, 止盈线=${accountRiskConfig.takeProfitUsdt} USDT`);
    }
  } catch (error) {
    logger.warn("从数据库加载配置失败，使用环境变量配置:", error as any);
  }
}

/**
 * 清仓所有持仓
 */
async function closeAllPositions(reason: string): Promise<void> {
  const gateClient = createGateClient();
  
  try {
    logger.warn(`清仓所有持仓，原因: ${reason}`);
    
    const positions = await gateClient.getPositions();
    const activePositions = positions.filter((p: any) => Number.parseInt(p.size || "0") !== 0);
    
    if (activePositions.length === 0) {
      return;
    }
    
    for (const pos of activePositions) {
      const size = Number.parseInt(pos.size || "0");
      const contract = pos.contract;
      const symbol = contract.replace("_USDT", "");
      
      try {
        await gateClient.placeOrder({
          contract,
          size: -size,
          price: 0, // 市价单必须传 price: 0
        });
        
        logger.info(`已平仓: ${symbol} ${Math.abs(size)}张`);
      } catch (error) {
        logger.error(`平仓失败: ${symbol}`, error as any);
      }
    }
    
    logger.warn(`清仓完成`);
  } catch (error) {
    logger.error("清仓失败:", error as any);
    throw error;
  }
}

/**
 * 检查账户余额是否触发止损或止盈
 * @returns true: 触发退出条件, false: 继续运行
 */
async function checkAccountThresholds(accountInfo: any): Promise<boolean> {
  const totalBalance = accountInfo.totalBalance;
  
  // 检查止损线
  if (totalBalance <= accountRiskConfig.stopLossUsdt) {
    logger.error(`触发止损线！余额: ${totalBalance.toFixed(2)} USDT <= ${accountRiskConfig.stopLossUsdt} USDT`);
    await closeAllPositions(`账户余额触发止损线 (${totalBalance.toFixed(2)} USDT)`);
    return true;
  }
  
  // 检查止盈线
  if (totalBalance >= accountRiskConfig.takeProfitUsdt) {
    logger.warn(`触发止盈线！余额: ${totalBalance.toFixed(2)} USDT >= ${accountRiskConfig.takeProfitUsdt} USDT`);
    await closeAllPositions(`账户余额触发止盈线 (${totalBalance.toFixed(2)} USDT)`);
    return true;
  }
  
  return false;
}

/**
 * 执行交易决策
 * 🔥 优化：增强错误处理和数据验证，确保数据实时准确
 */
async function executeTradingDecision() {
  iterationCount++;
  const minutesElapsed = Math.floor((Date.now() - tradingStartTime.getTime()) / 60000);
  const intervalMinutes = Number.parseInt(process.env.TRADING_INTERVAL_MINUTES || "5");
  
  logger.info(`\n${"=".repeat(80)}`);
  logger.info(`交易周期 #${iterationCount} (运行${minutesElapsed}分钟)`);
  logger.info(`${"=".repeat(80)}\n`);

  let marketData: any = {};
  let accountInfo: any = null;
  let positions: any[] = [];

  try {
    // 1. 收集市场数据
    try {
      marketData = await collectMarketData();
      const validSymbols = SYMBOLS.filter(symbol => {
        const data = marketData[symbol];
        if (!data || data.price === 0) {
          return false;
        }
        return true;
      });
      
      if (validSymbols.length === 0) {
        logger.error("市场数据获取失败，跳过本次循环");
        return;
      }
    } catch (error) {
      logger.error("收集市场数据失败:", error as any);
      return;
    }
    
    // 2. 获取账户信息
    try {
      accountInfo = await getAccountInfo();
      
      if (!accountInfo || accountInfo.totalBalance === 0) {
        logger.error("账户数据异常，跳过本次循环");
        return;
      }
      
      // 检查账户余额是否触发止损或止盈
      const shouldExit = await checkAccountThresholds(accountInfo);
      if (shouldExit) {
        logger.error("账户余额触发退出条件，系统即将停止！");
        setTimeout(() => {
          process.exit(0);
        }, 5000);
        return;
      }
      
    } catch (error) {
      logger.error("获取账户信息失败:", error as any);
      return;
    }
    
    // 3. 同步持仓信息（优化：只调用一次API，避免重复）
    try {
      const gateClient = createGateClient();
      const rawGatePositions = await gateClient.getPositions();
      
      // 使用同一份数据进行处理和同步，避免重复调用API
      positions = await getPositions(rawGatePositions);
      await syncPositionsFromGate(rawGatePositions);
      
      const dbPositions = await dbClient.execute("SELECT COUNT(*) as count FROM positions");
      const dbCount = (dbPositions.rows[0] as any).count;
      
      if (positions.length !== dbCount) {
        logger.warn(`持仓同步不一致: Gate=${positions.length}, DB=${dbCount}`);
        // 再次同步，使用同一份数据
        await syncPositionsFromGate(rawGatePositions);
      }
    } catch (error) {
      logger.error("持仓同步失败:", error as any);
    }
    
    // 4. ====== 强制风控检查（在AI执行前） ======
    const gateClient = createGateClient();
    
    for (const pos of positions) {
      const symbol = pos.symbol;
      const side = pos.side;
      const leverage = pos.leverage;
      const entryPrice = pos.entry_price;
      const currentPrice = pos.current_price;
      
      // 计算盈亏百分比（考虑杠杆）
      const priceChangePercent = entryPrice > 0 
        ? ((currentPrice - entryPrice) / entryPrice * 100 * (side === 'long' ? 1 : -1))
        : 0;
      const pnlPercent = priceChangePercent * leverage;
      
      // 获取并更新峰值盈利
      let peakPnlPercent = 0;
      try {
        const dbPosResult = await dbClient.execute({
          sql: "SELECT peak_pnl_percent FROM positions WHERE symbol = ?",
          args: [symbol],
        });
        
        if (dbPosResult.rows.length > 0) {
          peakPnlPercent = Number.parseFloat(dbPosResult.rows[0].peak_pnl_percent as string || "0");
          
          // 如果当前盈亏超过历史峰值，更新峰值
          if (pnlPercent > peakPnlPercent) {
            peakPnlPercent = pnlPercent;
            await dbClient.execute({
              sql: "UPDATE positions SET peak_pnl_percent = ? WHERE symbol = ?",
              args: [peakPnlPercent, symbol],
            });
            logger.info(`${symbol} 峰值盈利更新: ${peakPnlPercent.toFixed(2)}%`);
          }
        }
      } catch (error: any) {
        logger.warn(`获取峰值盈利失败 ${symbol}: ${error.message}`);
      }
      
      let shouldClose = false;
      let closeReason = "";
      
      // a) 36小时强制平仓检查
      const openedTime = new Date(pos.opened_at);
      const now = new Date();
      const holdingHours = (now.getTime() - openedTime.getTime()) / (1000 * 60 * 60);
      
      if (holdingHours >= 36) {
        shouldClose = true;
        closeReason = `持仓时间已达 ${holdingHours.toFixed(1)} 小时，超过36小时限制`;
      }
      
      // b) 动态止损检查（根据杠杆）
      let stopLossPercent = -3; // 默认（15-25倍杠杆统一使用-3%）
      if (leverage >= 22) {
        stopLossPercent = -2;    // 22-25倍杠杆：更严格的止损
      } else if (leverage >= 18) {
        stopLossPercent = -2.5;  // 18-22倍杠杆：适中的止损
      } else {
        stopLossPercent = -3;    // 15-18倍杠杆：相对宽松的止损
      }
      
      if (pnlPercent <= stopLossPercent) {
        shouldClose = true;
        closeReason = `触发动态止损 (${pnlPercent.toFixed(2)}% ≤ ${stopLossPercent}%)`;
      }
      
      // c) 移动止盈检查
      if (!shouldClose) {
        let trailingStopPercent = stopLossPercent; // 默认使用初始止损
        
        if (pnlPercent >= 25) {
          trailingStopPercent = 15;
        } else if (pnlPercent >= 15) {
          trailingStopPercent = 8;
        } else if (pnlPercent >= 8) {
          trailingStopPercent = 3;
        }
        
        // 如果当前盈亏低于移动止损线
        if (pnlPercent < trailingStopPercent && trailingStopPercent > stopLossPercent) {
          shouldClose = true;
          closeReason = `触发移动止盈 (当前 ${pnlPercent.toFixed(2)}% < 移动止损线 ${trailingStopPercent}%)`;
        }
      }
      
      // d) 峰值回撤保护（如果持仓曾盈利）
      if (!shouldClose && peakPnlPercent > 5) {
        // 只对曾经盈利超过5%的持仓启用峰值回撤保护
        const drawdownFromPeak = peakPnlPercent > 0 
          ? ((peakPnlPercent - pnlPercent) / peakPnlPercent) * 100 
          : 0;
        
        if (drawdownFromPeak >= 30) {
          shouldClose = true;
          closeReason = `触发峰值回撤保护 (峰值 ${peakPnlPercent.toFixed(2)}% → 当前 ${pnlPercent.toFixed(2)}%，回撤 ${drawdownFromPeak.toFixed(1)}% ≥ 30%)`;
        }
      }
      
      // 执行强制平仓
      if (shouldClose) {
        logger.warn(`【强制平仓】${symbol} ${side} - ${closeReason}`);
        try {
          const contract = `${symbol}_USDT`;
          const size = side === 'long' ? -pos.quantity : pos.quantity;
          
          await gateClient.placeOrder({
            contract,
            size,
            price: 0,
            reduceOnly: true,
          });
          
          logger.info(`✅ 已强制平仓 ${symbol}，原因：${closeReason}`);
          
          // 从数据库删除持仓记录
          await dbClient.execute({
            sql: "DELETE FROM positions WHERE symbol = ?",
            args: [symbol],
          });
          
        } catch (closeError: any) {
          logger.error(`强制平仓失败 ${symbol}: ${closeError.message}`);
        }
      }
    }
    
    // 重新获取持仓（可能已经被强制平仓）
    positions = await getPositions();
    
    // 4. 不再保存账户历史（已移除资金曲线模块）
    // try {
    //   await saveAccountHistory(accountInfo);
    // } catch (error) {
    //   logger.error("保存账户历史失败:", error as any);
    //   // 不影响主流程
    // }
    
    // 5. 🔥 数据完整性最终检查
    const dataValid = 
      marketData && Object.keys(marketData).length > 0 &&
      accountInfo && accountInfo.totalBalance > 0 &&
      Array.isArray(positions);
    
    if (!dataValid) {
      logger.error("数据完整性检查失败，跳过本次循环");
      logger.error(`市场数据: ${Object.keys(marketData).length}, 账户: ${accountInfo?.totalBalance}, 持仓: ${positions.length}`);
      return;
    }
    
    // 6. 获取历史成交记录（最近10条）
    let tradeHistory: any[] = [];
    try {
      tradeHistory = await getTradeHistory(10);
    } catch (error) {
      logger.warn("获取历史成交记录失败:", error as any);
      // 不影响主流程，继续执行
    }
    
    // 7. 获取上一次的AI决策
    let recentDecisions: any[] = [];
    try {
      recentDecisions = await getRecentDecisions(1);
    } catch (error) {
      logger.warn("获取最近决策记录失败:", error as any);
      // 不影响主流程，继续执行
    }
    
    // 8. 生成提示词并调用 Agent
    const prompt = generateTradingPrompt({
      minutesElapsed,
      iteration: iterationCount,
      intervalMinutes,
      marketData,
      accountInfo,
      positions,
      tradeHistory,
      recentDecisions,
    });
    
    // 🔥 输出完整提示词到日志
    logger.info("【入参 - AI 提示词】");
    logger.info("=".repeat(80));
    logger.info(prompt);
    logger.info("=".repeat(80) + "\n");
    
    const agent = createTradingAgent(intervalMinutes);
    
    try {
      const response = await agent.generateText(prompt);
      
      // 从响应中提取AI的最终决策结果，排除工具调用细节
      let decisionText = "";
      
      if (typeof response === 'string') {
        decisionText = response;
      } else if (response && typeof response === 'object') {
        const steps = (response as any).steps || [];
        
        // 查找最后一次AI的文本回复（这是真正的决策结果）
        for (let i = steps.length - 1; i >= 0; i--) {
          const step = steps[i];
          if (step.content) {
            for (let j = step.content.length - 1; j >= 0; j--) {
              const item = step.content[j];
              if (item.type === 'text' && item.text) {
                decisionText = item.text;
                break;
              }
            }
          }
          if (decisionText) break;
        }
        
        // 如果没有找到文本消息，尝试其他字段
        if (!decisionText) {
          decisionText = (response as any).text || (response as any).message || "";
        }
        
        // 如果还是没有文本回复，说明AI只是调用了工具，没有做出决策
        if (!decisionText && steps.length > 0) {
          decisionText = "AI调用了工具但未产生决策结果";
        }
      }
      
      logger.info("【输出 - AI 决策】");
      logger.info("=".repeat(80));
      logger.info(decisionText || "无决策输出");
      logger.info("=".repeat(80) + "\n");
      
      // 保存决策记录
      await dbClient.execute({
        sql: `INSERT INTO agent_decisions 
              (timestamp, iteration, market_analysis, decision, actions_taken, account_value, positions_count)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          new Date().toISOString(),
          iterationCount,
          JSON.stringify(marketData),
          decisionText,
          "[]",
          accountInfo.totalBalance,
          positions.length,
        ],
      });
      
      // Agent 执行后重新同步持仓数据（优化：只调用一次API）
      const updatedRawPositions = await gateClient.getPositions();
      await syncPositionsFromGate(updatedRawPositions);
      const updatedPositions = await getPositions(updatedRawPositions);
      
      // 重新获取更新后的账户信息，包含最新的未实现盈亏
      const updatedAccountInfo = await getAccountInfo();
      const finalUnrealizedPnL = updatedPositions.reduce((sum: number, pos: any) => sum + (pos.unrealized_pnl || 0), 0);
      
      logger.info("【最终 - 持仓状态】");
      logger.info("=".repeat(80));
      logger.info(`账户: ${updatedAccountInfo.totalBalance.toFixed(2)} USDT (可用: ${updatedAccountInfo.availableBalance.toFixed(2)}, 收益率: ${updatedAccountInfo.returnPercent.toFixed(2)}%)`);
      
      if (updatedPositions.length === 0) {
        logger.info("持仓: 无");
      } else {
        logger.info(`持仓: ${updatedPositions.length} 个`);
        updatedPositions.forEach((pos: any) => {
          // 计算盈亏百分比：考虑杠杆倍数
          // 对于杠杆交易：盈亏百分比 = (价格变动百分比) × 杠杆倍数
          const priceChangePercent = pos.entry_price > 0 
            ? ((pos.current_price - pos.entry_price) / pos.entry_price * 100 * (pos.side === 'long' ? 1 : -1))
            : 0;
          const pnlPercent = priceChangePercent * pos.leverage;
          logger.info(`  ${pos.symbol} ${pos.side === 'long' ? '做多' : '做空'} ${pos.quantity}张 (入场: ${pos.entry_price.toFixed(2)}, 当前: ${pos.current_price.toFixed(2)}, 盈亏: ${pos.unrealized_pnl >= 0 ? '+' : ''}${pos.unrealized_pnl.toFixed(2)} USDT / ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`);
        });
      }
      
      logger.info(`未实现盈亏: ${finalUnrealizedPnL >= 0 ? '+' : ''}${finalUnrealizedPnL.toFixed(2)} USDT`);
      logger.info("=".repeat(80) + "\n");
      
    } catch (agentError) {
      logger.error("Agent 执行失败:", agentError as any);
      try {
        await syncPositionsFromGate();
      } catch (syncError) {
        logger.error("同步失败:", syncError as any);
      }
    }
    
  } catch (error) {
    logger.error("交易循环执行失败:", error as any);
    try {
      await syncPositionsFromGate();
    } catch (recoveryError) {
      logger.error("恢复失败:", recoveryError as any);
    }
  }
}

/**
 * 初始化交易系统配置
 */
export async function initTradingSystem() {
  logger.info("初始化交易系统配置...");
  
  // 1. 加载配置
  accountRiskConfig = getAccountRiskConfig();
  logger.info(`环境变量配置: 止损线=${accountRiskConfig.stopLossUsdt} USDT, 止盈线=${accountRiskConfig.takeProfitUsdt} USDT`);
  
  // 2. 如果启用了启动时同步，则同步配置到数据库
  if (accountRiskConfig.syncOnStartup) {
    await syncConfigToDatabase();
  } else {
    // 否则从数据库加载配置
    await loadConfigFromDatabase();
  }
  
  logger.info(`最终配置: 止损线=${accountRiskConfig.stopLossUsdt} USDT, 止盈线=${accountRiskConfig.takeProfitUsdt} USDT`);
}

/**
 * 启动交易循环
 */
export function startTradingLoop() {
  const intervalMinutes = Number.parseInt(
    process.env.TRADING_INTERVAL_MINUTES || "5"
  );
  
  logger.info(`启动交易循环，间隔: ${intervalMinutes} 分钟`);
  logger.info(`支持币种: ${SYMBOLS.join(", ")}`);
  
  // 立即执行一次
  executeTradingDecision();
  
  // 设置定时任务
  const cronExpression = `*/${intervalMinutes} * * * *`;
  cron.schedule(cronExpression, () => {
    executeTradingDecision();
  });
  
  logger.info(`定时任务已设置: ${cronExpression}`);
}

/**
 * 重置交易开始时间（用于恢复之前的交易）
 */
export function setTradingStartTime(time: Date) {
  tradingStartTime = time;
}

/**
 * 重置迭代计数（用于恢复之前的交易）
 */
export function setIterationCount(count: number) {
  iterationCount = count;
}

