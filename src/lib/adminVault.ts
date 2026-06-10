// Encrypted admin credential vault.
//
// The admin's AWS access key is baked into the (public) bundle ONLY as
// AES-256-GCM ciphertext whose key is derived from the admin password with
// PBKDF2-SHA256 (310k iterations). The password itself never ships (only its
// separately-salted verification hash in Auth.tsx), so the bundle alone cannot
// yield the key. On a successful admin sign-in we derive the key from the
// entered password, decrypt in memory, and hand the credentials to the admin
// data readers via sessionStorage (cleared when the tab closes).
//
// Regenerate after rotating the AWS key or changing the admin password:
//   AK=... SK=... node -e "
//     const c=require('crypto');
//     const salt=c.randomBytes(16), iv=c.randomBytes(12);
//     const key=c.pbkdf2Sync('PASSWORD', salt, 310000, 32, 'sha256');
//     const ci=c.createCipheriv('aes-256-gcm', key, iv);
//     const ct=Buffer.concat([ci.update(JSON.stringify({accessKeyId:process.env.AK,secretAccessKey:process.env.SK}),'utf8'),ci.final(),ci.getAuthTag()]);
//     console.log(JSON.stringify({salt:salt.toString('hex'),iv:iv.toString('hex'),ct:ct.toString('hex')}))"

import type { AdminCreds } from "./leadsAdmin";

const VAULT = {
  salt: "28696d5ca2dd2cfc57f494f03f1236ac",
  iv: "f1db6ef505de727aff2fc7a2",
  ct: "e7a93457ac9c6834809b31bad859cd6ec960d97ae9ba09f067553e232b729e09725e81edb2fe2bb7b0d191e0138517204e03e2a5e4c3722b7bab918028eafd92e9f3b3c9c3e7b617e88d96faf8145bcc5e313f6943e7d1da3f5551f41d1d849fa99e97436172f621f7b9480d1b333f06354625",
};

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Decrypt the baked admin AWS credentials with the (already verified) admin
 * password. Returns null if decryption fails (e.g. vault regenerated under a
 * different password).
 */
export async function unsealAdminVault(
  password: string,
): Promise<AdminCreds | null> {
  try {
    const baseKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const aesKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: hexToBytes(VAULT.salt) as BufferSource,
        iterations: 310000,
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    // WebCrypto expects the GCM auth tag appended to the ciphertext, which is
    // exactly how the vault was produced.
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: hexToBytes(VAULT.iv) as BufferSource },
      aesKey,
      hexToBytes(VAULT.ct) as BufferSource,
    );
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as AdminCreds;
    if (parsed.accessKeyId && parsed.secretAccessKey) return parsed;
  } catch {
    /* wrong password for this vault, or corrupted blob */
  }
  return null;
}
