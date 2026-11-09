import { hostname } from "node:os";
import { env } from "../lib/env";
import { BrokerError, accountOfToken, linkThisComputer, pollDeviceGrant, startDeviceGrant } from "./broker";
import { connectState } from "./state";

// `creatortoolset connect`: links this computer to the account on the connect broker from a terminal. It prints a code,
// waits for the approval on the broker's site, then links and saves the tunnel. The tunnel runs while Creator Toolset
// runs here; the server starts it at boot (boot.ts).

export const DEFAULT_BROKER = "https://connect.creatortoolset.com";

export interface CliIo {
  log(line: string): void;
  err(line: string): void;
  sleep(ms: number): Promise<void>;
}

const REASONS: Record<string, string> = {
  access_denied: "The approval was declined.",
  expired_token: "The code expired. Run the command again.",
  limit_reached: "This account has reached its computer limit. Remove a computer on the account or upgrade.",
  unreachable: "Could not reach the connect service.",
};

/** Runs the command. Returns the exit code; never prints a token. */
export async function connectCli(argv: string[], io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = rest.indexOf("--broker");
  if (cmd !== "connect" || rest.length !== (flag === -1 ? 0 : 2) || (flag !== -1 && !rest[flag + 1])) {
    io.err("usage: creatortoolset connect [--broker <url>]");
    return 2;
  }
  const brokerUrl = flag === -1 ? process.env.CT_CONNECT_URL || DEFAULT_BROKER : rest[flag + 1]!;
  const linked = connectState();
  if (linked) {
    io.err(`This computer is already connected at ${linked.hostname}. Nothing was changed.`);
    return 1;
  }

  try {
    const g = await startDeviceGrant(brokerUrl);
    io.log("To connect this computer to your account, open:");
    io.log(`  ${g.verification_uri_complete ?? g.verification_uri}`);
    io.log(`and check that the code shown there is ${g.user_code}.`);
    const deadline = Date.now() + g.expires_in * 1000;
    let token = "";
    while (!token) {
      if (Date.now() > deadline) throw new BrokerError(400, "expired_token");
      await io.sleep(g.interval * 1000);
      try {
        token = await pollDeviceGrant(brokerUrl, g.device_code);
      } catch (e) {
        if (!(e instanceof BrokerError) || e.code !== "authorization_pending") throw e;
      }
    }

    const state = await linkThisComputer({
      brokerUrl,
      accessToken: token,
      owner: accountOfToken(token),
      // ticket sign-ins are for the server's admin account, the one that owns this computer
      localUser: env.adminUsername,
      name: hostname(),
      origin: `http://127.0.0.1:${process.env.PORT || "3000"}`,
    });
    io.log(`Connected as ${state.owner}. This computer is ${state.name}.`);
    io.log("Start Creator Toolset here (or restart it): the tunnel runs while it runs.");
    return 0;
  } catch (e) {
    const code = e instanceof BrokerError ? e.code : "unreachable";
    io.err(REASONS[code] ?? `Could not connect (${code}).`);
    return 1;
  }
}
