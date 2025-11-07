import { Address, Bytes, BigInt, BigDecimal, log, dataSource } from '@graphprotocol/graph-ts';
import { Pool, Balancer, Token, FXOracle } from '../types/schema';
import {
  ZERO_BD,
  PRICING_ASSETS,
  USD_STABLE_ASSETS,
  ONE_BD,
  ZERO_ADDRESS,
  MIN_POOL_LIQUIDITY,
} from './helpers/constants';
import { hasVirtualSupply, isComposableStablePool, isLinearPool, isFXPool, PoolType } from './helpers/pools';
import {
  bytesToAddress,
  createPoolSnapshot,
  getToken,
  getTokenPriceId,
  loadPoolToken,
  scaleDown,
} from './helpers/misc';
import { AaveLinearPool } from '../types/AaveLinearPoolFactory/AaveLinearPool';
import {
  FX_ASSET_AGGREGATORS,
  MAX_POS_PRICE_CHANGE,
  MAX_NEG_PRICE_CHANGE,
  MAX_TIME_DIFF_FOR_PRICING,
} from './helpers/constants';
import { AnswerUpdated } from '../types/templates/OffchainAggregator/AccessControlledOffchainAggregator';
export function isPricingAsset(asset: Address): boolean {
  for (let i: i32 = 0; i < PRICING_ASSETS.length; i++) {
    if (PRICING_ASSETS[i] == asset) return true;
  }
  return false;
}

export function getPreferentialPricingAsset(assets: Address[]): Address {
  // Assumes PRICING_ASSETS are sorted by order of preference
  for (let i: i32 = 0; i < PRICING_ASSETS.length; i++) {
    if (assets.includes(PRICING_ASSETS[i])) return PRICING_ASSETS[i];
  }
  return ZERO_ADDRESS;
}

export function updatePoolLiquidity(poolId: string, block_number: BigInt, timestamp: BigInt): boolean {
  let pool = Pool.load(poolId);
  if (pool == null) return false;

  // Create or update pool daily snapshot
  createPoolSnapshot(pool, timestamp.toI32());

  return true;
}

export function valueInFX(value: BigDecimal, asset: Address): BigDecimal {
  let token = getToken(asset);

  if (token.latestFXPrice) {
    // convert to USD using latestFXPrice
    const latestFXPrice = token.latestFXPrice as BigDecimal;
    return value.times(latestFXPrice);
  } else {
    // fallback if latestFXPrice is not available
    return BigDecimal.fromString('0');
  }
}

export function getLatestPriceId(tokenAddress: Address, pricingAsset: Address): string {
  return tokenAddress.toHexString().concat('-').concat(pricingAsset.toHexString());
}

export function isUSDStable(asset: Address): boolean {
  for (let i: i32 = 0; i < USD_STABLE_ASSETS.length; i++) {
    if (USD_STABLE_ASSETS[i] == asset) return true;
  }
  return false;
}

export function handleAnswerUpdated(event: AnswerUpdated): void {
  const aggregatorAddress = event.address;
  const answer = event.params.current;
  const tokenAddressesToUpdate: Address[] = [];

  // Check if the aggregator is under FX_ASSET_AGGREGATORS first (FXPoolFactory version)
  for (let i = 0; i < FX_ASSET_AGGREGATORS.length; i++) {
    if (aggregatorAddress == FX_ASSET_AGGREGATORS[i][1]) {
      tokenAddressesToUpdate.push(FX_ASSET_AGGREGATORS[i][0]);
    }
  }

  // Also check if aggregator exists from FXOracle entity (FXPoolDeployer version)
  let oracle = FXOracle.load(aggregatorAddress.toHexString());
  if (oracle) {
    for (let i = 0; i < oracle.tokens.length; i++) {
      const tokenAddress = Address.fromBytes(oracle.tokens[i]);
      const tokenExists = tokenAddressesToUpdate.includes(tokenAddress);
      if (!tokenExists) {
        tokenAddressesToUpdate.push(tokenAddress);
      }
    }
  } else {
    log.warning('Oracle not found: {}', [aggregatorAddress.toHexString()]);
  }

  // Update all tokens using this aggregator
  for (let i = 0; i < tokenAddressesToUpdate.length; i++) {
    const tokenAddress = tokenAddressesToUpdate[i];

    const token = Token.load(tokenAddress.toHexString());
    if (token == null) {
      log.warning('Token with address {} not found', [tokenAddress.toHexString()]);
      continue;
    }

    // All tokens we track have oracles with 8 decimals
    if (!token.fxOracleDecimals) {
      token.fxOracleDecimals = 8; // @todo: get decimals on-chain
    }

    if (tokenAddress == Address.fromString('0xc8bb8eda94931ca2f20ef43ea7dbd58e68400400')) {
      // XAU-USD oracle returns an answer with price unit of "USD per troy ounce"
      // For VNXAU however, we wanna use a price unit of "USD per gram"
      const divisor = '3110347680'; // 31.1034768 * 1e8 (31.10 gram per troy ounce)
      const multiplier = '100000000'; // 1 * 1e8
      const pricePerGram = answer.times(BigInt.fromString(multiplier)).div(BigInt.fromString(divisor));
      token.latestFXPrice = scaleDown(pricePerGram, 8);
    } else if (oracle && oracle.divisor !== null && oracle.decimals) {
      const updatedAnswer = answer
        .times(BigInt.fromString('10').pow(oracle.decimals as u8))
        .div(BigInt.fromString(oracle.divisor!));
      token.latestFXPrice = scaleDown(updatedAnswer, 8);
    } else {
      token.latestFXPrice = scaleDown(answer, 8);
    }

    token.save();
  }
}
