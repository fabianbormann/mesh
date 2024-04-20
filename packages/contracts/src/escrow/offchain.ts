import { MeshTxInitiator, MeshTxInitiatorInput } from '@mesh/common';
import {
  serializeBech32Address,
  applyParamsToScript,
  v2ScriptToBech32,
  ConStr0,
  parseDatumCbor,
  PubKeyAddress,
  Value,
  conStr0,
  pubKeyAddress,
  value,
  mConStr1,
  ConStr1,
  conStr1,
  parsePlutusAddressObjToBech32,
  parsePlutusValueToAssets,
  mConStr2,
} from '@meshsdk/mesh-csl';
import blueprint from './aiken-workspace/plutus.json';
import { Asset, UTxO } from '@meshsdk/core';

export type InitiationDatum = ConStr0<[PubKeyAddress, Value]>;
export const initiateEscrowDatum = (
  walletAddress: string,
  amount: Asset[]
): InitiationDatum => {
  const { pubKeyHash, stakeCredential } = serializeBech32Address(walletAddress);
  return conStr0([pubKeyAddress(pubKeyHash, stakeCredential), value(amount)]);
};

export type ActiveEscrowDatum = ConStr1<
  [PubKeyAddress, Value, PubKeyAddress, Value]
>;
export const activeEscrowDatum = (
  initiationDatum: InitiationDatum,
  walletAddress: string,
  amount: Asset[]
): ActiveEscrowDatum => {
  const { pubKeyHash, stakeCredential } = serializeBech32Address(walletAddress);
  const [initiator, initiatorAmount] = initiationDatum.fields;
  return conStr1([
    initiator,
    initiatorAmount,
    pubKeyAddress(pubKeyHash, stakeCredential),
    value(amount),
  ]);
};

export type RecipientDepositRedeemer = ConStr0<[PubKeyAddress, Value]>;
export const recipientDepositRedeemer = (
  recipient: string,
  depositAmount: Asset[]
) => initiateEscrowDatum(recipient, depositAmount);

export class MeshEscrowContract extends MeshTxInitiator {
  scriptCbor = applyParamsToScript(blueprint.validators[0].compiledCode, []);

  constructor(inputs: MeshTxInitiatorInput) {
    super(inputs);
  }

  initiateEscrow = async (
    escrowAmount: Asset[],
    networkId = 0
  ): Promise<string> => {
    const { utxos, walletAddress } = await this.getWalletInfoForTx();
    const scriptAddr = v2ScriptToBech32(this.scriptCbor, undefined, networkId);

    await this.mesh
      .txOut(scriptAddr, escrowAmount)
      .txOutInlineDatumValue(
        initiateEscrowDatum(walletAddress, escrowAmount),
        'JSON'
      )
      .changeAddress(walletAddress)
      .selectUtxosFrom(utxos)
      .complete();
    return this.mesh.txHex;
  };

  cancelEscrow = async (escrowUtxo: UTxO, networkId = 0): Promise<string> => {
    const { utxos, walletAddress, collateral } =
      await this.getWalletInfoForTx();
    const scriptAddr = v2ScriptToBech32(this.scriptCbor, undefined, networkId);

    await this.mesh
      .spendingPlutusScriptV2()
      .txIn(
        escrowUtxo.input.txHash,
        escrowUtxo.input.outputIndex,
        escrowUtxo.output.amount,
        scriptAddr
      )
      .spendingReferenceTxInInlineDatumPresent()
      .spendingReferenceTxInRedeemerValue(mConStr1([]))
      .txInScript(this.scriptCbor)
      .requiredSignerHash(serializeBech32Address(walletAddress).pubKeyHash)
      .changeAddress(walletAddress)
      .txInCollateral(
        collateral.input.txHash,
        collateral.input.outputIndex,
        collateral.output.amount,
        collateral.output.address
      )
      .selectUtxosFrom(utxos)
      .complete();
    return this.mesh.txHex;
  };

  recipientDeposit = async (
    escrowUtxo: UTxO,
    depositAmount: Asset[],
    networkId = 0
  ): Promise<string> => {
    const { utxos, walletAddress, collateral } =
      await this.getWalletInfoForTx();
    const scriptAddr = v2ScriptToBech32(this.scriptCbor, undefined, networkId);
    const inputDatum = parseDatumCbor<InitiationDatum>(
      escrowUtxo.output.plutusData!
    );
    const outputDatum = activeEscrowDatum(
      inputDatum,
      walletAddress,
      depositAmount
    );

    await this.mesh
      .spendingPlutusScriptV2()
      .txIn(
        escrowUtxo.input.txHash,
        escrowUtxo.input.outputIndex,
        escrowUtxo.output.amount,
        scriptAddr
      )
      .spendingReferenceTxInInlineDatumPresent()
      .spendingReferenceTxInRedeemerValue(
        recipientDepositRedeemer(walletAddress, depositAmount)
      )
      .txInScript(this.scriptCbor)
      .txOut(scriptAddr, depositAmount)
      .txOutInlineDatumValue(outputDatum, 'JSON')
      .changeAddress(walletAddress)
      .txInCollateral(
        collateral.input.txHash,
        collateral.input.outputIndex,
        collateral.output.amount,
        collateral.output.address
      )
      .selectUtxosFrom(utxos)
      .complete();
    return this.mesh.txHex;
  };

  completeEscrow = async (escrowUtxo: UTxO, networkId = 0): Promise<string> => {
    const { utxos, walletAddress, collateral } =
      await this.getWalletInfoForTx();
    const scriptAddr = v2ScriptToBech32(this.scriptCbor, undefined, networkId);
    const inputDatum = parseDatumCbor<ActiveEscrowDatum>(
      escrowUtxo.output.plutusData!
    );
    const [
      initiatorAddressObj,
      initiatorAmount,
      recipientAddressObj,
      recipientAmount,
    ] = inputDatum.fields;
    const initiatorAddress = parsePlutusAddressObjToBech32(initiatorAddressObj);
    const recipientAddress = parsePlutusAddressObjToBech32(recipientAddressObj);
    const initiatorToReceive = parsePlutusValueToAssets(recipientAmount);
    const recipientToReceive = parsePlutusValueToAssets(initiatorAmount);

    await this.mesh
      .spendingPlutusScriptV2()
      .txIn(
        escrowUtxo.input.txHash,
        escrowUtxo.input.outputIndex,
        escrowUtxo.output.amount,
        scriptAddr
      )
      .spendingReferenceTxInInlineDatumPresent()
      .spendingReferenceTxInRedeemerValue(mConStr2([]))
      .txInScript(this.scriptCbor)
      .txOut(initiatorAddress, initiatorToReceive)
      .txOut(recipientAddress, recipientToReceive)
      .requiredSignerHash(serializeBech32Address(recipientAddress).pubKeyHash)
      .requiredSignerHash(serializeBech32Address(initiatorAddress).pubKeyHash)
      .changeAddress(walletAddress)
      .txInCollateral(
        collateral.input.txHash,
        collateral.input.outputIndex,
        collateral.output.amount,
        collateral.output.address
      )
      .selectUtxosFrom(utxos)
      .complete();
    return this.mesh.txHex;
  };
}