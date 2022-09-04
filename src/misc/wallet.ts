import {
  Address,
  C,
  Core,
  fromHex,
  getAddressDetails,
  KeyHash,
  M,
  Network,
  Payload,
  PrivateKey,
  RewardAddress,
  toHex,
  UTxO,
} from "../mod.ts";
import { mnemonicToEntropy } from "./bip39.ts";

export const walletFromSeed = (
  seed: string,
  options?: {
    addressType?: "Base" | "Enterprise";
    accountIndex?: number;
    network?: Network;
  },
): {
  address: Address;
  rewardAddress: RewardAddress | null;
  paymentKey: PrivateKey;
  stakeKey: PrivateKey | null;
} => {
  options = {
    addressType: options?.addressType || "Base",
    accountIndex: options?.accountIndex ?? 0,
    network: options?.network || "Mainnet",
  };

  const harden = (num: number) => {
    if (typeof num !== "number") throw new Error("Type number required here!");
    return 0x80000000 + num;
  };

  const entropy = mnemonicToEntropy(seed);
  const rootKey = C.Bip32PrivateKey.from_bip39_entropy(
    fromHex(entropy),
    new Uint8Array(),
  );

  const accountKey = rootKey.derive(harden(1852))
    .derive(harden(1815))
    .derive(harden(options.accountIndex!));

  const paymentKey = accountKey.derive(0).derive(0).to_raw_key();
  const stakeKey = accountKey.derive(2).derive(0).to_raw_key();

  const paymentKeyHash = paymentKey.to_public().hash();
  const stakeKeyHash = stakeKey.to_public().hash();

  const networkId = options.network === "Mainnet" ? 1 : 0;

  const address = options.addressType === "Base"
    ? C.BaseAddress.new(
      networkId,
      C.StakeCredential.from_keyhash(paymentKeyHash),
      C.StakeCredential.from_keyhash(stakeKeyHash),
    ).to_address().to_bech32(undefined)
    : C.EnterpriseAddress.new(
      networkId,
      C.StakeCredential.from_keyhash(paymentKeyHash),
    ).to_address().to_bech32(undefined);

  const rewardAddress = options.addressType === "Base"
    ? C.RewardAddress.new(
      networkId,
      C.StakeCredential.from_keyhash(stakeKeyHash),
    ).to_address().to_bech32(undefined)
    : null;

  return {
    address,
    rewardAddress,
    paymentKey: paymentKey.to_bech32(),
    stakeKey: options.addressType === "Base" ? stakeKey.to_bech32() : null,
  };
};

export const discoverOwnUsedTxKeyHashes = (
  tx: Core.Transaction,
  ownKeyHashes: Array<KeyHash>,
  ownUtxos: Array<UTxO>,
): Array<KeyHash> => {
  const usedKeyHashes = [];

  //key hashes from inputs
  const inputs = tx.body().inputs();
  for (let i = 0; i < inputs.len(); i++) {
    const input = inputs.get(i);
    const txHash = toHex(input.transaction_id().to_bytes());
    const outputIndex = parseInt(input.index().to_str());
    const utxo = ownUtxos.find(
      (utxo) => utxo.txHash === txHash && utxo.outputIndex === outputIndex,
    );
    if (
      utxo
    ) {
      const { paymentCredential } = getAddressDetails(utxo.address);
      usedKeyHashes.push(paymentCredential?.hash!);
    }
  }

  const txBody = tx.body();

  //key hashes from certificates
  const keyHashFromCert = (txBody: Core.TransactionBody) => {
    const certs = txBody.certs();
    if (!certs) return;
    for (let i = 0; i < certs.len(); i++) {
      const cert = certs.get(i);
      if (cert.kind() === 0) {
        const credential = cert.as_stake_registration()?.stake_credential();
        if (credential?.kind() === 0) {
          const keyHash = toHex(
            credential.to_keyhash()!.to_bytes(),
          );
          usedKeyHashes.push(keyHash);
        }
      } else if (cert.kind() === 1) {
        const credential = cert.as_stake_deregistration()?.stake_credential();
        if (credential?.kind() === 0) {
          const keyHash = toHex(
            credential.to_keyhash()!.to_bytes(),
          );
          usedKeyHashes.push(keyHash);
        }
      } else if (cert.kind() === 2) {
        const credential = cert.as_stake_delegation()?.stake_credential();
        if (credential?.kind() === 0) {
          const keyHash = toHex(
            credential.to_keyhash()!.to_bytes(),
          );
          usedKeyHashes.push(keyHash);
        }
      } else if (cert.kind() === 3) {
        const owners = cert
          .as_pool_registration()
          ?.pool_params()
          .pool_owners();
        if (!owners) break;
        for (let i = 0; i < owners.len(); i++) {
          const keyHash = toHex(owners.get(i).to_bytes());
          usedKeyHashes.push(keyHash);
        }
      } else if (cert.kind() === 6) {
        const instantRewards = cert
          .as_move_instantaneous_rewards_cert()
          ?.move_instantaneous_reward().as_to_stake_creds()
          ?.keys();
        if (!instantRewards) break;
        for (let i = 0; i < instantRewards.len(); i++) {
          const credential = instantRewards.get(i);

          if (credential.kind() === 0) {
            const keyHash = toHex(
              credential.to_keyhash()!.to_bytes(),
            );
            usedKeyHashes.push(keyHash);
          }
        }
      }
    }
  };
  if (txBody.certs()) keyHashFromCert(txBody);

  //key hashes from scripts
  const scripts = tx.witness_set().native_scripts();
  const keyHashFromScript = (scripts: Core.NativeScripts) => {
    for (let i = 0; i < scripts.len(); i++) {
      const script = scripts.get(i);
      if (script.kind() === 0) {
        const keyHash = toHex(
          script.as_script_pubkey()!.addr_keyhash().to_bytes(),
        );
        usedKeyHashes.push(keyHash);
      }
      if (script.kind() === 1) {
        keyHashFromScript(script.as_script_all()!.native_scripts());
        return;
      }
      if (script.kind() === 2) {
        keyHashFromScript(script.as_script_any()!.native_scripts());
        return;
      }
      if (script.kind() === 3) {
        keyHashFromScript(script.as_script_n_of_k()!.native_scripts());
        return;
      }
    }
  };
  if (scripts) keyHashFromScript(scripts);

  //keyHashes from required signers
  const requiredSigners = txBody.required_signers();
  if (requiredSigners) {
    for (let i = 0; i < requiredSigners.len(); i++) {
      usedKeyHashes.push(
        toHex(requiredSigners.get(i).to_bytes()),
      );
    }
  }

  //keyHashes from collateral
  const collateral = txBody.collateral();
  if (collateral) {
    for (let i = 0; i < collateral.len(); i++) {
      const input = collateral.get(i);
      const txHash = toHex(input.transaction_id().to_bytes());
      const outputIndex = parseInt(input.index().to_str());
      const utxo = ownUtxos.find(
        (utxo) => utxo.txHash === txHash && utxo.outputIndex === outputIndex,
      );
      if (
        utxo
      ) {
        const { paymentCredential } = getAddressDetails(utxo.address);
        usedKeyHashes.push(paymentCredential?.hash!);
      }
    }
  }

  return usedKeyHashes.filter((k) => ownKeyHashes.includes(k));
};

export const signData = (
  addressHex: string,
  payload: Payload,
  privateKey: PrivateKey,
): { signature: string; key: string } => {
  const protectedHeaders = M.HeaderMap.new();
  protectedHeaders.set_algorithm_id(
    M.Label.from_algorithm_id(
      M.AlgorithmId.EdDSA,
    ),
  );
  protectedHeaders.set_header(
    M.Label.new_text("address"),
    M.CBORValue.new_bytes(fromHex(addressHex)),
  );
  const protectedSerialized = M.ProtectedHeaderMap.new(
    protectedHeaders,
  );
  const unprotectedHeaders = M.HeaderMap.new();
  const headers = M.Headers.new(
    protectedSerialized,
    unprotectedHeaders,
  );
  const builder = M.COSESign1Builder.new(
    headers,
    fromHex(payload),
    false,
  );
  const toSign = builder.make_data_to_sign().to_bytes();

  const priv = C.PrivateKey.from_bech32(privateKey);

  const signedSigStruc = priv.sign(toSign).to_bytes();
  const coseSign1 = builder.build(signedSigStruc);

  const key = M.COSEKey.new(
    M.Label.from_key_type(M.KeyType.OKP),
  );
  key.set_algorithm_id(
    M.Label.from_algorithm_id(
      M.AlgorithmId.EdDSA,
    ),
  );
  key.set_header(
    M.Label.new_int(
      M.Int.new_negative(
        M.BigNum.from_str("1"),
      ),
    ),
    M.CBORValue.new_int(
      M.Int.new_i32(6), //Loader.Message.CurveType.Ed25519
    ),
  ); // crv (-1) set to Ed25519 (6)
  key.set_header(
    M.Label.new_int(
      M.Int.new_negative(
        M.BigNum.from_str("2"),
      ),
    ),
    M.CBORValue.new_bytes(priv.to_public().as_bytes()),
  ); // x (-2) set to public key

  return {
    signature: toHex(coseSign1.to_bytes()),
    key: toHex(key.to_bytes()),
  };
};