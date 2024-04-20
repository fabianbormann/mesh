import { MeshTxInitiator, MeshTxInitiatorInput } from '@mesh/common';
import {
  mConStr0,
  serializeBech32Address,
  applyParamsToScript,
  v2ScriptToBech32,
  unixTimeToEnclosingSlot,
  SLOT_CONFIG_NETWORK,
  ConStr0,
  Integer,
  BuiltinByteString,
  parseDatumCbor,
} from '@meshsdk/mesh-csl';
import blueprint from './aiken-workspace/plutus.json';
import { Asset, UTxO } from '@meshsdk/core';

export type VestingDatum = ConStr0<
  [Integer, BuiltinByteString, BuiltinByteString]
>;

export class MeshVestingContract extends MeshTxInitiator {
  scriptCbor = applyParamsToScript(blueprint.validators[0].compiledCode, []);

  constructor(inputs: MeshTxInitiatorInput) {
    super(inputs);
  }

  depositFund = async (
    amount: Asset[],
    lockUntilTimeStamp: number,
    beneficiary: string,
    networkId = 0
  ): Promise<string> => {
    const { utxos, walletAddress } = await this.getWalletInfoForTx();
    const scriptAddr = v2ScriptToBech32(this.scriptCbor, undefined, 0);
    const { pubKeyHash: ownerPubKeyHash } =
      serializeBech32Address(walletAddress);
    const { pubKeyHash: beneficiaryPubKeyHash } =
      serializeBech32Address(beneficiary);

    await this.mesh
      .txOut(scriptAddr, amount)
      .txOutInlineDatumValue(
        mConStr0([
          unixTimeToEnclosingSlot(
            lockUntilTimeStamp,
            networkId === 0
              ? SLOT_CONFIG_NETWORK.Preprod
              : SLOT_CONFIG_NETWORK.Mainnet
          ),
          ownerPubKeyHash,
          beneficiaryPubKeyHash,
        ])
      )
      .changeAddress(walletAddress)
      .selectUtxosFrom(utxos)
      .complete();
    return this.mesh.txHex;
  };

  withdrawFund = async (vestingUtxo: UTxO, networkId = 0): Promise<string> => {
    const { utxos, walletAddress, collateral } =
      await this.getWalletInfoForTx();
    const { input: collateralInput, output: collateralOutput } = collateral;
    const scriptAddr = v2ScriptToBech32(this.scriptCbor, undefined, 0);
    const { pubKeyHash } = serializeBech32Address(walletAddress);

    const datum = parseDatumCbor<VestingDatum>(vestingUtxo.output.plutusData!);

    const invalidBefore = Math.min(
      datum.fields[0].int + 1,
      unixTimeToEnclosingSlot(
        new Date().getTime() - 10000,
        networkId === 0
          ? SLOT_CONFIG_NETWORK.Preprod
          : SLOT_CONFIG_NETWORK.Mainnet
      )
    );

    await this.mesh
      .spendingPlutusScriptV2()
      .txIn(
        vestingUtxo.input.txHash,
        vestingUtxo.input.outputIndex,
        vestingUtxo.output.amount,
        scriptAddr
      )
      .spendingReferenceTxInInlineDatumPresent()
      .spendingReferenceTxInRedeemerValue('')
      .txInScript(this.scriptCbor)
      .txOut(walletAddress, [])
      .txInCollateral(
        collateralInput.txHash,
        collateralInput.outputIndex,
        collateralOutput.amount,
        collateralOutput.address
      )
      .invalidBefore(invalidBefore)
      .requiredSignerHash(pubKeyHash)
      .changeAddress(walletAddress)
      .selectUtxosFrom(utxos)
      .complete();
    return this.mesh.txHex;
  };
}