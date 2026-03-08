import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import type { MsgContext } from "./templating.js";

describe("resolveCommandAuthorization Repro", () => {
  const baseCfg: OpenClawConfig = {
    commands: {
      ownerAllowFrom: [], // No ownerAllowFrom configured
    },
  } as unknown as OpenClawConfig;

  it("should recognize sender as owner if SenderIsOwner flag is present in context, even if ownerAllowFrom is empty", () => {
    const ctx: MsgContext = {
      SenderId: "some-user",
      SenderIsOwner: true, // Injected by gateway
    };

    const auth = resolveCommandAuthorization({
      ctx,
      cfg: baseCfg,
      commandAuthorized: true,
    });

    // Expected: If gateway identified the sender as owner, core logic should respect it
    expect(auth.senderIsOwner).toBe(true);
  });

  it("should recognize sender as owner if GatewayClientScopes contains admin, even if ownerAllowFrom is empty", () => {
    const ctx: MsgContext = {
      SenderId: "some-user",
      GatewayClientScopes: ["operator.admin"],
    };

    const auth = resolveCommandAuthorization({
      ctx,
      cfg: baseCfg,
      commandAuthorized: true,
    });

    // Expected: Ownership determined by client scopes
    expect(auth.senderIsOwner).toBe(true);
  });

  it("should recognize sender as owner if ownerAllowFrom is wildcard (*)", () => {
    const ctx: MsgContext = {
      SenderId: "some-user",
    };
    const wildcardCfg: OpenClawConfig = {
      commands: {
        ownerAllowFrom: ["*"],
      },
    } as unknown as OpenClawConfig;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg: wildcardCfg,
      commandAuthorized: true,
    });

    // Expected: Wildcard should allow everyone
    expect(auth.senderIsOwner).toBe(true);
  });
});
