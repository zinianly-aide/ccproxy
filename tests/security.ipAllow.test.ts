import assert from "node:assert/strict";
import { test } from "node:test";
import { isIpAllowed } from "../packages/shared/src/security/ipAllow";

const DEFAULT_CIDRS = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.1/32"
];

test("allows private ranges", () => {
  assert.equal(isIpAllowed("192.168.1.10", DEFAULT_CIDRS), true);
  assert.equal(isIpAllowed("10.0.5.6", DEFAULT_CIDRS), true);
  assert.equal(isIpAllowed("127.0.0.1", DEFAULT_CIDRS), true);
});

test("rejects public ranges", () => {
  assert.equal(isIpAllowed("8.8.8.8", DEFAULT_CIDRS), false);
});
