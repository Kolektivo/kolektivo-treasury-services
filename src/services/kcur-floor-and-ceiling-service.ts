import { ITransaction } from "../globals";
import { fromWei, getContract, toWei } from "../helpers/contracts-helper";
import { logMessage, serviceThrewException } from "../helpers/errors-helper";
import { createAllowance, IErc20Token } from "../helpers/tokens-helper";

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
   * amount of kCUR to buy or sell
   */
  amount: BigNumber,
  /**
   * if true then we're buying kCUR with cUSD
   * if false then we're selling kCUR for cUSD
   */
  isBuying: boolean,
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
     * amount of kCUR we are buying or selling.
     */
    amount: amount,
    /**
     * always empty string
     */
    userData: "0x",
  };
  /**
   * limit says how many tokens can Vault use on behalf of user
   */
  const limits: Array<BigNumber> = [toWei(1000000, 18), toWei(1000000, 18)];
  /**
   * deadline is by what time the swap should be executed
   */
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const deadline: number = currentTimestamp + 60 * 60; // for us we can set it to one hour | used previously in Prime Launch
  /**
   * kCUR is always the "exact" amount
   */
  if (isBuying) {
    logMessage(serviceName, `buying kCUR (${fromWei(batchSwapStep.amount, 18)}) with cUSD`);
    // buying kCUR (out) with cUSD (in)
    return proxyPoolContract.batchSwapExactOut(
      [batchSwapStep],
      [cUsdContractAddress, kCurContractAddress],
      batchSwapStep.amount,
      funds,
      limits,
      deadline,
    );
  } else {
    logMessage(serviceName, `selling kCUR (${fromWei(batchSwapStep.amount, 18)}) for cUSD`);
    // selling kCUR (in) to get cUSD (out)
    return proxyPoolContract.batchSwapExactIn(
      [batchSwapStep],
      [kCurContractAddress, cUsdContractAddress],
      batchSwapStep.amount,
      100000000, // minTotalAmountOut  TODO - figure out what this should be
      funds,
      limits,
      deadline,
    );
  }
};

const doit = async (
  /**
   * if true then we're buying kCUR with cUSD
   * if false then we're selling kCUR for cUSD
   */
  isBuying: boolean,
  /**
   * amount of kCUR to receive when buying or to pay when selling
   */
  kCurAmount: BigNumber,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kCurContract: IErc20Token,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cUsdContract: IErc20Token,
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
   * tell token to allow the proxy contract to spend token on behalf of the Relayer
   * Since we can't know the amount of cUSD in advance (kCUr is always the fixed amount int he exchange),
   * we will set the allowance the full balance of cUSD in relayer (maybe is better than unlimited, wishful thinking).
   */
  const cUsdAmount = isBuying ? await cUsdContract.balanceOf(relayerAddress) : null;
  await Promise.all([
    createAllowance(
      signer,
      kCurContract,
      isBuying ? "cUSD" : "kCUR",
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      isBuying ? cUsdAmount! : kCurAmount,
      relayerAddress,
      proxyPoolContract.address,
      serviceName,
    ),

    // eslint-disable-next-line prettier/prettier
    createAllowance(signer,
      kCurContract,
      isBuying ? "cUSD" : "kCUR",
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      isBuying ? cUsdAmount! : kCurAmount,
      relayerAddress,
      vault.address,
      serviceName,
    ),
  ]);

  return sendBuyOrSell(
    signer,
    relayerAddress,
    proxyPoolContract,
    kCurContract.address,
    cUsdContract.address,
    kCurAmount,
    isBuying,
  );
};

export const executeFloorAndCeilingService = async (
  cUsdPrice: number,
  kCurPrice: number,
  relayerAddress: string,
  signer: DefenderRelaySigner,
): Promise<void> => {
  logMessage(serviceName, "executing...");

  try {
    const reserveContract = getContract("Reserve", signer);
    const kCurContract = getContract("CuracaoReserveToken", signer) as unknown as IErc20Token;
    const cUsdContract = getContract("cUSD", signer) as unknown as IErc20Token;
    const proxyPoolContract = getContract("ProxyPool", signer);
    logMessage(serviceName, `Proxy pool address is: ${proxyPoolContract.address}`);

    /**
     * reserve value in USD
     */
    const reserveValue = FixedNumber.fromValue((await reserveContract.reserveStatus())[0], 0, "fixed32x18");
    const kCurTotalSupply = FixedNumber.fromValue(await kCurContract.totalSupply(), 0, "fixed32x18");

    if (kCurTotalSupply.isZero()) {
      throw new Error("kCur totalSupply is zero");
    }
    /** floor in USD */
    const floor: number = reserveValue.divUnsafe(kCurTotalSupply).toUnsafeFloat();
    logMessage(serviceName, `reserve floor: ${floor.toString()}`);
    /**
     * multiplier as a number
     */
    const ceilingMultiplier: number = FixedNumber.fromValue(
      await proxyPoolContract.ceilingMultiplier(),
      0,
      "fixed32x18",
    )
      .divUnsafe(FixedNumber.fromString("10000", "fixed32x18"))
      .toUnsafeFloat();
    /**
     * ceiling in USD
     */
    const ceiling = floor * ceilingMultiplier;
    logMessage(serviceName, `reserve ceiling: ${ceiling}`);

    // const reserveToken = await proxyPoolContract.reserveToken();
    // const pairToken = await proxyPoolContract.pairToken();

    /**
     * TODO: this logic makes no sense.  Gotta find better logic
     */

    /**
     * Is below the floor.  Gotta buy kCUR, using cUSD
     */
    if (kCurPrice < floor) {
      logMessage(serviceName, `kCur price ${kCurPrice} is below the floor ${floor}`);

      const delta = toWei((floor - kCurPrice) / kCurPrice, 18).add(1);
      const tx = await doit(true, delta, kCurContract, cUsdContract, relayerAddress, proxyPoolContract, signer);

      logMessage(serviceName, `Bought ${fromWei(delta, 18)} kCUR with cUSD, tx hash: ${tx.hash}`);
      /**
       * Is above the ceiling, gotta sell kCUR, for cUSD
       */
    } else if (kCurPrice > ceiling) {
      logMessage(serviceName, `kCur price ${kCurPrice} is above the ceiling ${ceiling.toString()}`);

      const delta = toWei((kCurPrice - ceiling) / kCurPrice, 18).add(1); // add just a little buffer
      const tx = await doit(false, delta, kCurContract, cUsdContract, relayerAddress, proxyPoolContract, signer);

      logMessage(serviceName, `Sold ${fromWei(delta, 18)} kCUR for cUSD, tx hash: ${tx.hash}`);
    }
  } catch (ex) {
    serviceThrewException(serviceName, ex);
  }
};
