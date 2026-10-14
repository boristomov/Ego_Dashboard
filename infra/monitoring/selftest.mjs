// node infra/monitoring/selftest.mjs
//
// Offline checks of the window maths, the station spread, token verification
// and the SigV4 signer against a known AWS test vector. With AWS credentials
// and MONITOR_BUCKET in the environment it also makes two real, read-only
// requests: a listing of _monitor/ and a presigned GET.
import crypto from "node:crypto";
import worker, { pickSpread, signGet, verifyToken, windowListings } from "./worker.js";

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}`);
  if (!ok) failed++;
};

// ---- window ----
{
  const now = new Date("2026-10-13T10:20:00Z");
  const l = windowListings(new Date(now - 15 * 60e3), now);
  check(l.length === 1 && l[0].prefix === "_monitor/2026-10-13/", "15 min inside one UTC day lists one prefix");
  check(l[0].startAfter === "_monitor/2026-10-13/100459", "starts just before the window's first second");
  const mid = new Date("2026-10-14T00:05:00Z");
  const l2 = windowListings(new Date(mid - 15 * 60e3), mid);
  check(l2.length === 2 && l2[1].prefix === "_monitor/2026-10-14/" && !l2[1].startAfter, "window across midnight lists both days");
  // A key recorded at exactly the window start must sort after startAfter.
  check("_monitor/2026-10-13/100500_3_s.json" > l[0].startAfter, "a take at the window start is included");
}

// ---- spread ----
{
  const keys = [
    "_monitor/d/100001_3_a.json", "_monitor/d/100002_3_b.json", "_monitor/d/100003_3_c.json",
    "_monitor/d/100004_3_d.json", "_monitor/d/095000_1_e.json", "_monitor/d/090000_2_f.json",
  ];
  const got = pickSpread(keys, 3);
  const stations = got.map((k) => k.split("/").pop().split("_")[1]).sort().join("");
  check(stations === "123", "one busy station does not crowd out the others");
  check(got.includes("_monitor/d/100004_3_d.json"), "each station contributes its newest take first");
  check(pickSpread(keys, 50).length === keys.length, "everything shown when it fits");
}

// ---- token ----
{
  const secret = "s3cret";
  const mint = (claims) => {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    return `${payload}.${sig}`;
  };
  const t = mint({ sub: "boris", exp: Math.floor(Date.now() / 1000) + 60 });
  check((await verifyToken(t, secret)) === "boris", "accepts a registry session token");
  check((await verifyToken(t, "other")) === null, "rejects a token signed with another secret");
  check((await verifyToken(mint({ sub: "boris", exp: 1 }), secret)) === null, "rejects an expired token");
  check((await verifyToken(t.replace(/.$/, (c) => (c === "A" ? "B" : "A")), secret)) === null, "rejects a tampered signature");
}

// ---- router ----
{
  const res = await worker.fetch(new Request("https://m.example/clips"), { SESSION_SECRET: "x" });
  check(res.status === 401, "clips require sign-in");
  const h = await (await worker.fetch(new Request("https://m.example/health"), {})).json();
  check(h.ok === false, "health reports an unconfigured Worker");
}

// ---- signer: AWS's published presigned-URL example ----
// https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
{
  const { url } = await signGet({
    bucket: "examplebucket",
    region: "us-east-1",
    host: "examplebucket.s3.amazonaws.com",
    key: "test.txt",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    presignSeconds: 86400,
    now: new Date("2013-05-24T00:00:00Z"),
  });
  check(
    url.endsWith("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"),
    "presigned URL matches the AWS documentation vector",
  );
}

// ---- live, read-only ----
if (process.env.AWS_ACCESS_KEY_ID && process.env.MONITOR_BUCKET) {
  const env = {
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_REGION: process.env.AWS_REGION || "us-west-2",
    MONITOR_BUCKET: process.env.MONITOR_BUCKET,
    SESSION_SECRET: "live-test",
  };
  const payload = Buffer.from(JSON.stringify({ sub: "selftest", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
  const token = `${payload}.${crypto.createHmac("sha256", "live-test").update(payload).digest("base64url")}`;
  const res = await worker.fetch(
    new Request("https://m.example/clips?minutes=1440&limit=5", { headers: { authorization: `Bearer ${token}` } }),
    env,
  );
  const doc = await res.json();
  check(res.status === 200, `live listing of _monitor/ (${res.status}${doc.error ? ": " + doc.error : ""}; ${doc.totalInWindow ?? "?"} in the last day)`);
  if (process.env.PRESIGN_PROBE_KEY) {
    const { url } = await signGet({
      bucket: env.MONITOR_BUCKET, region: env.AWS_REGION, key: process.env.PRESIGN_PROBE_KEY,
      accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, presignSeconds: 60,
    });
    const r = await fetch(url, { method: "GET", headers: { range: "bytes=0-15" } });
    check(r.status === 200 || r.status === 206, `live presigned GET (${r.status})`);
  }
} else {
  console.log("  skip  live checks (no AWS credentials / MONITOR_BUCKET)");
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall monitoring checks passed");
process.exit(failed ? 1 : 0);
