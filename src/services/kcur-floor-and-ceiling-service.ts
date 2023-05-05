import { ITransaction } from "../globals";
import { getContract } from "../helpers/contracts-helper";
import { logMessage, serviceThrewException } from "../helpers/errors-helper";
import { createAllowance } from "../helpers/tokens-helper";

import { DefenderRelaySigner } from "defender-relay-client/lib/ethers/signer";
import { BigNumber, FixedNumber } from "ethers";
import { BytesLike } from "ethers/lib/utils";

const serviceName = "FloorCeiling Service";

interface IFundManagement {
  sender: string;
  fromInternalBalance: boolean; // always false
  recipient: string;
  toInternalBalance: boolean; // always false
}

interface IBatchSwapStep {
  poolId: BytesLike;
  assetInIndex: number; // index of token In address in assets array
  assetOutIndex: number; // index of token Out address in assets array
  amount: BigNumber; // if using batchSwapExactIn:
  userData: string; // always empty string
}

/**
 * execute a buy or sell between cUSD and kCUR
 */
const sendBuyOrSell = async (
  signer: DefenderRelaySigner,
  relayerAddress: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proxyPoolContract: any,
  kCurContractAddress: string,
  cUsdContractAddress: string,
  /**
   * number of tokens we're paying in
   */
  amount: BigNumber,
  /**
   * if true then we're buying kCUR with cUSD
   * if false then we're buying cUSD with kCUR
   */
  buyingKCur: boolean,
): Promise<ITransaction> => {
  /**
   * docs: https://github.com/Kolektivo/kolektivo-monetary-contracts/blob/feat/mihir/src/dex/IVault.sol#L910
   */
  const funds: IFundManagement = {
    sender: relayerAddress,
    fromInternalBalance: false, // always false
    recipient: relayerAddress,
    toInternalBalance: false, // always false
  };

  const kCurPool = getContract("kCur Pool", signer);
  const poolId: BytesLike = await kCurPool.getPoolId();
  /**
   * docs: https://github.com/Kolektivo/kolektivo-monetary-contracts/blob/feat/mihir/src/dex/IVault.sol#L881
   */
  const batchSwapStep: IBatchSwapStep = {
    /**
     * kCUR pool id
     */
    poolId,
    /**
     * index of token In address in assets array (see assets below)
     */
    assetInIndex: 0,
    /**
     * index of token Out address in assets array (see assets below)
     */
    assetOutIndex: 1,
    /**
     * what we are paying.
     */
    amount: amount,
    /**
     * always empty string
     */
    userData: "0x",
  };
  /**
   * empty array to set limits
   * limit says how many tokens can Vault use on behalf of user
   * for us, it will be always empty array
   */
  const limits: Array<number> = [];
  /**
   * deadline is by what time the swap should be executed
   */
  const deadline: number = 60 * 60; // for us we can set it to one hour | used previously in Prime Launch

  const assets = buyingKCur ? [cUsdContractAddress, kCurContractAddress] : [kCurContractAddress, cUsdContractAddress];
  /**
   * make the purchase
   */
  return proxyPoolContract.batchSwapExactIn(
    [batchSwapStep],
    assets,
    batchSwapStep.amount,
    BigNumber.from("10000000000000000"), // TODO - figure out what this should be
    funds,
    limits,
    deadline,
  );
};

const doit = async (
  isFloor: boolean,
  delta: BigNumber,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kCurContract: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cUsdContract: any,
  relayerAddress: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proxyPoolContract: any,
  signer: DefenderRelaySigner,
): Promise<ITransaction> => {
  /**
   * tell kCUR token to allow the Vault to spend kCUR on behalf of the Relayer
   */
  const vault = getContract("Vault", signer);
  /**
   * tell kCUR token to allow the proxy contract to spend kCUR on behalf of the Relayer
   */
  await Promise.all([
    createAllowance(
      signer,
      kCurContract,
      isFloor ? "kCUR" : "cUSD",
      delta,
      relayerAddress,
      proxyPoolContract.address,
      serviceName,
    ),

    // eslint-disable-next-line prettier/prettier
    createAllowance(signer,
      kCurContract,
      isFloor ? "kCUR" : "cUSD",
      delta,
      relayerAddress,
      vault.address,
      serviceName),
  ]);
  /**
   * isFloor: buy cUSD with kCUR
   * else: buy kCUR with cUSD
   */
  return sendBuyOrSell(
    signer,
    relayerAddress,
    proxyPoolContract,
    kCurContract.address,
    cUsdContract.address,
    delta,
    !isFloor,
  );
};

export const executeFloorAndCeilingService = async (
  kCurPrice: number,
  relayerAddress: string,
  signer: DefenderRelaySigner,
): Promise<void> => {
  logMessage(serviceName, "executing...");

  try {
    const reserveContract = getContract("Reserve", signer);
    const kCurContract = getContract("CuracaoReserveToken", signer);
    // const cUsdContract = getContract("cUSD", signer);
    const proxyPoolContract = getContract("ProxyPool", signer);
    /**
     * reserve value in USD
     */
    const reserveValue = FixedNumber.from((await reserveContract.reserveStatus())[0].toString());
    const kCurTotalSupply = FixedNumber.from(await kCurContract.totalSupply().toString());

    if (kCurTotalSupply.isZero()) {
      throw new Error("kCur totalSupply is zero");
    }
    /** floor in USD */
    const floor: number = reserveValue.divUnsafe(FixedNumber.from(kCurTotalSupply)).toUnsafeFloat();
    logMessage(serviceName, `reserve floor: ${floor.toString()}`);
    /**
     * multiplier as a number
     */
    const ceilingMultiplier: number = FixedNumber.from(await proxyPoolContract.ceilingMultiplier())
      .divUnsafe(FixedNumber.from(10000))
      .toUnsafeFloat();
    /**
     * ceiling in USD
     */
    const ceiling = floor * ceilingMultiplier;
    logMessage(serviceName, `reserve ceiling: ${ceiling}`);

    // const reserveToken = await proxyPoolContract.reserveToken();
    // const pairToken = await proxyPoolContract.pairToken();

    /**
     * TODO: this logic makes no sense.  Gtta find better logic
     */
    // if (kCurPrice < floor) {
    //   logMessage(serviceName, `kCur price ${kCurPrice} is below the floor ${floor}`);
    //   const delta = floor - kCurPrice + 0.001 / kCurPrice;
    //   const tx = await doit(
    //     true,
    //     BigNumber.from(delta),
    //     kCurContract,
    //     cUsdContract,
    //     relayerAddress,
    //     proxyPoolContract,
    //     signer,
    //   );
    //   logMessage(serviceName, `Bought ${delta.toString()} cUSD with kCUR, tx hash: ${tx.hash}`);
    // } else if (kCurPrice > ceiling) {
    //   logMessage(serviceName, `kCur price ${kCurPrice} is above the ceiling ${ceiling.toString()}`);
    //   const delta = kCurPrice - ceiling + 0.001; // add just a little buffer
    //   const tx = await doit(
    //     false,
    //     BigNumber.from(delta),
    //     kCurContract,
    //     cUsdContract,
    //     relayerAddress,
    //     proxyPoolContract,
    //     signer,
    //   );
    //   logMessage(serviceName, `Bought ${delta} kCUR with cUSD, tx hash: ${tx.hash}`);
    // }
  } catch (ex) {
    serviceThrewException(serviceName, ex);
  }
};
