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

// Holds the `ego-registry-reader` IAM key: dynamodb:Scan on ego-users and
// ego-leads ONLY — even a hypothetical offline crack of the vault yields no
// access to S3 data or any write/delete capability.
// One copy per admin, each sealed with that admin's own password.
const VAULTS: Record<string, { salt: string; iv: string; ct: string }> = {
  "aws@aithoth.com": {
    salt: "3a6c9a83aa365448afaedc5f50525b4e",
    iv: "f1e3ab47d67b3bbe1de00038",
    ct: "38793d1dc18fcfe296799923b67bd202bc1d7e81deded5f72c855554758a7ad5f087771d61d269a6b1d713d7ef6cf44d2f15eac0afc6b7ab55cc5031c0c622b52d12b44f7a9bb60038a40382c1f185994d2d4189fa39e119b39f74ca8613cd507c1d757388f54fb9eeea0ca54d4c4ab5a0f6a3",
  },
  "jimmy@aithoth.com": {
    salt: "f3e01dcc9db93ed95be8c415db4bd40a",
    iv: "7effad6eb920da48111255e1",
    ct: "66bad3a51720147312bf0630119cc78877987b911e11f3cb172f04ee73b87e1147db80ecf26cf2b0880099b2359ef4885c3fecc635231b75a8bed759bb0020725e86d20ad8c6ddc89e718da92135e85ee6e844cd9243792fdd7b8d6a8bf0e65268a7590f470c6ba8d26d92018fcd5cb0a2f2b7",
  },
  "jay@aithoth.com": {
    salt: "36b39fa421b35dd1331ec385ab578a29",
    iv: "6e3c225f6246070d822ad89d",
    ct: "8fb035a9a95386aa8450acf004859ea5a0fd95127aa24904f34de825ae0b1dd7cf2c40f365f5b25b280273e6f56b61cf0d6e73e487d22f8c2bcb824780188fed9c34a11af2bde8d37d274d9e96916fe474de54774e9e209dbb41e0c68ca97dfa43226fde16d0bdd76680de9bef2075df3be36c",
  },
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
  email: string,
  password: string,
): Promise<AdminCreds | null> {
  const VAULT = VAULTS[email.toLowerCase()];
  if (!VAULT) return null;
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
