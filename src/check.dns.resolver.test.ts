import { test } from "bun:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import type { DnsRecordType } from "@lorenzh/pulse-contract";
import { type ResolveOptions, resolveRecords } from "./check-dns.ts";

type Mode = "answer" | "nxdomain" | "silent";

/** A UDP DNS server that answers every A query with 192.0.2.7, or fails as `mode` says. */
async function stub(mode: Mode): Promise<{ address: string; close: () => void }> {
  const socket = dgram.createSocket("udp4");
  socket.on("message", (msg, rinfo) => {
    if (mode === "silent") return;
    let end = 12;
    while (msg[end] !== 0 && end < msg.length) end += (msg[end] ?? 0) + 1;
    const question = msg.subarray(12, end + 5);
    const header = Buffer.from(msg.subarray(0, 12));
    header.writeUInt16BE(mode === "nxdomain" ? 0x8183 : 0x8180, 2);
    header.writeUInt16BE(mode === "nxdomain" ? 0 : 1, 6);
    const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 7]);
    socket.send(
      Buffer.concat([header, question, ...(mode === "nxdomain" ? [] : [answer])]),
      rinfo.port,
      rinfo.address,
    );
  });
  await new Promise<void>((r) => socket.bind(0, "127.0.0.1", r));
  return {
    address: `127.0.0.1:${(socket.address() as AddressInfo).port}`,
    close: () => socket.close(),
  };
}

/** Builds a response that carries one record of `type` with `rdata` for any query. */
function recordPacket(msg: Buffer, type: number, rdata: Buffer): Buffer {
  let end = 12;
  while (msg[end] !== 0 && end < msg.length) end += (msg[end] ?? 0) + 1;
  const question = msg.subarray(12, end + 5);
  const header = Buffer.from(msg.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 6);
  const head = Buffer.from([0xc0, 0x0c, 0, type, 0, 1, 0, 0, 0, 60, 0, rdata.length]);
  return Buffer.concat([header, question, head, rdata]);
}

const NAME = Buffer.from([4, 109, 97, 105, 108, 0]); // "mail."

test("resolveRecords reads CNAME, NS, MX and TXT answers", async () => {
  const rdata: Record<string, [number, Buffer]> = {
    CNAME: [5, NAME],
    NS: [2, NAME],
    MX: [15, Buffer.concat([Buffer.from([0, 10]), NAME])],
    TXT: [16, Buffer.from([2, 104, 105])],
  };
  const socket = dgram.createSocket("udp4");
  let current = "CNAME";
  socket.on("message", (msg, rinfo) => {
    const [type, data] = rdata[current] ?? [1, Buffer.alloc(4)];
    socket.send(recordPacket(msg, type, data), rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => socket.bind(0, "127.0.0.1", r));
  const address = `127.0.0.1:${(socket.address() as AddressInfo).port}`;
  try {
    const expected: Record<string, string[]> = {
      CNAME: ["mail"],
      NS: ["mail"],
      MX: ["10 mail"],
      TXT: ["hi"],
    };
    for (const type of ["CNAME", "NS", "MX", "TXT"] as const) {
      current = type;
      assert.deepEqual(await resolveRecords(options(address, type)), expected[type]);
    }
  } finally {
    socket.close();
  }
});

function options(resolver: string, recordType: DnsRecordType = "A"): ResolveOptions {
  return {
    dnsName: "example.test",
    recordType,
    resolver,
    timeoutMs: 300,
    signal: new AbortController().signal,
  };
}

test("resolveRecords asks the given resolver", async () => {
  const s = await stub("answer");
  try {
    assert.deepEqual(await resolveRecords(options(s.address)), ["192.0.2.7"]);
  } finally {
    s.close();
  }
});

test("resolveRecords rejects with ENOTFOUND on NXDOMAIN", async () => {
  const s = await stub("nxdomain");
  try {
    await assert.rejects(resolveRecords(options(s.address)), { code: "ENOTFOUND" });
  } finally {
    s.close();
  }
});

test("resolveRecords is cancelled by the abort signal", async () => {
  const s = await stub("silent");
  try {
    const ctl = new AbortController();
    const p = resolveRecords({ ...options(s.address), timeoutMs: 5000, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 30);
    await assert.rejects(p, { code: "ECANCELLED" });
  } finally {
    s.close();
  }
});

test("resolveRecords gives up after its own timeout", async () => {
  const s = await stub("silent");
  try {
    await assert.rejects(resolveRecords({ ...options(s.address), timeoutMs: 100 }), {
      code: "ETIMEOUT",
    });
  } finally {
    s.close();
  }
});
