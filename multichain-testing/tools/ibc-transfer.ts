import { ExecutionContext } from 'ava';
import type { StdFee } from '@cosmjs/amino';
import { coins } from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';
import { useChain } from 'starshipjs';
import type {
  CosmosChainInfo,
  DenomAmount,
  IBCMsgTransferOptions,
} from '@agoric/orchestration';
import {
  MILLISECONDS_PER_SECOND,
  NANOSECONDS_PER_MILLISECOND,
  SECONDS_PER_MINUTE,
} from '@agoric/orchestration/src/utils/time.js';
import { MsgTransfer } from '@agoric/cosmic-proto/ibc/applications/transfer/v1/tx.js';
import { createWallet } from './wallet.js';
import chainInfo from '../starship-chain-info.js';

interface MakeFeeObjectArgs {
  denom?: string;
  gas: number;
  gasPrice: number;
}

export const makeFeeObject = ({
  denom,
  gas,
  gasPrice,
}: MakeFeeObjectArgs): StdFee => ({
  amount: coins(gas * gasPrice, denom || 'uist'),
  gas: String(gas),
});

type SimpleChainAddress = {
  address: string;
  chainName: string;
};

/**
 * @param {number} ms current time in ms (e.g. Date.now())
 * @param {bigint} [minutes=5n] number of minutes in the future
 * @returns {bigint} nanosecond timestamp 5 mins in the future */
export const getTimeout = (ms: number, minutes = 5n) => {
  console.debug('Current Time (ms):', ms);
  console.debug('Current Time (ISO):', new Date(ms).toISOString());
  const timeoutMS =
    BigInt(ms) + MILLISECONDS_PER_SECOND * SECONDS_PER_MINUTE * minutes;
  console.debug('Timeout Time (ms):', timeoutMS);
  const timeoutNS = timeoutMS * NANOSECONDS_PER_MILLISECOND;
  console.debug('Timeout Time (ns):', timeoutNS);
  return timeoutNS;
};

export const makeIBCTransferMsg = (
  amount: DenomAmount,
  destination: SimpleChainAddress,
  sender: SimpleChainAddress,
  currentTime: number,
  opts: IBCMsgTransferOptions = {},
) => {
  const { timeoutHeight, timeoutTimestamp, memo = '' } = opts;

  const destChainInfo = (chainInfo as Record<string, CosmosChainInfo>)[
    destination.chainName
  ];
  if (!destChainInfo) throw Error(`No chain info for ${destination.chainName}`);
  const senderChainInfo = useChain(sender.chainName).chainInfo;
  const connection =
    destChainInfo.connections?.[senderChainInfo.chain.chain_id];
  if (!connection)
    throw Error(
      `No connection found between ${sender.chainName} and ${destination.chainName}`,
    );
  const { counterPartyPortId, counterPartyChannelId } =
    connection.transferChannel;

  const msgTransfer = MsgTransfer.fromPartial({
    sender: sender.address,
    receiver: destination.address,
    token: { denom: amount.denom, amount: String(amount.value) },
    sourcePort: counterPartyPortId,
    sourceChannel: counterPartyChannelId,
    timeoutHeight,
    timeoutTimestamp: timeoutHeight
      ? undefined
      : timeoutTimestamp ?? getTimeout(currentTime),
    memo,
  });
  const { fee_tokens } = senderChainInfo.chain.fees ?? {};
  if (!fee_tokens || !fee_tokens.length) {
    throw Error('no fee tokens in chain config for' + sender.chainName);
  }
  const { high_gas_price, denom } = fee_tokens[0];
  if (!high_gas_price) throw Error('no high gas price in chain config');
  const fee = makeFeeObject({
    denom: denom,
    gas: 150000,
    gasPrice: high_gas_price,
  });

  return [
    msgTransfer.sender,
    msgTransfer.receiver,
    msgTransfer.token,
    msgTransfer.sourcePort,
    msgTransfer.sourceChannel,
    msgTransfer.timeoutHeight,
    Number(msgTransfer.timeoutTimestamp),
    fee,
    msgTransfer.memo,
  ];
};

export const createFundedWalletAndClient = async (
  t: ExecutionContext,
  chainName: string,
) => {
  const { chain, creditFromFaucet, getRpcEndpoint } = useChain(chainName);
  const wallet = await createWallet(chain.bech32_prefix);
  const address = (await wallet.getAccounts())[0].address;
  t.log(`Requesting faucet funds for ${address}`);
  await creditFromFaucet(address);
  // TODO use telescope generated rpc client from @agoric/cosmic-proto
  // https://github.com/Agoric/agoric-sdk/issues/9200
  const client = await SigningStargateClient.connectWithSigner(
    getRpcEndpoint(),
    wallet,
  );
  return { client, wallet, address };
};
