// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP3009} from "./EIP3009.sol";

/// @title MockStablecoin — a named 6dp EIP-3009 stand-in for a fiat stablecoin
///         that does not exist on this testnet
/// @notice Same argument as `MockXSGD`, generalised to the PAYER side: a payer can
///         only sign an EIP-3009 authorization against a token that implements it,
///         and most fiat stablecoins either are not deployed to Base Sepolia at all
///         or do not carry EIP-3009. Where that is true, a labelled mock is the
///         honest option and the only one that demonstrates the settlement path.
///
///         Name and symbol are constructor arguments; `version()` stays `pure "1"`
///         so this needs no change to `EIP3009` — which matters, because that base
///         is shared with the already-deployed, Basescan-verified `MockXSGD`, and
///         editing it would leave that contract's published source no longer
///         reproducing its on-chain bytecode.
///
///         WHAT THIS IS NOT. It is not evidence that the real-world token of the
///         same name would work here:
///          - **EURC needs no mock.** Circle's EURC is live on Base Sepolia at
///            `0x8084...359F` with 6 decimals and a `TRANSFER_WITH_AUTHORIZATION_TYPEHASH`
///            byte-identical to USDC's. Prefer the real token; mocking it would be
///            a downgrade with nothing gained.
///          - **USDT is a different case, and the gap is real.** Tether's token is
///            not a FiatToken and implements no `transferWithAuthorization` at all.
///            A `MockStablecoin("Mock USDT", ...)` proves multi-token settlement and
///            proves nothing about real USDT, which could only pay through this
///            contract via a different door (permit, or approve + transferFrom).
///            Say so wherever such a mock is shown.
///
///         Open `mint()`, like `MockXSGD` — so this must never be listed as a
///         PAYABLE token on a deployment whose settlement asset it can reach for
///         free. `FixedRateSwap.rateOf` is what admits a token, and it is
///         `onlyOwner`.
contract MockStablecoin is EIP3009 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /// @dev 6, matching every other unit in this system. `FixedRateSwap` scales by a
    ///      literal 1e6 and the whole TypeScript quote path hardcodes the same, so a
    ///      token of any other precision is unusable without redeploying the swap.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function version() public pure override returns (string memory) {
        return "1";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
