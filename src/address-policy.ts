import { createIpClassifier, type IpRule } from "@lorenzh/pulse-kit";

/** The setting that turns the policy on; it is named in every blocked reason. */
export const BLOCK_SETTING = "PULSE_PROBE_BLOCK_PRIVATE_RANGES";

type Category = "metadata" | "unspecified" | "loopback" | "link-local" | "private" | "reserved";

// The first matching rule wins, so the metadata addresses come before link-local and private.
/* eslint-disable sonarjs/no-hardcoded-ip -- deny list of private ranges, never dialed */
const RULES: readonly IpRule<Category>[] = [
  {
    category: "metadata",
    cidrs: ["169.254.169.254", "100.100.100.200", "168.63.129.16", "fd00:ec2::254"],
  },
  { category: "unspecified", cidrs: ["0.0.0.0/8", "::/128"] },
  { category: "loopback", cidrs: ["127.0.0.0/8", "::1/128"] },
  { category: "link-local", cidrs: ["169.254.0.0/16", "fe80::/10"] },
  {
    category: "private",
    cidrs: [
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "100.64.0.0/10",
      "fc00::/7",
      "fec0::/10",
    ],
  },
  { category: "reserved", cidrs: ["::/96"] },
];
/* eslint-enable sonarjs/no-hardcoded-ip */

/** The blocked category of an IP address, or `null` when checks may connect to it. */
export const blockedCategory = createIpClassifier(RULES);

/** The result reason of a blocked target. It names the category only, never a host or address. */
export function blockedReason(category: string, isRedirect: boolean): string {
  const prefix = isRedirect ? "redirect blocked" : "blocked";
  return `${prefix}: ${category} address (${BLOCK_SETTING})`;
}
