import { KissStrategy }       from './strategies/kiss.js';
import { SwingStrategy }      from './strategies/swing.js';
import { ScalpStrategy }      from './strategies/scalp.js';
import { TrendStrategy }      from './strategies/trend.js';
import { ORBStrategy }        from './strategies/orb.js';
import { MomentumStrategy }   from './strategies/momentum.js';
import { SyntheticScalper }   from './strategies/synthetic-scalper.js';
import { CryptoScalper }      from './strategies/crypto-scalper.js';
import { RSIFadeScalper }     from './strategies/rsi-fade.js';
import { RangeBoundaryScalper } from './strategies/range-boundary.js';
import { VWAPReversionScalper } from './strategies/vwap-reversion.js';
import { CandleSpeedScalper } from './strategies/candle-speed.js';
import { LondonBreakout }     from './strategies/london-breakout.js';
import { NewsFadeScalper }    from './strategies/news-fade.js';
import { UltraScalper }       from './strategies/ultra-scalper.js';

export class StrategyEngine {
    constructor() {
        this.lastSignalTime = 0;
    }

    analyze(strategyType, lowerTFCandles, higherTFCandles, rsiState, atr, symbol = '', rsi = null) {
        let signal = null;

        switch (strategyType) {
            case 'h4_kiss':         signal = KissStrategy.checkEntry(lowerTFCandles, higherTFCandles);                       break;
            case 'swing':           signal = SwingStrategy.checkEntry(lowerTFCandles);                                       break;
            case 'scalp':           signal = ScalpStrategy.checkEntry(lowerTFCandles, rsiState);                             break;
            case 'trend':           signal = TrendStrategy.checkEntry(lowerTFCandles);                                       break;
            case 'orb':             signal = ORBStrategy.checkEntry(lowerTFCandles);                                         break;
            case 'momentum':        signal = MomentumStrategy.checkEntry(lowerTFCandles, atr, symbol, higherTFCandles, rsi); break;
            case 'synthetic_scalp': signal = SyntheticScalper.checkEntry(lowerTFCandles, atr);                               break;
            case 'crypto_scalp':    signal = CryptoScalper.checkEntry(lowerTFCandles, atr);                                  break;
            case 'rsi_fade':        signal = RSIFadeScalper.checkEntry(lowerTFCandles, atr);                                 break;
            case 'range_boundary':  signal = RangeBoundaryScalper.checkEntry(lowerTFCandles, atr);                           break;
            case 'vwap_reversion':  signal = VWAPReversionScalper.checkEntry(lowerTFCandles, atr);                           break;
            case 'candle_speed':    signal = CandleSpeedScalper.checkEntry(lowerTFCandles, atr);                             break;
            case 'london_breakout': signal = LondonBreakout.checkEntry(lowerTFCandles, atr);                                 break;
            case 'news_fade':       signal = NewsFadeScalper.checkEntry(lowerTFCandles, atr);                                break;
            case 'ultra_scalp':     signal = UltraScalper.checkEntry(lowerTFCandles, atr);                                   break;
        }

        if (signal && lowerTFCandles[lowerTFCandles.length - 1].time > this.lastSignalTime) {
            this.lastSignalTime = lowerTFCandles[lowerTFCandles.length - 1].time;
            return signal;
        }

        return null;
    }
}